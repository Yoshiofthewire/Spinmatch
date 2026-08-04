import { getDb } from '../lib/db.js';
import { makeMatchKey, makeTitleKey } from '../lib/normalize.js';
import { listTracks } from './libraryRepo.js';
import { preferBest } from './playlistRepo.js';
import { collectNeighbours, resolveSeedArtists } from './libraryDiscovery.js';
import { getTopRecordings } from './listenBrainz.js';
import { filterByDuration, fillPlaylist, MIN_DURATION_MS, MAX_DURATION_MS } from './playlistFill.js';

// Turns "music like this" into "tracks you own like this".
//
// The glue, and the only place in the playlist feature that does both network
// and database work — which is precisely why playlistFill does neither.

// How many neighbours to pull tracks from. Each one costs a popularity lookup
// through the shared rate limiter, so this is the knob that decides whether a
// suggestion takes a second or half a minute.
const MAX_NEIGHBOURS = 12;

function ownedTracksFor(db, artist) {
  const { tracks } = listTracks(db, { artist, limit: 500 });
  return tracks;
}

// Match a popularity entry to a file by the same folded title the rest of the
// feature resolves on, so "Teardrop (Remastered)" on disk still finds "Teardrop"
// in the list.
function rankTracks(tracks, topRecordings) {
  if (!topRecordings) return tracks.map((t) => ({ ...t, popularityRank: null }));
  const rankByTitle = new Map();
  topRecordings.forEach((rec, i) => {
    const key = makeTitleKey(rec.name);
    if (!rankByTitle.has(key)) rankByTitle.set(key, i);
  });
  return tracks.map((t) => ({
    ...t,
    popularityRank: rankByTitle.get(makeTitleKey(t.title)) ?? null,
  }));
}

// Owning two copies of a recording is normal — preferBest exists precisely
// because "you own the album and a greatest-hits copy" is the expected case —
// and listTracks returns both. existingKeys dedups the pool against the
// playlist but nothing deduped it against itself, so under Popular the two
// copies took the same popularityRank (rankTracks folds on titleKey), sorted
// adjacent, and were both proposed: duplicate React keys in the review table,
// two identical rows added, and the same file copied twice by the export.
//
// preferBest is playlistRepo's, deliberately. No album is named here — nothing
// asked for a particular pressing — so this comes down to its size tie-break,
// which is the same answer resolveItems would give the item once it is in the
// playlist.
function dedupeByMatchKey(pool) {
  const byKey = new Map();
  for (const track of pool) {
    const seen = byKey.get(track.matchKey);
    // Map.set on an existing key keeps its original insertion position, so a
    // later, better copy doesn't jump the pool's ordering.
    byKey.set(track.matchKey, seen ? preferBest([seen, track], null) : track);
  }
  return [...byKey.values()];
}

/**
 * Propose tracks for a playlist. Writes nothing — that is the review step.
 */
export async function suggestTracks(db = getDb(), {
  seedArtists,
  method = 'popular',
  target = 50,
  byteBudget = null,
  preferPopular = false,
  minMs = MIN_DURATION_MS,
  maxMs = MAX_DURATION_MS,
  existingKeys = new Set(),
} = {}) {
  const seeds = await resolveSeedArtists(db, seedArtists);
  const { artists: neighbours, listenBrainz } = await collectNeighbours(db, {
    seeds, excludeOwned: false, limit: MAX_NEIGHBOURS,
  });

  // Chance without prefer-popular never reads popularityRank — orderFor
  // shuffles — so asking for it cost up to MAX_NEIGHBOURS requests through the
  // shared rate limiter for a number nothing would look at. That is every
  // Chance suggestion and every Reshuffle, against an endpoint that is
  // currently answering 500 and whose nulls are deliberately not cached.
  const usesPopularity = method === 'popular' || preferPopular;

  let anyPopularity = false;
  let pool = [];

  for (const neighbour of neighbours) {
    const owned = filterByDuration(ownedTracksFor(db, neighbour.name), { minMs, maxMs });
    if (!owned.length) continue;

    // Null here is the live steady state: the popularity API is disabled
    // upstream. It degrades to a chronological ordering inside playlistFill
    // rather than failing the suggestion.
    const top = usesPopularity ? await getTopRecordings(neighbour.mbid) : null;
    if (top !== null) anyPopularity = true;

    pool = pool.concat(rankTracks(owned, top).map((t) => ({
      ...t,
      matchKey: makeMatchKey(t.artist, t.title),
      signalScore: neighbour.score,
      seedArtist: neighbour.via[0] ?? null,
    })));
  }

  const { picked, cap, stopped } = fillPlaylist({
    pool: dedupeByMatchKey(pool), target, byteBudget, method, preferPopular, existingKeys,
  });

  return {
    picked,
    cap,
    stopped,
    // Reported so the UI can say the fill ran on a thinner signal than usual,
    // the way the Discover tab already does for ListenBrainz.
    neighbours: neighbours.map((n) => ({ name: n.name, via: n.via, kind: n.kind })),
    // Three values, not two. 'unavailable' is a claim about the upstream
    // endpoint, and reporting it for a fill that never asked would put
    // "ListenBrainz popularity is unavailable" in front of a user whose
    // ordering never wanted it — a false note whether or not the endpoint is
    // up. 'unused' says what happened; the UI shows nothing for it.
    popularity: usesPopularity ? (anyPopularity ? 'ok' : 'unavailable') : 'unused',
    listenBrainz,
  };
}
