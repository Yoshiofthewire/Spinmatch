// server/test/libraryRepo.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

function seeded() {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/A/Album/01.mp3', artist: 'A', album: 'Album', title: 'One', durationMs: 1000, changeKey: '10:1' });
  repo.upsertLocalTrack(db, { path: '/m/A/Album/02.mp3', artist: 'A', album: 'Album', title: 'Two', durationMs: 2000, changeKey: '20:1' });
  repo.upsertLocalTrack(db, { path: '/m/B/Other/01.mp3', artist: 'B', album: 'Other', title: 'Solo', durationMs: 3000, changeKey: '30:1' });
  repo.recomputeStats(db);
  return db;
}

test('stats reflect distinct artists and albums', () => {
  const db = seeded();
  assert.deepEqual(repo.getStats(db), {
    totalTracks: 3, totalAlbums: 2, totalArtists: 2, lastScanAt: repo.getStats(db).lastScanAt,
  });
  assert.ok(repo.getStats(db).lastScanAt > 0);
  db.close();
});

test('upsert on the same path updates rather than duplicates', () => {
  const db = seeded();
  repo.upsertLocalTrack(db, { path: '/m/A/Album/01.mp3', artist: 'A', album: 'Album', title: 'One (remaster)', durationMs: 1100, changeKey: '11:2' });
  repo.recomputeStats(db);
  assert.equal(repo.getStats(db).totalTracks, 3);
  const [t] = repo.listTracks(db, { artist: 'A', album: 'Album' }).filter((r) => r.path.endsWith('01.mp3'));
  assert.equal(t.title, 'One (remaster)');
  db.close();
});

test('markRemoved drops rows absent from the keep set and stats update', () => {
  const db = seeded();
  repo.markRemoved(db, new Set(['/m/A/Album/01.mp3', '/m/A/Album/02.mp3']));
  repo.recomputeStats(db);
  const stats = repo.getStats(db);
  assert.equal(stats.totalTracks, 2);
  assert.equal(stats.totalArtists, 1);
  db.close();
});

test('hasRecording matches artist+title case-insensitively, ignoring removed rows', () => {
  const db = seeded();
  assert.equal(repo.hasRecording(db, { artist: 'a', title: 'one' }), true);
  assert.equal(repo.hasRecording(db, { artist: 'A', title: 'Nope' }), false);
  repo.markRemoved(db, new Set(['/m/A/Album/01.mp3', '/m/B/Other/01.mp3']));
  assert.equal(repo.hasRecording(db, { artist: 'A', title: 'Two' }), false);
  db.close();
});

test('getChangeKeys returns path->key for live rows only', () => {
  const db = seeded();
  repo.markRemoved(db, new Set(['/m/A/Album/01.mp3']));
  const keys = repo.getChangeKeys(db);
  assert.equal(keys.get('/m/A/Album/01.mp3'), '10:1');
  assert.equal(keys.has('/m/B/Other/01.mp3'), false);
  db.close();
});
