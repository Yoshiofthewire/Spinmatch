import { TTLCache } from '../lib/cache.js';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const cache = new TTLCache();

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
