import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');
const { checkOwned, resetOwnedCacheForTest } = await import('../src/services/libraryOwned.js');

function dbWith(tracks) {
  const db = openDb(':memory:');
  tracks.forEach((t, i) => repo.upsertLocalTrack(db, {
    path: `/m/${i}.mp3`, durationMs: 1000, changeKey: `${i}:1`, ...t,
  }));
  repo.recomputeStats(db);
  resetOwnedCacheForTest();
  return db;
}

test('an owned album is reported by id', () => {
  const db = dbWith([{ artist: 'Radiohead', album: 'Kid A', title: 'Idioteque' }]);
  const result = checkOwned({
    albums: [
      { id: 'rg-1', artist: 'Radiohead', title: 'Kid A' },
      { id: 'rg-2', artist: 'Radiohead', title: 'Amnesiac' },
    ],
  }, { db });
  assert.deepEqual(result.albums, ['rg-1']);
  db.close();
});

test('a parenthetical local edition still counts as owned', () => {
  // Same normalizeTitle folding the discography diff relies on: the edition
  // suffix on disk must not read as "you do not have this album".
  const db = dbWith([{ artist: 'Radiohead', album: 'Kid A (Deluxe Edition)', title: 'Idioteque' }]);
  const result = checkOwned({ albums: [{ id: 'rg-1', artist: 'Radiohead', title: 'Kid A' }] }, { db });
  assert.deepEqual(result.albums, ['rg-1']);
  db.close();
});

test('recordings are matched separately from albums', () => {
  const db = dbWith([{ artist: 'Radiohead', album: 'Kid A', title: 'Idioteque' }]);
  const result = checkOwned({
    albums: [{ id: 'rg-1', artist: 'Radiohead', title: 'Idioteque' }],
    recordings: [
      { id: 'rec-1', artist: 'Radiohead', title: 'Idioteque' },
      { id: 'rec-2', artist: 'Radiohead', title: 'Creep' },
    ],
  }, { db });
  // "Idioteque" is a track, not an album, so it must not badge as an owned album.
  assert.deepEqual(result.albums, []);
  assert.deepEqual(result.recordings, ['rec-1']);
  db.close();
});

test('a different artist with the same album title is not owned', () => {
  const db = dbWith([{ artist: 'Radiohead', album: 'Kid A', title: 'Idioteque' }]);
  const result = checkOwned({ albums: [{ id: 'rg-1', artist: 'Someone Else', title: 'Kid A' }] }, { db });
  assert.deepEqual(result.albums, []);
  db.close();
});

test('items without an id are ignored rather than matched', () => {
  const db = dbWith([{ artist: 'Radiohead', album: 'Kid A', title: 'Idioteque' }]);
  const result = checkOwned({ albums: [{ artist: 'Radiohead', title: 'Kid A' }] }, { db });
  assert.deepEqual(result.albums, []);
  db.close();
});

test('the key cache is invalidated when the library changes', () => {
  const db = dbWith([{ artist: 'Radiohead', album: 'Kid A', title: 'Idioteque' }]);
  const ask = () => checkOwned({ albums: [{ id: 'rg', artist: 'Radiohead', title: 'Amnesiac' }] }, { db });
  assert.deepEqual(ask().albums, []);

  repo.upsertLocalTrack(db, {
    path: '/m/new.mp3', artist: 'Radiohead', album: 'Amnesiac', title: 'Pyramid Song',
    durationMs: 1000, changeKey: 'n:1',
  });
  repo.recomputeStats(db);
  assert.deepEqual(ask().albums, ['rg'], 'a newly added album should be seen without a restart');
  db.close();
});
