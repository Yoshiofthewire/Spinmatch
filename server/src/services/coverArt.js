import fs from 'node:fs/promises';
import path from 'node:path';
import { TTLCache } from '../lib/cache.js';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const cache = new TTLCache();
const imageCache = new TTLCache();

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
  } catch {
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
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        const mimeType = response.headers.get('content-type') || 'image/jpeg';
        result = { bytes, mimeType };
      }
    } catch {
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
// cached: this is served with a long Cache-Control, and the files are local.
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

  try {
    return {
      bytes: await fs.readFile(path.join(dir, preferred)),
      mimeType: SIDECAR_TYPES[path.extname(preferred).toLowerCase()],
    };
  } catch {
    return null;
  }
}
