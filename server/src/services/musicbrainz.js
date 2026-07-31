import { config, userAgent } from '../config.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { TTLCache } from '../lib/cache.js';
import { UpstreamUnavailableError } from '../lib/httpErrors.js';

const BASE_URL = 'https://musicbrainz.org/ws/2';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Node's fetch has no default timeout, and this is the worst place in the app to
// go without one: the rate limiter below is a single process-wide queue, so one
// request stalled on a half-open socket stalls *every* MusicBrainz lookup behind
// it — the artist sweep, the album check, the bulk repair — for as long as the
// OS keeps the socket alive. The signal covers reading the body too, not just
// the handshake.
const REQUEST_TIMEOUT_MS = 15_000;

// MusicBrainz allows at most 1 request/sec per source IP; this queue is shared
// across every call this process makes, regardless of which route triggered it.
const rateLimiter = new RateLimiter(1000);
// Bounded: the key is the full request URL, so an unbounded map grows with every
// distinct search anyone runs, and each entry holds a whole JSON response.
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

  const json = await rateLimiter.schedule(async () => {
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new UpstreamUnavailableError(`Could not reach MusicBrainz: ${err.message}`);
    }
    if (!response.ok) {
      throw new UpstreamUnavailableError(`MusicBrainz returned ${response.status} for ${path}`);
    }
    try {
      // Inside the try as well: the deadline covers the body, so a response that
      // sends headers and then trickles aborts here rather than in the fetch
      // above — and a raw AbortError escaping would be a 500 instead of the
      // "upstream is unavailable" the rest of this module promises.
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

// Flattens a MusicBrainz artist-credit array to the string a tag should carry.
//
// `joinphrase` is the part that was being dropped. MusicBrainz models a credit
// as segments each carrying the text that follows it, so Simon & Garfunkel
// arrives as [{name: 'Simon', joinphrase: ' & '}, {name: 'Garfunkel'}] — and
// joining on '' rendered that as "SimonGarfunkel". Every collaboration, every
// "feat.", every "vs" in the library was mangled the same way.
export function creditString(credit) {
  if (!Array.isArray(credit)) return '';
  return credit.map((c) => `${c?.name ?? ''}${c?.joinphrase ?? ''}`).join('').trim();
}

// The two search indexes below are also queried on their own (with a fielded
// Lucene query) by the tag-based matcher, so they're exported individually as
// well as through searchAll.
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

// The artist index on its own. Callers that only need to resolve a name to an
// artist id use this rather than searchAll: it's one upstream request instead of
// three (which matters against a 1 req/s limit), and a failure in the unrelated
// release-group or recording index can't take the resolution down with it.
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

// Artists MusicBrainz records a relationship to. MusicBrainz has no "sounds
// like" edge — that's a listening-data judgement it doesn't make — so what comes
// back is the factual graph: band members and their other bands, side projects,
// collaborations, supporting musicians. That is a narrower claim than
// "recommended for you", and the UI says so rather than dressing it up.
//
// The relation types kept are the ones that imply a listener connection —
// checked against what MusicBrainz actually returns, not guessed at.
//
// Excluded on purpose: 'tribute' (a covers band is not a lead) and
// 'artist rename' (the same act under another name, so following it suggests
// someone you already own). 'subgroup' is kept precisely because a side project
// is one of the better leads this graph offers.
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
    // A relation to the artist we asked about is the edge pointing back at
    // itself; skip it rather than reporting everyone as related to themselves.
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
        // The per-track credit, which `inc=artist-credits` has been fetching all
        // along and this mapping used to discard — leaving the bulk repair to
        // fall back on the release's own credit for every track. On a
        // compilation that meant writing "Various Artists" into the artist tag of
        // every file on the record, and since the repair only fills fields that
        // are empty, the files it hit were exactly the untagged ones the feature
        // exists to fix. The track-level credit is the authoritative one; the
        // recording's is the fallback for releases that only carry it there.
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
      // Carried so a bulk repair can fill a year tag from the same fetch that
      // produced the tracklist, rather than a second lookup per album.
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
