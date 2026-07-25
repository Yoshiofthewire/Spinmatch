import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = '/tmp/spinmatch-lib-test';

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const repo = await import('../../src/services/libraryRepo.js');

let server;
let baseUrl;
let db;

test.before(async () => {
  db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/A/Al/01.mp3', artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/A/Al/02.mp3', artist: 'A', album: 'Al', title: 'Two', durationMs: 2000, changeKey: '2:1' });
  repo.recomputeStats(db);
  setDbForTest(db);
  const { createApp } = await import('../../src/app.js');
  server = createApp({ gate: (req, res, next) => next() }).listen(0);
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
  const empty = await fetch(`${baseUrl}/api/library/duplicates`);
  assert.equal(empty.status, 200);
  // The two seeded tracks have different titles, so there is nothing to report.
  assert.deepEqual((await empty.json()).groups, []);

  // A second file of the same track from the same release — the case this view
  // exists for. Marked removed again at the end, because the ~35 other tests in
  // this file assert against the shared fixture's exact counts.
  repo.upsertLocalTrack(db, { path: '/m/A/Al/01.flac', artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '3:1', ext: 'flac' });
  try {
    const res = await fetch(`${baseUrl}/api/library/duplicates`);
    assert.equal(res.status, 200);
    const { groups } = await res.json();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].artist, 'A');
    assert.equal(groups[0].album, 'Al');
    assert.equal(groups[0].title, 'One');
    assert.deepEqual(
      groups[0].copies.map((c) => c.path).sort(),
      ['/m/A/Al/01.flac', '/m/A/Al/01.mp3'],
    );
  } finally {
    repo.markRemovedByPath(db, '/m/A/Al/01.flac');
  }

  // The cleanup above is what keeps the shared fixture intact for the rest of
  // this file. Prove it here rather than relying on a later test to notice:
  // node:test runs these in declaration order, and every test that asserts an
  // exact track count is declared above this one.
  const afterCleanup = await fetch(`${baseUrl}/api/library/duplicates`);
  assert.deepEqual((await afterCleanup.json()).groups, []);
});

test('POST /api/library/owned reports which results are already in the library', async () => {
  const res = await fetch(`${baseUrl}/api/library/owned`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      albums: [
        { id: '22222222-2222-4222-8222-222222222222', artist: 'A', title: 'Al' },
        { id: '33333333-3333-4333-8333-333333333333', artist: 'A', title: 'Nope' },
      ],
    }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).albums, ['22222222-2222-4222-8222-222222222222']);
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

test('GET /api/library/artists pages and reports the total', async () => {
  const res = await fetch(`${baseUrl}/api/library/artists?limit=1&offset=0`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.limit, 1);
  assert.equal(typeof body.total, 'number');
  assert.ok(Array.isArray(body.artists));
});

test('GET /api/library/albums pages and reports the total', async () => {
  const res = await fetch(`${baseUrl}/api/library/albums?limit=1`);
  const body = await res.json();
  assert.equal(body.limit, 1);
  assert.equal(body.total, 1);
  assert.equal(body.albums.length, 1);
});

// A limit above the cap is clamped rather than honoured, so one request can't ask
// for the whole table.
test('an oversized ?limit is clamped', async () => {
  const body = await (await fetch(`${baseUrl}/api/library/tracks?limit=100000`)).json();
  assert.equal(body.limit, 200);
});

test('DELETE /api/library/artist-link forgets a remembered match', async () => {
  const { getDb } = await import('../../src/lib/db.js');
  const { saveArtistLink, getArtistLink } = await import('../../src/services/libraryDiscography.js');
  saveArtistLink(getDb(), { artist: 'A', mbArtistId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.ok(getArtistLink(getDb(), 'A'));

  const res = await fetch(`${baseUrl}/api/library/artist-link?artist=A`, {
    method: 'DELETE',
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).cleared, true);
  assert.equal(getArtistLink(getDb(), 'A'), null);
});

test('POST /api/library/fix rejects a recordingMbid that is not a UUID', async () => {
  const res = await fetch(`${baseUrl}/api/library/fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ trackId: 1, recordingMbid: '../artist/evil' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/library/bulk-fix/preview requires an album', async () => {
  const res = await fetch(`${baseUrl}/api/library/bulk-fix/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ artist: 'A' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/library/bulk-fix/preview rejects an unknown source', async () => {
  const res = await fetch(`${baseUrl}/api/library/bulk-fix/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ artist: 'A', album: 'Al', source: 'wherever' }),
  });
  assert.equal(res.status, 400);
});

// This suite's MUSIC_DIR does not exist on disk, which is what an unmounted
// music volume looks like. That has to read as a clear 400 rather than escaping
// as a raw ENOENT 500 from the containment guard.
test('POST /api/library/bulk-fix/preview reports an unreadable MUSIC_DIR', async () => {
  const res = await fetch(`${baseUrl}/api/library/bulk-fix/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ artist: 'A', album: 'Al', source: 'path' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/library/bulk-fix/apply requires a non-empty trackIds array', async () => {
  const res = await fetch(`${baseUrl}/api/library/bulk-fix/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ artist: 'A', album: 'Al', trackIds: [] }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/library/bulk-fix/apply refuses a request over the cap', async () => {
  const { MAX_BULK_FIX } = await import('../../src/services/libraryBulkFix.js');
  const res = await fetch(`${baseUrl}/api/library/bulk-fix/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({
      artist: 'A',
      album: 'Al',
      trackIds: Array.from({ length: MAX_BULK_FIX + 1 }, (_, i) => i + 1),
    }),
  });
  assert.equal(res.status, 400);
});

// Every non-GET /api request goes through sameOriginOnly, so a cross-site POST
// can't reach the tag writer even with a valid session cookie.
test('POST /api/library/bulk-fix/apply is refused cross-site', async () => {
  const res = await fetch(`${baseUrl}/api/library/bulk-fix/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ artist: 'A', album: 'Al', trackIds: [1] }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /cross-site/i);
});

test('POST /api/library/reconstruct-playlist requires a non-empty lines array', async () => {
  const res = await fetch(`${baseUrl}/api/library/reconstruct-playlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ lines: [] }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/library/reconstruct-playlist caps how many lines one request may carry', async () => {
  const res = await fetch(`${baseUrl}/api/library/reconstruct-playlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ lines: Array.from({ length: 501 }, (_, i) => `Track ${i}`) }),
  });
  assert.equal(res.status, 400);
});

// Offline, so this answers from the index with no upstream call — which is what
// makes it usable when MusicBrainz isn't.
test('POST /api/library/reconstruct-playlist matches against the library', async () => {
  const res = await fetch(`${baseUrl}/api/library/reconstruct-playlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ lines: ['A - One', 'Nobody - Nothing'] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.found.length, 1);
  assert.equal(body.found[0].track.title, 'One');
  assert.equal(body.missing.length, 1);
});

// --- Paging bounds -----------------------------------------------------------
//
// `Math.min(Number(limit) || default, MAX_PAGE_SIZE)` reads as a cap and is not
// one: -1 is truthy so it survived the `||`, Math.min then chose it as the
// smaller value, and SQLite treats a negative LIMIT as "no upper bound". Every
// list endpoint would return its entire table for `?limit=-1`, which is exactly
// what MAX_PAGE_SIZE exists to prevent.

test('a negative limit falls back to the default instead of returning everything', async () => {
  const res = await fetch(`${baseUrl}/api/library/tracks?limit=-1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.limit, 100, 'the endpoint default, not the caller-supplied -1');
  assert.ok(body.limit > 0);
});

test('zero, NaN and garbage limits also fall back rather than unbounding the query', async () => {
  for (const limit of ['0', 'abc', '-0.5', '', 'Infinity', '-Infinity']) {
    const res = await fetch(`${baseUrl}/api/library/tracks?limit=${encodeURIComponent(limit)}`);
    const body = await res.json();
    assert.ok(body.limit > 0 && body.limit <= 200, `limit=${limit} produced ${body.limit}`);
  }
});

test('a limit over the cap is still clamped to the cap', async () => {
  const body = await (await fetch(`${baseUrl}/api/library/tracks?limit=100000`)).json();
  assert.equal(body.limit, 200);
});

test('a negative offset is floored at zero', async () => {
  const body = await (await fetch(`${baseUrl}/api/library/tracks?offset=-5`)).json();
  assert.equal(body.offset, 0);
});

// --- Path disclosure ---------------------------------------------------------
//
// paths.js refuses to name the server's directory layout in an error message
// because it "isn't the client's business" — and then every row of every browse
// listing carried the absolute path anyway. The rule now holds where the volume
// actually is; the repair and health flows, whose whole job is identifying a
// file on disk, still get it.

test('browse listings do not carry absolute filesystem paths', async () => {
  const tracks = (await (await fetch(`${baseUrl}/api/library/tracks`)).json()).tracks;
  assert.ok(tracks.length > 0);
  for (const t of tracks) {
    assert.equal(t.path, undefined, 'the tracks list should not disclose the server layout');
  }

  const albumTracks = (await (await fetch(`${baseUrl}/api/library/album-tracks?artist=A&album=Al`)).json()).tracks;
  assert.ok(albumTracks.length > 0);
  for (const t of albumTracks) assert.equal(t.path, undefined);
});

test('the health report still carries paths, because that is how you find the file', async () => {
  const res = await fetch(`${baseUrl}/api/library/health-tracks?issue=missingTrackNumber`);
  const body = await res.json();
  assert.ok(body.tracks.length > 0);
  assert.ok(body.tracks[0].path, 'a file with no tags is only identifiable by its path');
});
