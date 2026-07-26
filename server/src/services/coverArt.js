import fs from 'node:fs/promises';
import path from 'node:path';
import { TTLCache } from '../lib/cache.js';
import { MAX_IMAGE_BYTES } from '../lib/imageBytes.js';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// URLs are small, so a generous cache costs little. Image *bodies* are not: this
// cache holds Buffers, so it is bounded by total bytes rather than by entry
// count. `maxEntries: 24` was not the tight bound its comment claimed — at the
// 8 MB per-image ceiling it permitted 192 MB of retained Buffers, which is most
// of a small container's memory held for twelve hours.
const cache = new TTLCache({ maxEntries: 2000 });
const IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const imageCache = new TTLCache({
  maxEntries: 256,
  maxBytes: IMAGE_CACHE_MAX_BYTES,
  // A remembered "no art here" is a null, which costs nothing to keep.
  sizeOf: (value) => value?.bytes?.length ?? 0,
});

// Returns the real Cover Art Archive front-cover URL, or null if none exists
// (or the lookup failed) so the route can fall back to a placeholder image.
export async function getFrontCoverUrl(releaseGroupMbid) {
  const cached = cache.get(releaseGroupMbid);
  if (cached !== undefined) return cached;

  const url = `https://coverartarchive.org/release-group/${releaseGroupMbid}/front`;
  let result = null;
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (response.ok) result = response.url;
  } catch (err) {
    // Cover art is decorative: a failed HEAD means "no art", and logging it is
    // enough. The route falls back to a placeholder.
    console.warn(`coverArt: front-cover lookup failed for ${releaseGroupMbid}: ${err.message}`);
    result = null;
  }

  cache.set(releaseGroupMbid, result, CACHE_TTL_MS);
  return result;
}

// Downloads the actual cover art image bytes for embedding into tagged files.
// Returns {bytes: Buffer, mimeType: string} or null if no cover art exists.
export async function getFrontCoverImage(releaseGroupMbid) {
  const cached = imageCache.get(releaseGroupMbid);
  if (cached !== undefined) return cached;

  const url = await getFrontCoverUrl(releaseGroupMbid);
  let result = null;
  if (url) {
    try {
      const response = await fetch(url);
      const declared = Number(response.headers.get('content-length'));
      if (response.ok && !(declared > MAX_IMAGE_BYTES)) {
        const bytes = Buffer.from(await response.arrayBuffer());
        // Re-checked after reading: Content-Length is a hint, not a promise.
        if (bytes.length <= MAX_IMAGE_BYTES) {
          result = { bytes, mimeType: response.headers.get('content-type') || 'image/jpeg' };
        } else {
          console.warn(`coverArt: front cover for ${releaseGroupMbid} exceeds ${MAX_IMAGE_BYTES} bytes, skipping`);
        }
      }
    } catch (err) {
      console.warn(`coverArt: could not fetch front cover for ${releaseGroupMbid}: ${err.message}`);
      result = null;
    }
  }

  imageCache.set(releaseGroupMbid, result, CACHE_TTL_MS);
  return result;
}

// Art stored beside the audio instead of embedded in it, which is how a lot of
// libraries (and most rippers) do it. Checked in this order, matched
// case-insensitively against the directory listing so "Cover.JPG" is found too.
const SIDECAR_BASENAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
const SIDECAR_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Returns {bytes, mimeType} for the album-folder cover image, or null. Not
// cached here: the route caches the extracted bytes, and the files are local.
export async function readSidecarCover(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const images = entries
    .filter((e) => e.isFile() && SIDECAR_TYPES[path.extname(e.name).toLowerCase()])
    .map((e) => e.name);

  const preferred = SIDECAR_BASENAMES
    .map((base) => images.find((name) => path.basename(name, path.extname(name)).toLowerCase() === base))
    .find(Boolean);
  if (!preferred) return null;

  const full = path.join(dir, preferred);
  try {
    // stat before read. The remote path has refused oversized art all along;
    // this one read whatever was there, which made "a file named cover.jpg in an
    // album folder" an arbitrary-size allocation on a route the album grid calls
    // two dozen times in parallel.
    const { size } = await fs.stat(full);
    if (size > MAX_IMAGE_BYTES) {
      console.warn(`coverArt: sidecar ${full} is ${size} bytes, over the ${MAX_IMAGE_BYTES} limit — skipping`);
      return null;
    }
    return {
      bytes: await fs.readFile(full),
      mimeType: SIDECAR_TYPES[path.extname(preferred).toLowerCase()],
    };
  } catch {
    return null;
  }
}
