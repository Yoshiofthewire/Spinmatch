import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { assertInsideMusicDir } from '../lib/paths.js';
import { withSuffix, MAX_COLLISION_SUFFIX, moveOnto } from '../lib/moveFile.js';

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

// Claims `destPath` for `srcPath`, or reports that an identical file is already
// there. Returns the path actually claimed (an empty file now exists at it), or
// null for the duplicate case.
//
// The claim is what makes this safe; lib/moveFile.js explains the race it
// closes. What is specific to ingest is the branch below: a colliding file with
// identical bytes is a re-ingest of something the library already has, so the
// source is left alone for review rather than filed a second time.
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

  await moveOnto(srcPath, dest);

  return { movedTo: dest, duplicate: false };
}
