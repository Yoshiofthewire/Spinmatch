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
// This module talks to two ListenBrainz hosts with different stability
// guarantees, and the difference matters:
//
//   labs.api.listenbrainz.org  - similar artists. Explicitly EXPERIMENTAL. The
//     algorithm parameter is a long opaque string that could change or vanish,
//     and the service advertises no rate-limit headers.
//   api.listenbrainz.org       - popularity. The main, documented API.
//
// Sturdier is not sturdy: as of 2026-08-02 the popularity endpoints answer 500
// with "Popularity API currently disabled due to high load on the server". So
// the contract is the same for both halves — every failure returns null, callers
// degrade rather than break, and null is never cached. Playlist fill treats a
// null here as "rank this artist chronologically instead".

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

const API_BASE_URL = 'https://api.listenbrainz.org';

// Popularity shifts slowly and the endpoint is expensive enough upstream to be
// switched off under load, so this is cached for a day rather than an hour.
const POPULARITY_TTL_MS = 24 * 60 * 60 * 1000;

const popularityCache = new TTLCache({ maxEntries: 1000 });

/**
 * An artist's most-listened recordings, most listened first.
 *
 * @param {string} artistMbid
 * @returns {Promise<Array<{name, recordingMbid, listenCount}>|null>}
 *   an array (possibly empty — a real "nothing recorded") on success, or `null`
 *   when the service could not be reached or is disabled. Same distinction the
 *   similar-artist half makes: an empty result is worth caching, an outage is
 *   not.
 */
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
    // 500 is the current steady state of this endpoint, not an exceptional
    // event. It takes the same path as any other failure.
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

// Test seam, matching resetSimilarCacheForTest above.
export function resetPopularityCacheForTest() {
  popularityCache.store.clear();
}
