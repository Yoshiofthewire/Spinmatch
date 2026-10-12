import { config, userAgent } from '../config.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { TTLCache } from '../lib/cache.js';

// ListenBrainz: listening-based similarity and popularity, keyed on MusicBrainz MBIDs.
// Both endpoints are unreliable (labs is experimental; popularity often 500s), so
// every failure returns null, callers degrade, and null is never cached.

const BASE_URL = 'https://labs.api.listenbrainz.org';

// Opaque and part of the URL contract; may break upstream.
const ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_10'
  + '_limit_100_filter_True_skip_30';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour, matching the MusicBrainz client
const REQUEST_TIMEOUT_MS = 15_000;

// No published limit; politeness. Process-wide.
const rateLimiter = new RateLimiter(300);
const cache = new TTLCache({ maxEntries: 1000 });

// Returns an array (empty = nothing similar, cached) or null (outage, not cached).
export async function getSimilarArtists(artistMbid) {
  if (!artistMbid || !config.discovery.listenBrainzEnabled) return null;

  const cached = cache.get(artistMbid);
  if (cached !== undefined) return cached;

  const url = new URL('/similar-artists/json', BASE_URL);
  url.searchParams.set('artist_mbids', artistMbid);
  url.searchParams.set('algorithm', ALGORITHM);

  const result = await rateLimiter.schedule(async () => {
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    try {
      const json = await response.json();
      if (!Array.isArray(json)) return null;
      return json
        .filter((a) => a?.artist_mbid && a.artist_mbid !== artistMbid)
        .map((a) => ({
          mbid: a.artist_mbid,
          name: a.name,
          // Raw count, not comparable across seeds; rank by position.
          score: a.score ?? 0,
          comment: a.comment || null,
          type: a.type || null,
        }));
    } catch {
      return null;
    }
  });

  if (result !== null) cache.set(artistMbid, result, CACHE_TTL_MS);
  return result;
}

export function resetSimilarCacheForTest() {
  cache.store.clear();
}

const API_BASE_URL = 'https://api.listenbrainz.org';

// A day: popularity moves slowly and the endpoint is overloaded.
const POPULARITY_TTL_MS = 24 * 60 * 60 * 1000;

const popularityCache = new TTLCache({ maxEntries: 1000 });

// Most-listened first. Array or null, as getSimilarArtists.
export async function getTopRecordings(artistMbid) {
  if (!artistMbid || !config.discovery.listenBrainzEnabled) return null;

  const cached = popularityCache.get(artistMbid);
  if (cached !== undefined) return cached;

  const url = new URL(`/1/popularity/top-recordings-for-artist/${artistMbid}`, API_BASE_URL);

  const result = await rateLimiter.schedule(async () => {
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    try {
      const json = await response.json();
      if (!Array.isArray(json)) return null;
      return json
        .filter((r) => r?.recording_name)
        .map((r) => ({
          name: r.recording_name,
          recordingMbid: r.recording_mbid ?? null,
          listenCount: r.total_listen_count ?? 0,
        }));
    } catch {
      return null;
    }
  });

  if (result !== null) popularityCache.set(artistMbid, result, POPULARITY_TTL_MS);
  return result;
}

export function resetPopularityCacheForTest() {
  popularityCache.store.clear();
}
