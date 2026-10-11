import { getDb } from '../lib/db.js';
import { listArtists, listArtistNames } from './libraryRepo.js';
import { resolveArtist } from './libraryDiscography.js';
import { getRelatedArtists, browseReleaseGroupsByArtist } from './musicbrainz.js';
import { getSimilarArtists as fetchSimilar } from './listenBrainz.js';
import { config } from '../config.js';
import { normalizeTitle, makeMatchKey, makeTitleKey } from '../lib/normalize.js';
import { resolveItems } from './playlistRepo.js';

// Discovery: artists you don't own, seeded from the ones you own most of.
// Two signals kept distinct to the UI: 'similar' (ListenBrainz, listener overlap) and
// 'related' (MusicBrainz, band membership). ListenBrainz is optional; absence degrades, not breaks.

// Each seed costs calls on the 1-req/s MusicBrainz queue; this sets run time.
const SEED_ARTISTS = 10;
const RELATIONS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECOMMEND_ARTISTS = 5;
// ListenBrainz returns 100; long tails would bury artists several seeds agree on.
const SIMILAR_PER_SEED = 25;

// Drops a leading article so "The Beatles" counts as owned. Local on purpose: in normalizeTitle
// it would conflate distinct acts ("The Church" vs "Church").
function artistKey(name) {
  return normalizeTitle(String(name ?? '').replace(/^\s*(the|a|an)\s+/i, ''));
}

function readCache(db, mbArtistId) {
  const row = db.prepare(
    'SELECT related_json AS relatedJson, checked_at AS checkedAt '
    + 'FROM library_similar_cache WHERE mb_artist_id = ?'
  ).get(mbArtistId);
  if (!row) return null;
  if (Date.now() - row.checkedAt > RELATIONS_TTL_MS) return null;
  try {
    const parsed = JSON.parse(row.relatedJson);
    // Legacy bare-array rows are treated as a miss.
    if (Array.isArray(parsed)) return null;
    if (!Array.isArray(parsed?.related) || !Array.isArray(parsed?.similar)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(db, mbArtistId, related) {
  db.prepare(`
    INSERT INTO library_similar_cache (mb_artist_id, related_json, checked_at)
    VALUES (?, ?, ?)
    ON CONFLICT(mb_artist_id) DO UPDATE SET
      related_json = excluded.related_json,
      checked_at = excluded.checked_at
  `).run(mbArtistId, JSON.stringify(related), Date.now());
}

async function signalsFor(db, mbArtistId) {
  const cached = readCache(db, mbArtistId);
  if (cached) return cached;

  const [related, similar] = await Promise.all([
    getRelatedArtists(mbArtistId),
    fetchSimilar(mbArtistId),
  ]);

  const signals = { related, similar: similar ?? [] };
  // null = ListenBrainz outage; don't cache a blip as "no similar artists" for a month.
  if (similar !== null) writeCache(db, mbArtistId, signals);
  return signals;
}

// resolveArtist caches misses too, so unresolvable names aren't re-searched.
async function seedArtists(db, limit) {
  const { artists } = listArtists(db, { sort: 'tracks', limit });
  const seeds = [];
  for (const row of artists) {
    const { mbArtistId } = await resolveArtist(row.artist, { db });
    if (mbArtistId) seeds.push({ ...row, mbArtistId });
  }
  return seeds;
}

// Runs take tens of seconds and can't be cancelled, so identical concurrent requests share one.
const inFlight = new Map();

function shared(key, run) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** @returns {Promise<{seeds: object[], artists: object[]}>} */
export function getSimilarArtists({ db = getDb(), limit = 30 } = {}) {
  return shared(`similar:${limit}`, () => computeSimilarArtists({ db, limit }));
}

/**
 * Discover passes excludeOwned=true; playlists pass false since owned neighbours are what they can play.
 * @returns {Promise<{artists: object[], listenBrainz: 'ok'|'unavailable'|'disabled'}>}
 */
export async function collectNeighbours(db, { seeds, excludeOwned = true, limit = 30 }) {
  const owned = excludeOwned ? new Set(listArtistNames(db).map(artistKey)) : null;

  const found = new Map();
  let listenBrainzAnswered = false;

  function note(candidate, seed, kind, rank) {
    if (owned && owned.has(artistKey(candidate.name))) return;
    const existing = found.get(candidate.mbid);
    if (existing) {
      existing.score += 1;
      existing.kinds.add(kind);
      existing.bestRank = Math.min(existing.bestRank, rank);
      if (kind === 'related' && !existing.relation) existing.relation = candidate.relation;
      if (!existing.via.includes(seed.artist)) existing.via.push(seed.artist);
      return;
    }
    found.set(candidate.mbid, {
      mbid: candidate.mbid,
      name: candidate.name,
      relation: kind === 'related' ? candidate.relation : null,
      comment: candidate.comment ?? null,
      kinds: new Set([kind]),
      // Rank, not ListenBrainz score: raw scores scale with seed popularity and don't compare.
      bestRank: rank,
      via: [seed.artist],
      score: 1,
    });
  }

  for (const seed of seeds) {
    const { related, similar } = await signalsFor(db, seed.mbArtistId);
    if (similar.length) listenBrainzAnswered = true;

    related.forEach((a, i) => note(a, seed, 'related', i));
    similar.slice(0, SIMILAR_PER_SEED).forEach((a, i) => note(a, seed, 'similar', i));
  }

  const artists = [...found.values()]
    .map(({ kinds, ...rest }) => ({
      ...rest,
      kind: kinds.size > 1 ? 'both' : [...kinds][0],
    }))
    .sort((a, b) => (
      b.score - a.score
      || a.bestRank - b.bestRank
      || a.name.localeCompare(b.name)
    ))
    .slice(0, limit);

  return {
    artists,
    listenBrainz: config.discovery.listenBrainzEnabled
      ? (listenBrainzAnswered ? 'ok' : 'unavailable')
      : 'disabled',
  };
}

export async function resolveSeedArtists(db, names) {
  const seeds = [];
  for (const artist of names) {
    const { mbArtistId } = await resolveArtist(artist, { db });
    if (mbArtistId) seeds.push({ artist, mbArtistId });
  }
  return seeds;
}

async function computeSimilarArtists({ db, limit }) {
  const seeds = await seedArtists(db, SEED_ARTISTS);
  const { artists, listenBrainz } = await collectNeighbours(db, {
    seeds, excludeOwned: true, limit,
  });
  return {
    seeds: seeds.map((s) => ({ artist: s.artist, trackCount: s.trackCount })),
    artists,
    listenBrainz,
  };
}

export function getRecommendations({ db = getDb(), limit = 24 } = {}) {
  return shared(`recommendations:${limit}`, () => computeRecommendations({ db, limit }));
}

async function computeRecommendations({ db, limit }) {
  // Via getSimilarArtists so it shares an in-flight run.
  const { seeds, artists } = await getSimilarArtists({ db, limit: RECOMMEND_ARTISTS });

  const owned = new Set(listArtistNames(db).map(artistKey));

  const albums = [];
  for (const artist of artists) {
    if (albums.length >= limit) break;
    if (owned.has(artistKey(artist.name))) continue;
    try {
      const { albums: releaseGroups } = await browseReleaseGroupsByArtist(artist.mbid);
      for (const rg of releaseGroups.slice(0, 5)) {
        albums.push({
          mbid: rg.mbid,
          title: rg.title,
          artist: artist.name,
          year: rg.firstReleaseDate ? Number(rg.firstReleaseDate.slice(0, 4)) : null,
          coverArtUrl: rg.coverArtUrl,
          via: artist.via,
        });
      }
    } catch {
      // One artist whose discography can't be read shouldn't empty the page.
    }
  }

  return { seeds, albums: albums.slice(0, limit) };
}

/**
 * Offline. Uses resolveItems so this agrees with what Add would actually resolve to.
 * @param {string[]} lines
 */
export function reconstructPlaylist(lines, { db = getDb() } = {}) {
  const parsed = [];
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;

    // "Artist - Title"; no dash means title only.
    const split = line.match(/^(.*?)\s+[-–—]\s+(.*)$/);
    const artist = split ? split[1].trim() : null;
    const title = split ? split[2].trim() : line;

    parsed.push({
      line,
      artist,
      title,
      album: null,
      matchKey: makeMatchKey(artist, title),
      titleKey: makeTitleKey(title),
    });
  }

  const found = [];
  const missing = [];
  for (const item of resolveItems(db, parsed)) {
    if (item.track) found.push({ line: item.line, track: item.track });
    else missing.push({ line: item.line, artist: item.artist, title: item.title });
  }
  return { found, missing };
}
