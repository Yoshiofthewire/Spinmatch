import { getDb } from '../lib/db.js';
import { collectionKeys, getStats } from './libraryRepo.js';
import { normalizeTitle } from '../lib/normalize.js';

// "Do I already own this?" for MusicBrainz search results. Entirely offline —
// one SQL pass over the index, no upstream calls — so the badge never slows a
// search down or breaks when MusicBrainz is unreachable.

function key(artist, name) {
  return `${normalizeTitle(artist ?? '')}|${normalizeTitle(name ?? '')}`;
}

// Rebuilt only when a scan has changed the library, since normalizing every
// album and title in a 16k-track index on each search would be wasted work.
let cache = null;

function keySets(db) {
  const { lastScanAt, totalTracks } = getStats(db);
  const stamp = `${lastScanAt}:${totalTracks}`;
  if (cache?.stamp === stamp) return cache;

  const { albums, recordings } = collectionKeys(db);
  cache = {
    stamp,
    albums: new Set(albums.map((r) => key(r.artist, r.name))),
    recordings: new Set(recordings.map((r) => key(r.artist, r.name))),
  };
  return cache;
}

// Takes the items a page is showing and returns the ids of the ones already in
// the library, so the caller doesn't have to care how matching is done.
// Matching folds case, punctuation and parenthetical suffixes via
// normalizeTitle, so "Kid A (Deluxe Edition)" on disk counts as owning "Kid A".
export function checkOwned({ albums = [], recordings = [] }, { db = getDb() } = {}) {
  const sets = keySets(db);
  const owned = (list, set) => list
    .filter((item) => item?.id && set.has(key(item.artist, item.title)))
    .map((item) => item.id);
  return {
    albums: owned(albums, sets.albums),
    recordings: owned(recordings, sets.recordings),
  };
}

// Test seam: the cache is keyed on scan state, which an in-memory test DB
// reuses across cases.
export function resetOwnedCacheForTest() {
  cache = null;
}
