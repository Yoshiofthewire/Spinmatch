import fs from 'node:fs/promises';
import path from 'node:path';
import { TTLCache } from '../lib/cache.js';
import { MAX_IMAGE_BYTES } from '../lib/imageBytes.js';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Node's fetch has no default timeout; a stalled socket would block the album grid.
const REQUEST_TIMEOUT_MS = 15_000;

// Image cache holds Buffers, so it's bounded by total bytes, not entry count.
const cache = new TTLCache({ maxEntries: 2000 });
const IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const imageCache = new TTLCache({
  maxEntries: 256,
  maxBytes: IMAGE_CACHE_MAX_BYTES,
  // A remembered "no art here" is a null, which costs nothing to keep.
  sizeOf: (value) => value?.bytes?.length ?? 0,
});

// Cover Art Archive front-cover URL, or null (route falls back to a placeholder).
export async function getFrontCoverUrl(releaseGroupMbid) {
  const cached = cache.get(releaseGroupMbid);
  if (cached !== undefined) return cached;

  const url = `https://coverartarchive.org/release-group/${releaseGroupMbid}/front`;
  let result = null;
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) result = response.url;
  } catch (err) {
    console.warn(`coverArt: front-cover lookup failed for ${releaseGroupMbid}: ${err.message}`);
    result = null;
  }

  cache.set(releaseGroupMbid, result, CACHE_TTL_MS);
  return result;
}

// Null once the body exceeds `limit`; returning cancels the stream. This, not
// Content-Length (sender-controlled), is the enforced cap.
async function readCapped(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

// {bytes, mimeType} or null.
export async function getFrontCoverImage(releaseGroupMbid) {
  const cached = imageCache.get(releaseGroupMbid);
  if (cached !== undefined) return cached;

  const url = await getFrontCoverUrl(releaseGroupMbid);
  let result = null;
  if (url) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const declared = Number(response.headers.get('content-length'));
      if (response.ok && !(declared > MAX_IMAGE_BYTES)) {
        const bytes = await readCapped(response, MAX_IMAGE_BYTES);
        if (bytes) {
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

// Sidecar art, in preference order, matched case-insensitively.
const SIDECAR_BASENAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
const SIDECAR_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Not cached here: the route caches the bytes.
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
    // stat before read: cap the allocation.
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
