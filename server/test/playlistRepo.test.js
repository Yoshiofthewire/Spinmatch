import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');
const pl = await import('../src/services/playlistRepo.js');

function seeded() {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/P/Dummy/01.flac', artist: 'Portishead', album: 'Dummy', title: 'Mysterons', durationMs: 305000, sizeBytes: 30, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/P/Dummy/02.flac', artist: 'Portishead', album: 'Dummy', title: 'Roads (Remastered)', durationMs: 302000, sizeBytes: 40, changeKey: '2:1' });
  repo.upsertLocalTrack(db, { path: '/m/P/Best/09.mp3', artist: 'Portishead', album: 'Best Of', title: 'Roads', durationMs: 302000, sizeBytes: 10, changeKey: '3:1' });
  return db;
}

test('an item resolves to a track through the normalized key', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'Road Trip' });
  pl.addItems(db, id, [{ artist: 'Portishead', title: 'Mysterons', source: 'manual' }]);
  const { items } = pl.getPlaylist(db, id);
  assert.equal(items.length, 1);
  assert.equal(items[0].track.path, '/m/P/Dummy/01.flac');
  db.close();
});

test('a bracketed suffix on disk still matches a plain title', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [{ artist: 'Portishead', title: 'Roads', album: 'Dummy', source: 'manual' }]);
  const { items } = pl.getPlaylist(db, id);
  assert.equal(items[0].track.path, '/m/P/Dummy/02.flac', 'the album should break the tie');
  db.close();
});

test('with no album to break the tie the largest file wins', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [{ artist: 'Portishead', title: 'Roads', source: 'manual' }]);
  const { items } = pl.getPlaylist(db, id);
  assert.equal(items[0].track.sizeBytes, 40);
  db.close();
});

test('an artist that disagrees still resolves on title alone', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [{ artist: 'Portishead Feat Nobody', title: 'Mysterons', source: 'paste' }]);
  const { items } = pl.getPlaylist(db, id);
  assert.equal(items[0].track.title, 'Mysterons');
  db.close();
});

test('an unmatched item is a gap, not an error', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [{ artist: 'Tricky', title: 'Aftermath', source: 'paste' }]);
  const { items } = pl.getPlaylist(db, id);
  assert.equal(items[0].track, null);
  assert.equal(items[0].title, 'Aftermath');
  db.close();
});

test('the same track may appear twice', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [
    { artist: 'Portishead', title: 'Mysterons', source: 'manual' },
    { artist: 'Portishead', title: 'Mysterons', source: 'manual' },
  ]);
  assert.equal(pl.getPlaylist(db, id).items.length, 2);
  db.close();
});

test('names are unique case-insensitively', () => {
  const db = seeded();
  pl.createPlaylist(db, { name: 'Road Trip' });
  assert.throws(() => pl.createPlaylist(db, { name: 'road trip' }));
  db.close();
});

test('reorder renumbers positions contiguously', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [
    { artist: 'Portishead', title: 'Mysterons', source: 'manual' },
    { artist: 'Portishead', title: 'Roads', source: 'manual' },
  ]);
  const before = pl.getPlaylist(db, id).items;
  pl.reorderItems(db, id, [before[1].id, before[0].id]);
  const after = pl.getPlaylist(db, id).items;
  assert.deepEqual(after.map((i) => i.position), [0, 1]);
  assert.equal(after[0].id, before[1].id);
  db.close();
});

test('deleting a playlist takes its items with it', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [{ artist: 'Portishead', title: 'Mysterons', source: 'manual' }]);
  pl.deletePlaylist(db, id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM playlist_items').get().n, 0);
  db.close();
});

test('the summary counts gaps and sums only what resolved', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [
    { artist: 'Portishead', title: 'Mysterons', source: 'manual' },
    { artist: 'Tricky', title: 'Aftermath', source: 'paste' },
  ]);
  const [row] = pl.listPlaylists(db);
  assert.equal(row.itemCount, 2);
  assert.equal(row.gapCount, 1);
  assert.equal(row.totalBytes, 30);
  db.close();
});
