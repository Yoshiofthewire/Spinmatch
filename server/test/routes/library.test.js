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
  assert.deepEqual(body.artists, [{
    artist: 'A', trackCount: 2, albumCount: 1, totalDurationMs: 3000,
  }]);
});

test('GET /api/library/tracks reports the total alongside the page', async () => {
  const res = await fetch(`${baseUrl}/api/library/tracks?limit=1`);
  const body = await res.json();
  assert.equal(body.tracks.length, 1);
  assert.equal(body.total, 2);
  assert.equal(body.limit, 1);
});

test('GET /api/library/tracks searches across title, artist and album', async () => {
  const res = await fetch(`${baseUrl}/api/library/tracks?q=Two`);
  const body = await res.json();
  assert.equal(body.total, 1);
  assert.equal(body.tracks[0].title, 'Two');
});

test('an unknown sort key falls back to the default instead of erroring', async () => {
  const res = await fetch(`${baseUrl}/api/library/tracks?sort=' OR 1=1--`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).total, 2);
});

test('GET /api/library/health-tracks returns the tracks behind a count', async () => {
  const res = await fetch(`${baseUrl}/api/library/health-tracks?issue=missingTrackNumber`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 2, 'neither seeded track has a number');
  assert.ok(body.tracks[0].path);
});

test('GET /api/library/health-tracks rejects an issue key it does not know', async () => {
  // The key selects a SQL predicate, so an unknown one must be refused rather
  // than falling through to an unfiltered query.
  const res = await fetch(`${baseUrl}/api/library/health-tracks?issue=1=1`);
  assert.equal(res.status, 400);
});

test('GET /api/library/duplicates returns each copy of a duplicated title', async () => {
  const res = await fetch(`${baseUrl}/api/library/duplicates`);
  assert.equal(res.status, 200);
  // The two seeded tracks have different titles, so there is nothing to report.
  assert.deepEqual((await res.json()).groups, []);
});

test('POST /api/library/owned reports which results are already in the library', async () => {
  const res = await fetch(`${baseUrl}/api/library/owned`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      albums: [
        { id: 'rg-have', artist: 'A', title: 'Al' },
        { id: 'rg-want', artist: 'A', title: 'Nope' },
      ],
    }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).albums, ['rg-have']);
});

test('POST /api/library/owned caps how many items one request can ask about', async () => {
  const albums = Array.from({ length: 501 }, (_, i) => ({ id: `x${i}`, artist: 'A', title: 'Al' }));
  const res = await fetch(`${baseUrl}/api/library/owned`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ albums }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/library/rescan requires an artist or album', async () => {
  const res = await fetch(`${baseUrl}/api/library/rescan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('POST /api/library/rescan 404s when nothing indexed matches', async () => {
  const res = await fetch(`${baseUrl}/api/library/rescan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ artist: 'Nobody' }),
  });
  assert.equal(res.status, 404);
});

test('POST /api/library/fix requires both a track and a recording', async () => {
  const res = await fetch(`${baseUrl}/api/library/fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ trackId: 1 }),
  });
  assert.equal(res.status, 400);
});
