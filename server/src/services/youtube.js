import { config } from '../config.js';
import { UpstreamUnavailableError, QuotaExceededError } from '../lib/httpErrors.js';

const BASE_URL = 'https://www.googleapis.com/youtube/v3';

// search.list costs 100 units; videos.list costs ~1 unit regardless of how many
// ids are batched into the single call, so one track lookup is ~101 units.
export const QUOTA_UNITS_PER_TRACK = 101;

async function ytFetch(path, params) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('key', config.youtubeApiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new UpstreamUnavailableError(`Could not reach YouTube: ${err.message}`);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const reason = body?.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      throw new QuotaExceededError('Daily YouTube quota exceeded — try again tomorrow or enable billing.');
    }
    throw new UpstreamUnavailableError(`YouTube API returned ${response.status} for ${path}`);
  }

  return response.json();
}

export async function searchCandidates(query, maxResults = 5) {
  const json = await ytFetch('/search', {
    part: 'snippet',
    type: 'video',
    maxResults: String(maxResults),
    q: query,
  });

  return (json.items || []).map((item) => ({
    id: item.id.videoId,
    title: item.snippet.title,
  }));
}

// ISO 8601 duration -> milliseconds, e.g. "PT3M22S" -> 202000. Only handles the
// hours/minutes/seconds subset YouTube actually returns for videos.
export function parseIso8601Duration(duration) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration || '');
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  const totalSeconds =
    Number(hours || 0) * 3600 + Number(minutes || 0) * 60 + Number(seconds || 0);
  return totalSeconds * 1000;
}

export async function getDurations(videoIds) {
  if (videoIds.length === 0) return [];

  const json = await ytFetch('/videos', {
    part: 'contentDetails',
    id: videoIds.join(','),
  });

  return (json.items || []).map((item) => ({
    id: item.id,
    durationMs: parseIso8601Duration(item.contentDetails.duration),
  }));
}
