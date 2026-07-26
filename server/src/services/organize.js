import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { assertInsideMusicDir } from '../lib/paths.js';

const UNSAFE_CHARS = /[/\\:*?"<>|\x00-\x1f]/g;
const MAX_SEGMENT_LENGTH = 200;

export function sanitizeSegment(name) {
  const cleaned = String(name || '')
    .replace(UNSAFE_CHARS, '')
    .replace(/\.+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, MAX_SEGMENT_LENGTH) || 'Unknown';
}

// Builds MUSIC_DIR/<Artist>/<Album>/[<disc>-]<NN - >Title.ext.
// - trackNumber, when present, is zero-padded to 2 digits.
// - discNumber is set by the caller ONLY for multi-disc releases, so every
//   track of such a release (disc 1 included) gets a "<disc>-" prefix and
//   single-disc releases stay clean. This keeps same-position tracks on
//   different discs from colliding.
export function targetPathFor(meta, ext) {
  const artist = sanitizeSegment(meta.artist);
  const album = sanitizeSegment(meta.album);
  const title = sanitizeSegment(meta.title);
  const normExt = String(ext || '').toLowerCase();

  let filename = `${title}${normExt}`;
  if (meta.trackNumber != null) {
    const track = String(meta.trackNumber).padStart(2, '0');
    const discPrefix = meta.discNumber != null ? `${meta.discNumber}-` : '';
    filename = `${discPrefix}${track} - ${title}${normExt}`;
  }
  return path.join(config.ingest.musicDir, artist, album, filename);
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

// Cheap size check first, then a streaming hash of each side so we never hold a
// whole (potentially 100MB+ lossless) file in memory just to detect a duplicate.
async function filesAreIdentical(a, b) {
  const [statA, statB] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (statA.size !== statB.size) return false;
  const [hashA, hashB] = await Promise.all([sha256(a), sha256(b)]);
  return hashA === hashB;
}

function withSuffix(destPath, n) {
  const ext = path.extname(destPath);
  const base = destPath.slice(0, ext.length ? -ext.length : undefined);
  return `${base} (${n})${ext}`;
}

// How many " (n)" suffixes to try before giving up. Bounded because the loop
// that finds a free name is otherwise unbounded, and a directory that somehow
// contains thousands of collisions is a fault to report, not to grind through.
const MAX_COLLISION_SUFFIX = 999;

// Claims `destPath` for `srcPath`, or reports that an identical file is already
// there. Returns the path actually claimed (an empty file now exists at it), or
// null for the duplicate case.
//
// The claim is what makes this safe. It used to test `fileExists(dest)` and then
// `rename(src, dest)` two awaits later — and rename() overwrites silently, so
// anything that appeared at that path in the gap (a concurrent ingest of the
// same album from a second drop folder, a file manager, a sync client) was
// destroyed with no error. `wx` fails if the path exists, which turns the race
// into an EEXIST we retry rather than a deleted track.
async function claimDestination(srcPath, destPath) {
  for (let n = 1; n <= MAX_COLLISION_SUFFIX; n += 1) {
    const candidate = n === 1 ? destPath : withSuffix(destPath, n);
    let handle;
    try {
      handle = await fs.open(candidate, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Something is already there. If it's byte-identical to what we're
      // holding, this is a re-ingest of a file the library already has and the
      // source is left alone; otherwise try the next suffix.
      if (await filesAreIdentical(srcPath, candidate)) return null;
      continue;
    }
    await handle.close();
    return candidate;
  }
  throw new Error(`could not find a free filename for ${path.basename(destPath)} after ${MAX_COLLISION_SUFFIX} attempts`);
}

export async function moveIntoLibrary(srcPath, meta, ext) {
  const initialDest = targetPathFor(meta, ext);
  // Defense-in-depth: sanitizeSegment already strips path separators and
  // neutralizes "."/".." segments, so this should never actually fire through
  // the normal API — but it's a cheap, correct guard against any future change
  // to sanitization logic letting a MusicBrainz-sourced value escape MUSIC_DIR.
  assertInsideMusicDir(initialDest);

  // The directory has to exist before the destination can be claimed.
  await fs.mkdir(path.dirname(initialDest), { recursive: true });

  const dest = await claimDestination(srcPath, initialDest);
  if (dest === null) {
    return { movedTo: null, duplicate: true };
  }

  try {
    // rename() over our own zero-byte placeholder, which is exactly what we want
    // it to replace — and nothing else can have taken the name in the meantime,
    // because we are holding it.
    await fs.rename(srcPath, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') {
      // Don't leave the placeholder behind as a 0-byte "track" for the scanner
      // to index (it has an audio extension, so it would be indexed).
      await fs.unlink(dest).catch(() => {});
      throw err;
    }
    // Cross-device: copy through a temp name in the destination directory, then
    // rename over the placeholder. The temp file is cleaned up on failure —
    // previously a copy that died part-way (a full disk, which is the common
    // cause of a cross-device copy failing) left a `.partial` file behind
    // forever, invisible to the scanner and accumulating on every retry.
    const partial = `${dest}.partial`;
    try {
      await fs.copyFile(srcPath, partial);
      await fs.rename(partial, dest);
      await fs.unlink(srcPath);
    } catch (copyErr) {
      await fs.unlink(partial).catch(() => {});
      await fs.unlink(dest).catch(() => {});
      throw copyErr;
    }
  }

  return { movedTo: dest, duplicate: false };
}
