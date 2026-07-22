import { config, userAgent } from '../config.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { TTLCache } from '../lib/cache.js';
import { UpstreamUnavailableError } from '../lib/httpErrors.js';

const BASE_URL = 'https://musicbrainz.org/ws/2';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// MusicBrainz allows at most 1 request/sec per source IP; this queue is shared
// across every call this process makes, regardless of which route triggered it.
const rateLimiter = new RateLimiter(1000);
const cache = new TTLCache();

async function mbFetch(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('fmt', 'json');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const cacheKey = url.toString();
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const json = await rateLimiter.schedule(async () => {
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
      });
    } catch (err) {
      throw new UpstreamUnavailableError(`Could not reach MusicBrainz: ${err.message}`);
    }
    if (!response.ok) {
      throw new UpstreamUnavailableError(`MusicBrainz returned ${response.status} for ${path}`);
    }
    return response.json();
  });

  cache.set(cacheKey, json, CACHE_TTL_MS);
  return json;
}

function coverArtUrlForReleaseGroup(mbid) {
  return `/api/cover/release-group/${mbid}`;
}

export async function searchAll(query) {
  const [artistRes, releaseGroupRes, recordingRes] = await Promise.all([
    mbFetch('/artist', { query }),
    mbFetch('/release-group', { query }),
    mbFetch('/recording', { query }),
  ]);

  const artists = (artistRes.artists || []).map((a) => ({
    mbid: a.id,
    name: a.name,
    disambiguation: a.disambiguation || null,
    score: Number(a.score) || 0,
  }));

  const releaseGroups = (releaseGroupRes['release-groups'] || []).map((rg) => ({
    mbid: rg.id,
    title: rg.title,
    artist: (rg['artist-credit'] || []).map((c) => c.name).join(''),
    firstReleaseDate: rg['first-release-date'] || null,
    coverArtUrl: coverArtUrlForReleaseGroup(rg.id),
    score: Number(rg.score) || 0,
  }));

  const recordings = (recordingRes.recordings || []).map((r) => ({
    mbid: r.id,
    title: r.title,
    artist: (r['artist-credit'] || []).map((c) => c.name).join(''),
    releaseGroupTitle: r.releases?.[0]?.['release-group']?.title || r.releases?.[0]?.title || null,
    lengthMs: r.length || null,
    score: Number(r.score) || 0,
  }));

  return { artists, releaseGroups, recordings };
}

export async function getArtist(artistMbid) {
  const res = await mbFetch(`/artist/${artistMbid}`);
  return { mbid: res.id, name: res.name };
}

export async function browseReleaseGroupsByArtist(artistMbid) {
  const [artist, res] = await Promise.all([
    getArtist(artistMbid),
    mbFetch('/release-group', { artist: artistMbid, limit: 100 }),
  ]);

  // Only studio albums: primary type Album with no secondary type (excludes
  // live recordings, compilations, remixes, etc. that share the Album primary type).
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

  const tracks = [];
  for (const medium of res.media || []) {
    for (const track of medium.tracks || []) {
      tracks.push({
        position: track.position,
        recordingMbid: track.recording?.id || null,
        title: track.title,
        lengthMs: track.length || track.recording?.length || null,
      });
    }
  }

  return {
    release: {
      mbid: res.id,
      title: res.title,
      artist: (res['artist-credit'] || []).map((c) => c.name).join(''),
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
    artist: (res['artist-credit'] || []).map((c) => c.name).join(''),
    releaseGroups,
    date: res['first-release-date'] || null,
  };
}
