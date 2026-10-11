import { getDb } from '../lib/db.js';
import { collectionKeys, getStats } from './libraryRepo.js';
import { normalizeTitle } from '../lib/normalize.js';

// "Do I already own this?" for search results. Offline: one SQL pass, no upstream calls.

function key(artist, name) {
  return `${normalizeTitle(artist ?? '')}|${normalizeTitle(name ?? '')}`;
}

// Rebuilt only when a scan changed the library.
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

// Ids of owned items. Folds via normalizeTitle: "Kid A (Deluxe Edition)" owns "Kid A".
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

// Test seam: in-memory test DBs reuse scan state across cases.
export function resetOwnedCacheForTest() {
  cache = null;
}
