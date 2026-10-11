import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { sanitizeSegment } from './organize.js';
import { assertInsideMusicDir, assertInsideDropoffDir, assertReadableInsideMusicDir } from '../lib/paths.js';
import { noteWrite } from '../lib/recentWrites.js';
import { withFileLock } from '../lib/fileLock.js';
import { BadRequestError } from '../lib/httpErrors.js';

function m3uPathFor(name) {
  return path.join(config.ingest.musicDir, `${sanitizeSegment(name)}.m3u`);
}

// Reports an existing m3u (possibly hand-written) so the user confirms the overwrite.
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

// Relative paths, so the playlist survives a different mount point.
export async function writeM3u({ name, items }) {
  const target = m3uPathFor(name);
  assertInsideMusicDir(target);

  const lines = ['#EXTM3U'];
  let written = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item.track) {
      // Gaps kept as comments; players ignore '#' lines.
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

  // Keeps the MUSIC_DIR watcher from triggering a full rescan; the rename fires for both names.
  noteWrite(temp);
  noteWrite(target);

  return { path: target, written, skipped };
}

function dropoffDirFor(name) {
  const segment = sanitizeSegment(name);
  return path.join(config.playlist.dropoffDir ?? '', segment);
}

// Bytes a wipe would free. Top-level files only: undercounting keeps the space check strict.
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

// What is already at the drop-off destination, so the caller can confirm.
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

// Pad to the track count's width so devices sort by filename correctly.
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

// Pre-wipe check: the source must be readable (a dropped mount still has index
// rows), and size falls back to stat when size_bytes is NULL.
async function checkedBytes(track) {
  const real = await assertReadableInsideMusicDir(track.path);
  await fs.access(real, fs.constants.R_OK);
  if (track.sizeBytes != null) return track.sizeBytes;
  const stat = await fs.stat(real);
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

// Wipe-and-rewrite DROPOFF_DIR/<name>/ after the user confirms. Every refusal
// happens before fs.rm, so a rejected export leaves the previous one intact.
export async function exportToDropoff({ name, items, onProgress, signal }) {
  const dir = await assertInsideDropoffDir(dropoffDirFor(name));
  const playable = items.filter((i) => i.track);
  const skipped = items.length - playable.length;

  // Don't replace the last export with an empty folder.
  if (!playable.length) {
    throw new BadRequestError(
      'Nothing to export: no track in this playlist resolves to a file on disk'
    );
  }

  return withFileLock(`dropoff:${dir}`, async () => {
    // Space check before the wipe, crediting what the wipe will free.
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
      // Re-resolve at copy time (symlink swap since pre-flight).
      await fs.copyFile(await assertReadableInsideMusicDir(item.track.path), dest);
      copied += 1;
      bytes += sizes[i];
      onProgress?.({ index: i + 1, total: playable.length, title: item.track.title, bytes });
    }

    return { dir, copied, skipped, bytes };
  });
}
