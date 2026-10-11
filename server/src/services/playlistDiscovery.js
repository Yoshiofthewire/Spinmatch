import { getDb } from '../lib/db.js';
import { makeMatchKey, makeTitleKey } from '../lib/normalize.js';
import { listTracks } from './libraryRepo.js';
import { preferBest } from './playlistRepo.js';
import { collectNeighbours, resolveSeedArtists } from './libraryDiscovery.js';
import { getTopRecordings } from './listenBrainz.js';
import { filterByDuration, fillPlaylist, MIN_DURATION_MS, MAX_DURATION_MS } from './playlistFill.js';

// Turns "music like this" into "tracks you own like this": the network/DB glue
// around the pure playlistFill.

// Each neighbour costs a rate-limited popularity lookup; this bounds suggestion latency.
const MAX_NEIGHBOURS = 12;

function ownedTracksFor(db, artist) {
  const { tracks } = listTracks(db, { artist, limit: 500 });
  return tracks;
}

// Folded title match, so "Teardrop (Remastered)" finds "Teardrop".
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

// Owning two copies of a recording is normal; keep the one resolveItems would pick.
function dedupeByMatchKey(pool) {
  const byKey = new Map();
  for (const track of pool) {
    const seen = byKey.get(track.matchKey);
    // Map.set on an existing key keeps its insertion position, preserving pool order.
    byKey.set(track.matchKey, seen ? preferBest([seen, track], null) : track);
  }
  return [...byKey.values()];
}

// Proposes tracks; writes nothing (the user reviews first).
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

  // Plain Chance never reads popularityRank, so skip the rate-limited lookups.
  const usesPopularity = method === 'popular' || preferPopular;

  let anyPopularity = false;
  let pool = [];

  for (const neighbour of neighbours) {
    const owned = filterByDuration(ownedTracksFor(db, neighbour.name), { minMs, maxMs });
    if (!owned.length) continue;

    // Currently always null (API disabled upstream); playlistFill falls back to chronological.
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
    neighbours: neighbours.map((n) => ({ name: n.name, via: n.via, kind: n.kind })),
    // 'unused' when never asked, so the UI doesn't claim the endpoint is down.
    popularity: usesPopularity ? (anyPopularity ? 'ok' : 'unavailable') : 'unused',
    listenBrainz,
  };
}
