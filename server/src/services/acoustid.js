import { config } from '../config.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { TTLCache } from '../lib/cache.js';
import { UpstreamUnavailableError, RateLimitedError } from '../lib/httpErrors.js';

const BASE_URL = 'https://api.acoustid.org/v2/lookup';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — a fingerprint→recording mapping is stable

// AcoustID's documented limit is 3 requests/sec per API key.
const rateLimiter = new RateLimiter(334);
const cache = new TTLCache();

export async function lookup({ fingerprint, durationSeconds }) {
  const cacheKey = `${Math.round(durationSeconds)}:${fingerprint}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const json = await rateLimiter.schedule(async () => {
    const body = new URLSearchParams({
      client: config.acoustidApiKey,
      format: 'json',
      duration: String(Math.round(durationSeconds)),
      fingerprint,
      meta: 'recordings+releasegroups',
    });

    let response;
    try {
      response = await fetch(BASE_URL, { method: 'POST', body });
    } catch (err) {
      throw new UpstreamUnavailableError(`Could not reach AcoustID: ${err.message}`);
    }

    if (response.status === 429) {
      throw new RateLimitedError('AcoustID is rate-limiting requests — try again shortly.');
    }
    if (!response.ok) {
      throw new UpstreamUnavailableError(`AcoustID returned ${response.status}`);
    }

    const parsed = await response.json();
    if (parsed.status !== 'ok') {
      throw new UpstreamUnavailableError(`AcoustID lookup failed: ${parsed.error?.message || 'unknown error'}`);
    }
    return parsed;
  });

  const candidates = (json.results || []).flatMap((result) =>
    (result.recordings || []).map((recording) => ({ recordingMbid: recording.id, score: result.score }))
  );

  cache.set(cacheKey, candidates, CACHE_TTL_MS);
  return candidates;
}
