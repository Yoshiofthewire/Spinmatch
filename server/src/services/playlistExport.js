import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { sanitizeSegment } from './organize.js';
import { assertInsideMusicDir, assertInsideDropoffDir } from '../lib/paths.js';
import { noteWrite } from '../lib/recentWrites.js';
import { withFileLock } from '../lib/fileLock.js';
import { BadRequestError } from '../lib/httpErrors.js';

// Writing a playlist out: an m3u at the music root, or a folder of copies bound
// for an MP3 player.

function m3uPathFor(name) {
  return path.join(config.ingest.musicDir, `${sanitizeSegment(name)}.m3u`);
}

/**
 * What is already at the m3u destination, so the caller can confirm.
 *
 * The same collision the drop-off folder has, one directory up and with less to
 * go on: two playlist names sanitize to one filename, and MUSIC_DIR/Road
 * Trip.m3u may just as easily be a file written by hand years ago that
 * Spinmatch has never heard of. Nothing records who wrote it, so the honest
 * answer is to report the file and let the person decide, rather than to
 * overwrite it silently the way this used to.
 */
export async function inspectM3u(name) {
  const target = m3uPathFor(name);
  assertInsideMusicDir(target);
  try {
    const stat = await fs.stat(target);
    return { exists: true, path: target, bytes: stat.size, writtenAt: stat.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, path: target, bytes: 0, writtenAt: null };
    throw err;
  }
}

/**
 * Extended M3U at MUSIC_DIR/<name>.m3u.
 *
 * Paths are relative to the music root: the file sits at that root, and a
 * relative path is what survives the playlist being read on another machine or
 * under a different mount point.
 */
export async function writeM3u({ name, items }) {
  const target = m3uPathFor(name);
  assertInsideMusicDir(target);

  const lines = ['#EXTM3U'];
  let written = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item.track) {
      // A gap can't be a path. Written as a comment so the file stays a complete
      // record of the playlist instead of a silently shortened one — players
      // ignore '#' lines.
      lines.push(`# missing: ${item.artist ? `${item.artist} - ` : ''}${item.title}`);
      skipped += 1;
      continue;
    }
    const seconds = Math.round((item.track.durationMs ?? 0) / 1000);
    const label = `${item.track.artist ?? 'Unknown'} - ${item.track.title}`;
    const relative = path.relative(config.ingest.musicDir, item.track.path).split(path.sep).join('/');
    lines.push(`#EXTINF:${seconds},${label}`);
    lines.push(relative);
    written += 1;
  }

  // Temp-then-rename, so a half-written playlist never exists at the real path.
  const temp = `${target}.partial`;
  await fs.writeFile(temp, `${lines.join('\n')}\n`, 'utf8');
  await fs.rename(temp, target);

  // Without this the MUSIC_DIR watcher sees a new file at the root and debounces
  // into a full scanLibrary() — librarySync.js does not filter by extension, so
  // every export would rescan the whole collection. Both names are noted because
  // the rename fires an event for each.
  noteWrite(temp);
  noteWrite(target);

  return { path: target, written, skipped };
}

function dropoffDirFor(name) {
  const segment = sanitizeSegment(name);
  return path.join(config.playlist.dropoffDir ?? '', segment);
}

// How much a wipe of this folder would hand back. Top-level regular files only:
// an export writes a flat folder, so that is everything it put there, and
// anything nested came from somewhere else. Counting less than fs.rm actually
// frees only ever makes the free-space check stricter, which is the safe
// direction to be wrong in. A file that vanishes between the readdir and the
// stat counts as zero for the same reason.
async function dirBytes(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  const sizes = await Promise.all(entries.filter((e) => e.isFile()).map(async (e) => {
    try {
      return (await fs.stat(path.join(dir, e.name))).size;
    } catch {
      return 0;
    }
  }));
  return sizes.reduce((sum, n) => sum + n, 0);
}

/** What is already at the drop-off destination, so the caller can confirm. */
export async function inspectDropoff(name) {
  const dir = await assertInsideDropoffDir(dropoffDirFor(name));
  try {
    const [entries, stat, bytes] = await Promise.all([fs.readdir(dir), fs.stat(dir), dirBytes(dir)]);
    return { exists: true, dir, fileCount: entries.length, bytes, exportedAt: stat.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, dir, fileCount: 0, bytes: 0, exportedAt: null };
    throw err;
  }
}

// Zero-padded to the width of the track count, not to two digits. A 100-track
// playlist padded to two sorts as 1, 10, 100, 11 on a device that orders by
// filename — which defeats the entire purpose of numbering it.
function fileNameFor(item, index, total) {
  const width = String(total).length;
  const position = String(index).padStart(width, '0');
  const artist = sanitizeSegment(item.track.artist ?? 'Unknown');
  const title = sanitizeSegment(item.track.title);
  return `${position} - ${artist} - ${title}${item.track.ext ?? path.extname(item.track.path)}`;
}

async function freeBytes(dir) {
  const stat = await fs.statfs(dir);
  return stat.bavail * stat.bsize;
}

// One pass over the sources, doing two jobs that both have to happen before
// anything is deleted.
//
// Readability. fs.access is what stands between a dropped NAS mount and an
// export that deletes the previous one and copies nothing back. The index keeps
// resolving every row when the volume goes away — size_bytes is a column, not a
// stat — so a pre-flight that trusted that column touched no source file at
// all: the wipe ran, and the first fs.copyFile threw ENOENT onto a folder that
// had already been emptied. One access per track, in parallel, is cheap next to
// the copies that follow.
//
// Size. The column isn't always populated (older scans, rows written before it
// existed) — `sizeBytes ?? 0` silently turned a playlist of all-NULL sizes into
// a "0 bytes needed" check that always passed, defeating the free-space guard
// entirely. The fs.stat fallback keeps the total accurate instead of
// optimistic, and only costs a second syscall on the rows that need it. Where
// the column is populated it is preferred, so the number checked here is the
// same one the playlist list and the size budget were computed from.
async function checkedBytes(track) {
  await fs.access(track.path, fs.constants.R_OK);
  if (track.sizeBytes != null) return track.sizeBytes;
  const stat = await fs.stat(track.path);
  return stat.size;
}

async function bytesFor(playable) {
  try {
    return await Promise.all(playable.map((item) => checkedBytes(item.track)));
  } catch (err) {
    // The path is logged, not returned — error messages reach the browser.
    console.warn(`playlistExport: source is not readable: ${err.path ?? '(unknown)'}`);
    throw new BadRequestError(
      'A track in this playlist is no longer readable, so nothing was copied or deleted. '
      + 'Check that the music folder is mounted, then rescan the library.'
    );
  }
}

/**
 * Copy the playlist's resolved tracks into DROPOFF_DIR/<name>/.
 *
 * Wipe-and-rewrite rather than a sync: the destructive step happens only after
 * the caller has seen inspectDropoff's count and asked for it, and "delete the
 * folder, write it fresh" is a few lines that are easy to get right where a
 * diff-and-renumber has to reason about which files it owns.
 *
 * Everything that can refuse the export refuses it before fs.rm runs: an
 * all-gap playlist, a source that isn't readable, and a total that doesn't fit.
 * A rejected export leaves the previous one exactly as it was.
 */
export async function exportToDropoff({ name, items, onProgress, signal }) {
  const dir = await assertInsideDropoffDir(dropoffDirFor(name));
  const playable = items.filter((i) => i.track);
  const skipped = items.length - playable.length;

  // A playlist with nothing behind it would otherwise delete the last export
  // and leave an empty folder in its place — the worst possible reading of
  // "replace". Refused instead: no resolvable track is a statement about the
  // library, not an instruction about the device.
  if (!playable.length) {
    throw new BadRequestError(
      'Nothing to export: no track in this playlist resolves to a file on disk'
    );
  }

  return withFileLock(`dropoff:${dir}`, async () => {
    // Fail before copying — and before the existing folder is touched at
    // all — rather than halfway through filling a device. sizes is computed
    // once and reused below, so a track with no size_bytes only costs one
    // fs.stat rather than one here and another during the copy loop.
    //
    // reclaimable is what the wipe below is about to hand back. Without it the
    // most ordinary case there is — re-exporting an unchanged playlist onto a
    // device sized for exactly that playlist — fails with "Not enough room",
    // because `available` is measured while the previous copy still occupies
    // the space. The check still runs before the delete; only the arithmetic
    // knows about it.
    const [sizes, available, reclaimable] = await Promise.all([
      bytesFor(playable),
      freeBytes(config.playlist.dropoffDir),
      dirBytes(dir),
    ]);
    const totalBytes = sizes.reduce((sum, n) => sum + n, 0);
    const room = available + reclaimable;
    if (totalBytes > room) {
      throw new BadRequestError(
        `Not enough room: the playlist needs ${totalBytes} bytes and ${room} are free`
        + (reclaimable ? ` (including ${reclaimable} reclaimed by replacing the existing folder)` : '')
      );
    }

    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });

    let copied = 0;
    let bytes = 0;
    for (const [i, item] of playable.entries()) {
      if (signal?.aborted) break;
      const dest = path.join(dir, fileNameFor(item, i + 1, playable.length));
      await assertInsideDropoffDir(dest);
      await fs.copyFile(item.track.path, dest);
      copied += 1;
      bytes += sizes[i];
      onProgress?.({ index: i + 1, total: playable.length, title: item.track.title, bytes });
    }

    return { dir, copied, skipped, bytes };
  });
}
