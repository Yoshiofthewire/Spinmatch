import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = '/tmp/spinmatch-lib-test';

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const repo = await import('../../src/services/libraryRepo.js');

let server;
let baseUrl;

test.before(async () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/A/Al/01.mp3', artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/A/Al/02.mp3', artist: 'A', album: 'Al', title: 'Two', durationMs: 2000, changeKey: '2:1' });
  repo.recomputeStats(db);
  setDbForTest(db);
  const { createApp } = await import('../../src/app.js');
  server = createApp({ auth: false }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => {
  setDbForTest(null);
  delete process.env.MUSIC_DIR;
  server.close();
});

test('GET /api/library/stats returns the collection summary', async () => {
  const res = await fetch(`${baseUrl}/api/library/stats`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totalTracks, 2);
  assert.equal(body.totalArtists, 1);
  assert.equal(body.totalAlbums, 1);
});

test('GET /api/library/tracks filters by album', async () => {
  const res = await fetch(`${baseUrl}/api/library/tracks?artist=A&album=Al`);
  const body = await res.json();
  assert.equal(body.tracks.length, 2);
  assert.equal(body.tracks[0].title, 'One');
});

test('GET /api/library/artists lists artists with counts', async () => {
  const res = await fetch(`${baseUrl}/api/library/artists`);
  const body = await res.json();
  assert.deepEqual(body.artists, [{ artist: 'A', trackCount: 2 }]);
});
