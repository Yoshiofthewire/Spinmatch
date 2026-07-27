// Wiring for GET /api/library/missing-track. Kept out of routes/library.test.js
// because it needs the discography service mocked before createApp is imported.
//
// The resolution logic itself is covered in libraryDiscography.test.js; what's
// checked here is that the query string is validated and coerced — position and
// disc arrive as strings and are interpolated into an upstream lookup.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = '/tmp/spinmatch-missing-route';

let args = null;
let answer = { resolved: false, reason: 'unresolved_album' };

// Spread over the real module rather than listing exports: a mock replaces the
// module wholesale, and libraryBulkFix binds to resolveAlbum from here, so an
// export left out of the mock is a load-time SyntaxError somewhere unrelated.
const real = await import('../../src/services/libraryDiscography.js');

mock.module('../../src/services/libraryDiscography.js', {
  namedExports: {
    ...real,
    resolveMissingTrack: async (artist, album, options) => {
      args = { artist, album, ...options };
      return answer;
    },
  },
});

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const { createApp } = await import('../../src/app.js');

let server;
let baseUrl;
let db;

test.before(async () => {
  db = openDb(':memory:');
  setDbForTest(db);
  server = createApp({ gate: (req, res, next) => next() }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => {
  setDbForTest(null);
  delete process.env.MUSIC_DIR;
  server.close();
});

function lookup(query) {
  return fetch(`${baseUrl}/api/library/missing-track?${new URLSearchParams(query)}`);
}

test('GET /api/library/missing-track coerces position and disc to numbers', async () => {
  answer = { resolved: true, title: 'Kid A', lengthMs: 274000, recordingMbid: 'rec-2' };
  const res = await lookup({ artist: 'Radiohead', album: 'Kid A', position: '2', disc: '2' });
  assert.equal(res.status, 200);

  assert.equal(args.artist, 'Radiohead');
  assert.equal(args.album, 'Kid A');
  assert.equal(args.position, 2);
  assert.equal(args.disc, 2);
  assert.deepEqual(await res.json(), answer);
});

test('GET /api/library/missing-track defaults disc to 1', async () => {
  answer = { resolved: true, title: 'X', lengthMs: 1000 };
  await lookup({ album: 'Kid A', position: '3' });
  assert.equal(args.disc, 1);
});

// A local album with no artist tag is a real case, and the service takes null for
// it — an absent query param must not arrive as the string "undefined".
test('GET /api/library/missing-track passes a missing artist as null', async () => {
  answer = { resolved: true, title: 'X', lengthMs: 1000 };
  await lookup({ album: 'Untitled', position: '1' });
  assert.equal(args.artist, null);
});

test('GET /api/library/missing-track requires an album', async () => {
  const res = await lookup({ position: '1' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /album is required/);
});

test('GET /api/library/missing-track requires a positive position', async () => {
  for (const position of ['0', '-1', 'abc', '']) {
    const res = await lookup({ album: 'Kid A', position });
    assert.equal(res.status, 400, `position=${JSON.stringify(position)} should be rejected`);
    assert.match((await res.json()).error.message, /positive position/);
  }
});

test('GET /api/library/missing-track passes an unresolved album through as an answer, not an error', async () => {
  answer = { resolved: false, reason: 'unresolved_album' };
  const res = await lookup({ album: 'Kid A', position: '1' });
  assert.equal(res.status, 200, 'an album we cannot place is a 200 with a reason');
  assert.deepEqual(await res.json(), answer);
});

test('GET /api/library/missing-track returns the track count for a position past the tracklist', async () => {
  answer = { resolved: false, reason: 'no_such_position', trackCount: 12 };
  const res = await lookup({ album: 'Kid A', position: '14' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), answer);
});
