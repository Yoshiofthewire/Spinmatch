import { searchCandidates } from './ytdlp.js';
import { rankCandidates, pickResult } from './durationMatch.js';
import { TTLCache } from '../lib/cache.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const cache = new TTLCache({ maxEntries: 2000 });

// ASCII 31 (unit separator), constructed rather than written as a literal so no
// invisible control character ends up in the source — the same separator, for
// the same reason, as libraryRepo.js and client/src/lib/albumKey.js. '|' was a
// character that can legitimately appear in a track or artist name, which made
// two different tracks share one cache entry and hand back each other's YouTube
// match.
const UNIT_SEPARATOR = String.fromCharCode(31);

function cacheKey({ artist, title, album, lengthMs }) {
  return [artist, title, album || '', lengthMs].join(UNIT_SEPARATOR).toLowerCase();
}

async function fetchRankedCandidates(query, lengthMs) {
  const candidates = await searchCandidates(query);
  if (candidates.length === 0) return [];
  return rankCandidates(candidates, lengthMs);
}

export async function verifyTrack({ artist, title, album, lengthMs }) {
  const key = cacheKey({ artist, title, album, lengthMs });
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let ranked = await fetchRankedCandidates(`${artist} ${title} ${album || ''}`.trim(), lengthMs);
  if (ranked.length === 0 && album) {
    // Album title in the query can hurt matching (e.g. compilations, reissues) — retry without it.
    ranked = await fetchRankedCandidates(`${artist} ${title}`.trim(), lengthMs);
  }

  const result = { ...pickResult(ranked), candidatesConsidered: ranked.length };
  cache.set(key, result, CACHE_TTL_MS);
  return result;
}
