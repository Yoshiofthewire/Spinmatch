import fs from 'node:fs/promises';
import path from 'node:path';
import { TTLCache } from '../lib/cache.js';
import { MAX_IMAGE_BYTES } from '../lib/imageBytes.js';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Node's fetch has no default timeout, so a connection that opens and then goes
// quiet is held until the OS gives up on the socket — minutes, during which the
// album grid's two dozen parallel cover requests are all still queued behind it.
// Same value and same reasoning as listenBrainz.js.
const REQUEST_TIMEOUT_MS = 15_000;

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
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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

// Reads a response body up to `limit` bytes, or returns null the moment it goes
// over. Returning early out of the for-await cancels the underlying stream, so
// an oversized body stops arriving rather than being drained.
//
// This is the check that has to hold. Content-Length is what the sender chose to
// claim: a response that omits it, or lies about it, was free to allocate as
// much memory as it liked under a `Buffer.from(await response.arrayBuffer())` —
// the whole body lands before its size can be looked at.
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

// Downloads the actual cover art image bytes for embedding into tagged files.
// Returns {bytes: Buffer, mimeType: string} or null if no cover art exists.
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
