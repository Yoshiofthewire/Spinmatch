import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { BadRequestError } from '../lib/httpErrors.js';

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

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function filesAreIdentical(a, b) {
  const [statA, statB] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (statA.size !== statB.size) return false;
  const [bufA, bufB] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
  return bufA.equals(bufB);
}

function withSuffix(destPath, n) {
  const ext = path.extname(destPath);
  const base = destPath.slice(0, ext.length ? -ext.length : undefined);
  return `${base} (${n})${ext}`;
}

// Returns the final destination path, or null if an identical file already
// exists there (caller leaves the source untouched in that case).
async function resolveCollision(srcPath, destPath) {
  if (!(await fileExists(destPath))) return destPath;
  if (await filesAreIdentical(srcPath, destPath)) return null;

  let n = 2;
  let candidate = withSuffix(destPath, n);
  while (await fileExists(candidate)) {
    n += 1;
    candidate = withSuffix(destPath, n);
  }
  return candidate;
}

// Defense-in-depth: sanitizeSegment already strips path separators and
// neutralizes "."/".." segments, so this should never actually fire through
// the normal API — but it's a cheap, correct guard against any future change
// to sanitization logic letting a MusicBrainz-sourced value escape MUSIC_DIR.
function assertInsideMusicDir(destPath) {
  const resolvedDest = path.resolve(destPath);
  const resolvedRoot = path.resolve(config.ingest.musicDir);
  if (!resolvedDest.startsWith(resolvedRoot + path.sep)) {
    throw new BadRequestError(`Refusing to write outside MUSIC_DIR: ${destPath}`);
  }
}

export async function moveIntoLibrary(srcPath, meta, ext) {
  const initialDest = targetPathFor(meta, ext);
  assertInsideMusicDir(initialDest);

  const dest = await resolveCollision(srcPath, initialDest);
  if (dest === null) {
    return { movedTo: null, duplicate: true };
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });

  try {
    await fs.rename(srcPath, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    const partial = `${dest}.partial`;
    await fs.copyFile(srcPath, partial);
    await fs.rename(partial, dest);
    await fs.unlink(srcPath);
  }

  return { movedTo: dest, duplicate: false };
}
