import fs from 'node:fs/promises';
import path from 'node:path';

// The one place a file is moved from A to B.

// " (n)" suffixes to try before treating collisions as a fault.
export const MAX_COLLISION_SUFFIX = 999;

export async function fsyncPath(p) {
  const fh = await fs.open(p, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export function withSuffix(destPath, n) {
  const ext = path.extname(destPath);
  const base = destPath.slice(0, ext.length ? -ext.length : undefined);
  return `${base} (${n})${ext}`;
}

// claimedDest is a placeholder the caller created with 'wx', so the rename can't clobber anything else.
export async function moveOnto(src, claimedDest) {
  try {
    await fs.rename(src, claimedDest);
  } catch (err) {
    if (err.code !== 'EXDEV') {
      // Else the scanner indexes a 0-byte "track".
      await fs.unlink(claimedDest).catch(() => {});
      throw err;
    }
    // Cross-device: copy to a temp name beside the placeholder, then rename over it.
    const partial = `${claimedDest}.partial`;
    try {
      await fs.copyFile(src, partial);
      // Durable before the source goes, or a power cut can lose both.
      await fsyncPath(partial);
      await fs.rename(partial, claimedDest);
      await fsyncPath(path.dirname(claimedDest));
      await fs.unlink(src);
    } catch (copyErr) {
      await fs.unlink(partial).catch(() => {});
      await fs.unlink(claimedDest).catch(() => {});
      throw copyErr;
    }
  }
  return claimedDest;
}
