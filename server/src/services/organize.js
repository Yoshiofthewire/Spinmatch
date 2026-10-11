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

// MUSIC_DIR/<Artist>/<Album>/[<disc>-]<NN - >Title.ext. Callers set discNumber
// only for multi-disc releases, so single-disc names stay clean.
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

// Size first, then streaming hashes: never buffer a whole lossless file.
async function filesAreIdentical(a, b) {
  const [statA, statB] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (statA.size !== statB.size) return false;
  const [hashA, hashB] = await Promise.all([sha256(a), sha256(b)]);
  return hashA === hashB;
}

// Claims a free path (empty file created, see moveFile.js), or null if an
// identical file is already there (re-ingest: source left for review).
async function claimDestination(srcPath, destPath) {
  for (let n = 1; n <= MAX_COLLISION_SUFFIX; n += 1) {
    const candidate = n === 1 ? destPath : withSuffix(destPath, n);
    let handle;
    try {
      handle = await fs.open(candidate, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
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
  // Defense-in-depth behind sanitizeSegment.
  assertInsideMusicDir(initialDest);

  await fs.mkdir(path.dirname(initialDest), { recursive: true });

  const dest = await claimDestination(srcPath, initialDest);
  if (dest === null) {
    return { movedTo: null, duplicate: true };
  }

  await moveOnto(srcPath, dest);

  return { movedTo: dest, duplicate: false };
}
