import fs from 'node:fs/promises';
import path from 'node:path';

// The one place a file is moved from A to B.
//
// Extracted from organize.js, which had the only correct implementation of this
// and needed it for ingest; the duplicate-trash flow needs exactly the same
// thing. Two copies would mean a future fix landing in only one of them.

// How many " (n)" suffixes to try before giving up. Bounded because the loop
// that finds a free name is otherwise unbounded, and a directory that somehow
// contains thousands of collisions is a fault to report, not to grind through.
export const MAX_COLLISION_SUFFIX = 999;

export function withSuffix(destPath, n) {
  const ext = path.extname(destPath);
  const base = destPath.slice(0, ext.length ? -ext.length : undefined);
  return `${base} (${n})${ext}`;
}

// Moves src onto claimedDest, which the caller has already reserved. The rename
// therefore overwrites our own placeholder, and nothing else can have taken the
// name in the meantime, because we are holding it.
export async function moveOnto(src, claimedDest) {
  try {
    await fs.rename(src, claimedDest);
  } catch (err) {
    if (err.code !== 'EXDEV') {
      // Don't leave the placeholder behind as a 0-byte "track" for the scanner
      // to index (it has an audio extension, so it would be indexed).
      await fs.unlink(claimedDest).catch(() => {});
      throw err;
    }
    // Cross-device: copy through a temp name in the destination directory, then
    // rename over the placeholder. The temp file is cleaned up on failure —
    // previously a copy that died part-way (a full disk, which is the common
    // cause of a cross-device copy failing) left a `.partial` file behind
    // forever, invisible to the scanner and accumulating on every retry.
    const partial = `${claimedDest}.partial`;
    try {
      await fs.copyFile(src, partial);
      await fs.rename(partial, claimedDest);
      await fs.unlink(src);
    } catch (copyErr) {
      await fs.unlink(partial).catch(() => {});
      await fs.unlink(claimedDest).catch(() => {});
      throw copyErr;
    }
  }
  return claimedDest;
}
