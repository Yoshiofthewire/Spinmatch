import { config, userAgent } from '../config.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { TTLCache } from '../lib/cache.js';
import { UpstreamUnavailableError } from '../lib/httpErrors.js';

const BASE_URL = 'https://musicbrainz.org/ws/2';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// The rate limiter is one process-wide queue, so a stalled socket would stall every
// lookup. Covers reading the body too.
const REQUEST_TIMEOUT_MS = 15_000;

// MusicBrainz allows 1 req/s per IP; shared process-wide, 100ms margin for jitter.
const rateLimiter = new RateLimiter(1100);

const RETRY_AFTER_DEFAULT_S = 2;
const RETRY_AFTER_MAX_S = 10;

export function retryAfterMs(header) {
  const seconds = header != null && /^\d+$/.test(header.trim()) ? Number(header) : RETRY_AFTER_DEFAULT_S;
  return Math.min(seconds, RETRY_AFTER_MAX_S) * 1000;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Bounded: keyed by full URL, so every distinct search adds a whole JSON response.
const cache = new TTLCache({ maxEntries: 2000 });

async function mbFetch(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('fmt', 'json');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const cacheKey = url.toString();
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const request = async () => {
    try {
      return await fetch(url, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new UpstreamUnavailableError(`Could not reach MusicBrainz: ${err.message}`);
    }
  };

  const json = await rateLimiter.schedule(async () => {
    let response = await request();
    // 503 is MusicBrainz's rate limit. Wait inside the queue so nothing else goes out; retry once.
    if (response.status === 503) {
      await response.body?.cancel();
      await sleep(retryAfterMs(response.headers.get('retry-after')));
      response = await request();
    }
    if (!response.ok) {
      throw new UpstreamUnavailableError(`MusicBrainz returned ${response.status} for ${path}`);
    }
    try {
      // The timeout can abort mid-body; map it to upstream-unavailable, not a 500.
      return await response.json();
    } catch (err) {
      throw new UpstreamUnavailableError(`Could not read the MusicBrainz response for ${path}: ${err.message}`);
    }
  });

  cache.set(cacheKey, json, CACHE_TTL_MS);
  return json;
}

function coverArtUrlForReleaseGroup(mbid) {
  return `/api/cover/release-group/${mbid}`;
}

// Artist-credit array to tag string. Each segment carries its trailing joinphrase (' & ', ' feat. ').
export function creditString(credit) {
  if (!Array.isArray(credit)) return '';
  return credit.map((c) => `${c?.name ?? ''}${c?.joinphrase ?? ''}`).join('').trim();
}

// Also used directly by the tag matcher with fielded Lucene queries.
export async function searchReleaseGroups(query) {
  const res = await mbFetch('/release-group', { query });
  return (res['release-groups'] || []).map((rg) => ({
    mbid: rg.id,
    title: rg.title,
    artist: creditString(rg['artist-credit']),
    firstReleaseDate: rg['first-release-date'] || null,
    coverArtUrl: coverArtUrlForReleaseGroup(rg.id),
    score: Number(rg.score) || 0,
  }));
}

export async function searchRecordings(query) {
  const res = await mbFetch('/recording', { query });
  return (res.recordings || []).map((r) => ({
    mbid: r.id,
    title: r.title,
    artist: creditString(r['artist-credit']),
    releaseGroupTitle: r.releases?.[0]?.['release-group']?.title || r.releases?.[0]?.title || null,
    lengthMs: r.length || null,
    score: Number(r.score) || 0,
  }));
}

// For name-to-id resolution: one request instead of searchAll's three, at 1 req/s.
export async function searchArtists(query) {
  const res = await mbFetch('/artist', { query });
  return (res.artists || []).map((a) => ({
    mbid: a.id,
    name: a.name,
    disambiguation: a.disambiguation || null,
    score: Number(a.score) || 0,
  }));
}

export async function searchAll(query) {
  const [artists, releaseGroups, recordings] = await Promise.all([
    searchArtists(query),
    searchReleaseGroups(query),
    searchRecordings(query),
  ]);

  return { artists, releaseGroups, recordings };
}

export async function getArtist(artistMbid) {
  const res = await mbFetch(`/artist/${artistMbid}`);
  return { mbid: res.id, name: res.name };
}

// Factual relationships (members, side projects, collaborators), not "sounds like".
// Excluded: 'tribute' (covers band) and 'artist rename' (same act you already own).
const USEFUL_ARTIST_RELATIONS = new Set([
  'member of band', 'collaboration', 'supporting musician', 'subgroup',
  'founder', 'conductor position', 'artistic director',
]);

export async function getRelatedArtists(artistMbid) {
  const res = await mbFetch(`/artist/${artistMbid}`, { inc: 'artist-rels' });
  const seen = new Map();
  for (const rel of res.relations || []) {
    if (!USEFUL_ARTIST_RELATIONS.has(rel.type)) continue;
    const other = rel.artist;
    // Skip edges pointing back at the queried artist.
    if (!other?.id || other.id === artistMbid) continue;
    if (!seen.has(other.id)) {
      seen.set(other.id, { mbid: other.id, name: other.name, relation: rel.type });
    }
  }
  return [...seen.values()];
}

export async function browseReleaseGroupsByArtist(artistMbid) {
  const [artist, res] = await Promise.all([
    getArtist(artistMbid),
    mbFetch('/release-group', { artist: artistMbid, limit: 100 }),
  ]);

  // Studio albums only: secondary types mark live, compilation, remix, etc.
  const albums = (res['release-groups'] || [])
    .filter((rg) => rg['primary-type'] === 'Album' && (rg['secondary-types'] || []).length === 0)
    .map((rg) => ({
      mbid: rg.id,
      title: rg.title,
      firstReleaseDate: rg['first-release-date'] || null,
      primaryType: rg['primary-type'],
      coverArtUrl: coverArtUrlForReleaseGroup(rg.id),
    }))
    .sort((a, b) => (a.firstReleaseDate || '').localeCompare(b.firstReleaseDate || ''));

  return { artist, albums };
}

// Release-groups don't carry track lengths themselves; resolve to one concrete
// release within the group (preferring an official release) to read its tracklist.
export async function resolvePrimaryReleaseForGroup(releaseGroupMbid) {
  const res = await mbFetch('/release', { 'release-group': releaseGroupMbid, limit: 100 });
  const releases = res.releases || [];
  const official = releases.find((r) => r.status === 'Official') || releases[0];
  return official ? official.id : null;
}

export async function getReleaseWithTracks(releaseMbid) {
  const res = await mbFetch(`/release/${releaseMbid}`, { inc: 'recordings+artist-credits' });

  const media = res.media || [];
  const tracks = [];
  media.forEach((medium, index) => {
    // MusicBrainz numbers media (discs) with `position`; fall back to order.
    const discNumber = medium.position ?? index + 1;
    for (const track of medium.tracks || []) {
      tracks.push({
        position: track.position,
        discNumber,
        recordingMbid: track.recording?.id || null,
        title: track.title,
        // Track credit is authoritative (the release credit is "Various Artists" on
        // compilations); the recording's is the fallback.
        artist: creditString(track['artist-credit'])
          || creditString(track.recording?.['artist-credit'])
          || null,
        lengthMs: track.length || track.recording?.length || null,
      });
    }
  });

  return {
    release: {
      mbid: res.id,
      title: res.title,
      artist: creditString(res['artist-credit']),
      // Lets bulk repair fill year without a second lookup.
      date: res.date ?? null,
      discCount: media.length,
    },
    tracks,
  };
}

export async function getRecording(recordingMbid) {
  const res = await mbFetch(`/recording/${recordingMbid}`, { inc: 'artists+releases+release-groups' });

  const releaseGroups = (res.releases || [])
    .map((r) => r['release-group'])
    .filter(Boolean)
    .map((rg) => ({ mbid: rg.id, title: rg.title }));

  return {
    mbid: res.id,
    title: res.title,
    lengthMs: res.length || null,
    artist: creditString(res['artist-credit']),
    releaseGroups,
    date: res['first-release-date'] || null,
  };
}
