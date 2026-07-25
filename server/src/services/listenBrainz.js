import { config, userAgent } from '../config.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { TTLCache } from '../lib/cache.js';

// ListenBrainz similar-artists: the "sounds like" signal MusicBrainz itself
// doesn't have.
//
// MusicBrainz records facts — who played in which band, who collaborated with
// whom — which is why discovery built on it alone answers "Radiohead → Colin
// Greenwood" rather than "Radiohead → Portishead". ListenBrainz is the same
// organisation, keyed on the same artist MBIDs, and derives similarity from
// actual listening sessions. No API key.
//
// Measured against a real 1000-artist library before being built on: 100%
// coverage for artists with 20+ tracks (the tier discovery seeds from), and it
// covered 7 artists the relationship graph knew nothing about while the reverse
// was true only once.
//
// IMPORTANT: this is `labs.` — explicitly experimental infrastructure. The
// algorithm parameter is a long opaque string that could change or disappear,
// and the service advertises no rate-limit headers. So every failure here is
// non-fatal by construction: callers get null and fall back to the relationship
// graph rather than seeing discovery break.

const BASE_URL = 'https://labs.api.listenbrainz.org';

// The algorithm identifier is part of the URL contract, not a tunable. Recorded
// here rather than inlined so that when it does break, there is one obvious
// place to change it.
const ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_10'
  + '_limit_100_filter_True_skip_30';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour, matching the MusicBrainz client
const REQUEST_TIMEOUT_MS = 15_000;

// No published limit, so this is politeness rather than a stated requirement —
// several times faster than the MusicBrainz queue, still not a flood. Shared
// across the process like the MusicBrainz one.
const rateLimiter = new RateLimiter(300);
const cache = new TTLCache({ maxEntries: 1000 });

/**
 * Artists whose listeners overlap with this one's.
 *
 * @param {string} artistMbid
 * @returns {Promise<Array<{mbid, name, score, comment, type}>|null>}
 *   an array (possibly empty — a real "nothing similar") on success, or `null`
 *   when the service could not be reached. The distinction matters: an empty
 *   result is worth caching, an outage is not.
 */
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
      // Unreachable, DNS failure, timeout. Deliberately not thrown: discovery
      // degrades to the relationship graph instead of failing the request.
      return null;
    }
    if (!response.ok) return null;
    try {
      const json = await response.json();
      // The endpoint returns a bare array. Anything else means the shape has
      // changed under us, which is a degrade rather than a crash.
      if (!Array.isArray(json)) return null;
      return json
        .filter((a) => a?.artist_mbid && a.artist_mbid !== artistMbid)
        .map((a) => ({
          mbid: a.artist_mbid,
          name: a.name,
          // Raw co-occurrence count. Comparable within one artist's list, NOT
          // across lists — a popular seed produces far bigger numbers — so
          // callers rank on position, not on this.
          score: a.score ?? 0,
          comment: a.comment || null,
          type: a.type || null,
        }));
    } catch {
      return null;
    }
  });

  // Only successes are cached. Caching an outage for an hour would turn a blip
  // into an hour of silently degraded results.
  if (result !== null) cache.set(artistMbid, result, CACHE_TTL_MS);
  return result;
}

// Test seam: the in-process cache would otherwise carry answers between cases.
export function resetSimilarCacheForTest() {
  cache.store.clear();
}
