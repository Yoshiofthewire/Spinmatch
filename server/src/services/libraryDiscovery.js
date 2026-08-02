import { getDb } from '../lib/db.js';
import { listArtists, listArtistNames, listTracks } from './libraryRepo.js';
import { resolveArtist } from './libraryDiscography.js';
import { getRelatedArtists, browseReleaseGroupsByArtist } from './musicbrainz.js';
import { getSimilarArtists as fetchSimilar } from './listenBrainz.js';
import { config } from '../config.js';
import { normalizeTitle } from '../lib/normalize.js';

// Discovery: music you don't have, reached from music you do.
//
// The inverse of everything else in the library, which is all about finding
// holes in records you already know about. The spec's original plan derived this
// from a verified_tracks table that was dropped as unused, so the seed here is
// the collection itself — the artists you own the most of.
//
// Two signals, deliberately kept distinct all the way to the UI because they
// answer different questions:
//
//   similar  - ListenBrainz. Whose listeners overlap with yours. The "sounds
//              like" signal, derived from real listening sessions.
//   related  - MusicBrainz. Who played in which band, who collaborated with
//              whom. Factual, not sonic: it finds side projects and members'
//              other bands, which listening data ranks poorly or not at all.
//
// Blending them into one list would lose that distinction and make a documented
// band-member link indistinguishable from a statistical one, so an artist found
// by both is marked 'both' rather than merged into an average.
//
// Both are MetaBrainz, both keyed on the same artist MBIDs, neither needs an API
// key. ListenBrainz lives on an explicitly experimental subdomain, so its
// absence is a supported state: discovery degrades to the relationship graph
// alone and says so, rather than breaking.

// How many of your artists seed a run. Each unresolved one costs a MusicBrainz
// search and each resolved one a relations lookup, all through the same 1-req/s
// queue, so this is the knob that decides whether discovery takes five seconds
// or a minute. Ten is enough to find overlap between seeds, which is what makes
// the ranking mean anything.
const SEED_ARTISTS = 10;
// Cached relations stand for a month: band membership is close to static, and a
// stale edge costs nothing worse than a suggestion you've already seen.
const RELATIONS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// How many discovered artists get their discography fetched for recommendations.
// Deliberately small — this is one more rate-limited call each.
const RECOMMEND_ARTISTS = 5;
// How far down each seed's ListenBrainz list to look. It returns 100; ten seeds'
// worth of long tails would bury the artists that several seeds agree on.
const SIMILAR_PER_SEED = 25;

// Artist names for the "do I already have them" check.
//
// normalizeTitle on its own isn't enough here: it folds case and punctuation but
// keeps a leading article, so "The Beatles" and "Beatles" read as two different
// artists. Everywhere else that's harmless, but here it produces the one result
// this filter exists to prevent — suggesting someone you already own. Kept local
// rather than pushed into normalizeTitle, which gap detection and the ownership
// badges also use and where dropping an article would create false matches
// between genuinely different acts ("The Church" and "Church").
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
    // Rows written before ListenBrainz was added hold a bare array of related
    // artists. Treated as a miss rather than migrated: this is a cache, and
    // refetching costs one lookup, where a migration would cost a schema change.
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

// Both signals for one seed, cached together.
//
// `related` is the MusicBrainz relationship graph: who played in which band, who
// collaborated with whom. `similar` is ListenBrainz: whose listeners overlap.
// They answer genuinely different questions — "the same people made this" versus
// "this sounds like that" — so they're kept apart all the way to the UI rather
// than blended into one undifferentiated list.
//
// A ListenBrainz outage yields null, not []. That distinction is the whole
// degrade path: null means "don't remember this, ask again", so a blip can't be
// cached as "this artist has no similar artists" for a month.
async function signalsFor(db, mbArtistId) {
  const cached = readCache(db, mbArtistId);
  if (cached) return cached;

  const [related, similar] = await Promise.all([
    getRelatedArtists(mbArtistId),
    fetchSimilar(mbArtistId),
  ]);

  const signals = { related, similar: similar ?? [] };
  // Only cache when ListenBrainz actually answered. Otherwise the MusicBrainz
  // half would be frozen alongside an empty ListenBrainz half for the full TTL.
  if (similar !== null) writeCache(db, mbArtistId, signals);
  return signals;
}

// The artists a run starts from: whoever you own the most of. Only those already
// resolvable to a MusicBrainz id are used — resolveArtist caches both hits and
// misses, so this doesn't re-search an unresolvable name on every visit.
async function seedArtists(db, limit) {
  const { artists } = listArtists(db, { sort: 'tracks', limit });
  const seeds = [];
  for (const row of artists) {
    const { mbArtistId } = await resolveArtist(row.artist, { db });
    if (mbArtistId) seeds.push({ ...row, mbArtistId });
  }
  return seeds;
}

// One run at a time per distinct request, shared by everyone waiting on it.
//
// A discovery run is ten seeds walked through a 1-req/s queue, so it takes tens
// of seconds and nothing about it is per-user. Without this, an impatient
// refresh queued a second identical run behind the first, a third behind that,
// and the request the user was actually waiting on sat at the back — each one
// still running after its socket was long gone, because none of them are
// cancellable mid-queue. Sharing the promise makes the extra clicks free, and
// means the one run that does happen still finishes and populates the DB cache
// even if every caller has walked away.
const inFlight = new Map();

function shared(key, run) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/**
 * Artists connected to the ones you own most of, ranked by how many of them
 * point at the same name.
 *
 * @returns {Promise<{seeds: object[], artists: object[]}>}
 */
export function getSimilarArtists({ db = getDb(), limit = 30 } = {}) {
  return shared(`similar:${limit}`, () => computeSimilarArtists({ db, limit }));
}

/**
 * The artists a caller-supplied list of seeds points at, ranked by how many of
 * them agree.
 *
 * `excludeOwned` is the CALLER'S policy, not this function's behaviour, and that
 * is the whole point of the split. The Discover tab wants music you don't have,
 * so it passes true. A playlist wants the opposite — the neighbours you own are
 * exactly the ones it can put on a device — so it passes false. One walk of the
 * signals, one cache, two meanings.
 *
 * @returns {Promise<{artists: object[], listenBrainz: 'ok'|'unavailable'|'disabled'}>}
 */
export async function collectNeighbours(db, { seeds, excludeOwned = true, limit = 30 }) {
  // Everything already on disk, so discovery never suggests what you have.
  // Compared on artistKey, which also drops a leading article — see the note
  // there for why that folding is local to discovery. Null when the caller
  // wants the owned artists kept, so the filter isn't merely bypassed but
  // never built.
  const owned = excludeOwned ? new Set(listArtistNames(db).map(artistKey)) : null;

  const found = new Map();
  let listenBrainzAnswered = false;

  // Records one seed pointing at one candidate. `kind` accumulates: an artist
  // reached by both signals is a stronger suggestion than one reached by either,
  // and the UI says which.
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
      // Position in the seed's own list. ListenBrainz scores are raw
      // co-occurrence counts that scale with how popular the seed is, so they
      // aren't comparable between seeds — position is.
      bestRank: rank,
      // Which of your artists led here. This is what makes a suggestion
      // explicable rather than an oracle's pronouncement.
      via: [seed.artist],
      score: 1,
    });
  }

  for (const seed of seeds) {
    const { related, similar } = await signalsFor(db, seed.mbArtistId);
    if (similar.length) listenBrainzAnswered = true;

    related.forEach((a, i) => note(a, seed, 'related', i));
    // Only the top of each similar list. ListenBrainz returns 100 per seed, and
    // ten seeds' worth of long tails would swamp the ranking with artists that
    // one seed mentioned once.
    similar.slice(0, SIMILAR_PER_SEED).forEach((a, i) => note(a, seed, 'similar', i));
  }

  const artists = [...found.values()]
    .map(({ kinds, ...rest }) => ({
      ...rest,
      // 'both' is the strongest signal there is here: listeners overlap AND
      // there's a documented connection.
      kind: kinds.size > 1 ? 'both' : [...kinds][0],
    }))
    .sort((a, b) => (
      b.score - a.score
      // A tie on seed count breaks toward whichever ranked higher in its own
      // list, then alphabetically so the order is stable between calls.
      || a.bestRank - b.bestRank
      || a.name.localeCompare(b.name)
    ))
    .slice(0, limit);

  return {
    artists,
    // Lets the UI say discovery is running on half its signal rather than
    // silently showing thinner results.
    listenBrainz: config.discovery.listenBrainzEnabled
      ? (listenBrainzAnswered ? 'ok' : 'unavailable')
      : 'disabled',
  };
}

/**
 * Seeds from names the caller supplies rather than from the top of the
 * collection. Exported so a playlist can start from an artist the user picked;
 * seedArtists stays private because only discovery wants "whoever you own most
 * of", and only it needs the trackCount those rows carry.
 */
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

/**
 * Albums to go and listen to: the studio discographies of the top few
 * discovered artists, minus anything already on disk.
 */
export function getRecommendations({ db = getDb(), limit = 24 } = {}) {
  return shared(`recommendations:${limit}`, () => computeRecommendations({ db, limit }));
}

async function computeRecommendations({ db, limit }) {
  // Goes through getSimilarArtists rather than computeSimilarArtists so it
  // shares a run with a concurrent /similar-artists request for the same limit
  // instead of starting a second walk of the same seeds.
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
 * Playlist reconstruction: given remembered track names, what you already have
 * and what you'd need to find.
 *
 * Entirely offline. Each line is matched against the index on the same
 * normalization ownership uses, and "Artist - Title" is split when present
 * because that's how anyone pastes a playlist.
 *
 * @param {string[]} lines
 */
export function reconstructPlaylist(lines, { db = getDb() } = {}) {
  const found = [];
  const missing = [];

  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;

    // "Artist - Title" is the common paste format; a line without a dash is
    // treated as a title alone rather than guessed at.
    const split = line.match(/^(.*?)\s+[-–—]\s+(.*)$/);
    const artist = split ? split[1].trim() : null;
    const title = split ? split[2].trim() : line;

    // One indexed query per line, on the title, then narrowed here — searching
    // on the whole line would miss every entry whose separator differs.
    const { tracks } = listTracks(db, { q: title, limit: 25 });
    const wanted = normalizeTitle(title);
    const match = tracks.find((t) => normalizeTitle(t.title) === wanted
      && (!artist || normalizeTitle(t.artist ?? '') === normalizeTitle(artist)))
      ?? tracks.find((t) => normalizeTitle(t.title) === wanted);

    if (match) found.push({ line, track: match });
    else missing.push({ line, artist, title });
  }

  return { found, missing };
}
