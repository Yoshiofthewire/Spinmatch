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

/** What is already at the drop-off destination, so the caller can confirm. */
export async function inspectDropoff(name) {
  const dir = await assertInsideDropoffDir(dropoffDirFor(name));
  try {
    const [entries, stat] = await Promise.all([fs.readdir(dir), fs.stat(dir)]);
    return { exists: true, dir, fileCount: entries.length, exportedAt: stat.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, dir, fileCount: 0, exportedAt: null };
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

/**
 * Copy the playlist's resolved tracks into DROPOFF_DIR/<name>/.
 *
 * Wipe-and-rewrite rather than a sync: the destructive step happens only after
 * the caller has seen inspectDropoff's count and asked for it, and "delete the
 * folder, write it fresh" is a few lines that are easy to get right where a
 * diff-and-renumber has to reason about which files it owns.
 */
export async function exportToDropoff({ name, items, onProgress, signal }) {
  const dir = await assertInsideDropoffDir(dropoffDirFor(name));
  const playable = items.filter((i) => i.track);
  const skipped = items.length - playable.length;
  const totalBytes = playable.reduce((sum, i) => sum + (i.track.sizeBytes ?? 0), 0);

  return withFileLock(`dropoff:${dir}`, async () => {
    // Fail before copying rather than halfway through filling a device.
    const available = await freeBytes(config.playlist.dropoffDir);
    if (totalBytes > available) {
      throw new BadRequestError(
        `Not enough room: the playlist needs ${totalBytes} bytes and ${available} are free`
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
      bytes += item.track.sizeBytes ?? 0;
      onProgress?.({ index: i + 1, total: playable.length, title: item.track.title, bytes });
    }

    return { dir, copied, skipped, bytes };
  });
}
