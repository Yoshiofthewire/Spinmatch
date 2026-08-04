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
  // 'The Portishead' folds to 'the portishead', which differs from the file's
  // 'portishead' — so this misses pass 1 (match_key) and must fall through to
  // pass 2 (title_key) to resolve at all.
  pl.addItems(db, id, [{ artist: 'The Portishead', title: 'Mysterons', source: 'paste' }]);
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

test('an item with no artist at all still resolves, through title_key', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  // No 'artist' key at all, not just an empty string — addItems' `item.artist
  // ?? null` covers both, but matchKey then folds to the empty-artist form
  // ('mysterons'), which cannot match a real track's match_key. Only
  // the title_key fallback pass can resolve this.
  pl.addItems(db, id, [{ title: 'Mysterons', source: 'paste' }]);
  const { items } = pl.getPlaylist(db, id);
  assert.equal(items[0].artist, null);
  assert.equal(items[0].track.title, 'Mysterons');
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

test('reorder with a partial itemIds list loses nothing', () => {
  // The doc comment on reorderItems claims the unmentioned rows "keep their
  // relative order at the end" — but `rest` is built from a plain
  // `SELECT id FROM playlist_items WHERE playlist_id = ?` with no ORDER BY,
  // so that ordering is not actually guaranteed by SQL semantics; it just
  // happens to come back in a stable order under SQLite's current query
  // plan for this table shape. The guarantee this test pins is the one the
  // code actually enforces: every row the caller didn't mention survives the
  // reorder. It does not assert the relative-order claim, because the query
  // gives it nothing to stand on.
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [
    { artist: 'Portishead', title: 'Mysterons', source: 'manual' },
    { artist: 'Portishead', title: 'Roads', album: 'Dummy', source: 'manual' },
    { artist: 'Portishead', title: 'Roads', album: 'Best Of', source: 'manual' },
  ]);
  const before = pl.getPlaylist(db, id).items;
  const beforeIds = new Set(before.map((i) => i.id));

  // Only the last item is mentioned; the other two are never named.
  pl.reorderItems(db, id, [before[2].id]);

  const after = pl.getPlaylist(db, id).items;
  assert.equal(after.length, 3, 'no item was dropped by being left unmentioned');
  assert.deepEqual(new Set(after.map((i) => i.id)), beforeIds);
  assert.equal(after[0].id, before[2].id, 'the mentioned item leads');
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
