// Wiring for the two tag-repair endpoints. The repair behaviour itself is
// covered by libraryFix.test.js; what's checked here is that the route hands
// the service what the client sent — in particular the overwrite flag, which is
// the difference between correcting a mis-tagged file and doing nothing to it.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = '/tmp/spinmatch-libfix-route';
process.env.ACOUSTID_API_KEY = 'test-key';

let applyArgs = null;
let fingerprintedTrackId = null;

mock.module('../../src/services/libraryFix.js', {
  namedExports: {
    getFixCandidates: async (trackId) => ({ track: { id: trackId }, candidates: [], pathTags: {} }),
    getFingerprintCandidates: async (trackId) => {
      fingerprintedTrackId = trackId;
      return {
        track: { id: trackId },
        candidates: [{ recordingMbid: 'rec-1', title: 'T', artist: 'A', lengthMs: 1000, score: 0.9, releaseGroupTitle: 'Al' }],
      };
    },
    applyFix: async (args) => {
      applyArgs = args;
      return { filledFields: ['artist'], overwritten: args.overwrite, track: {}, recording: {} };
    },
  },
});

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const { createApp } = await import('../../src/app.js');

let server;
let baseUrl;
let db;

const MBID = '77777777-7777-4777-8777-777777777777';

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

function postFix(body) {
  return fetch(`${baseUrl}/api/library/fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify(body),
  });
}

test('GET /api/library/fingerprint-candidates returns the audio-identified candidates', async () => {
  const res = await fetch(`${baseUrl}/api/library/fingerprint-candidates/7`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(fingerprintedTrackId, 7, 'the id reaches the service as a number');
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0].recordingMbid, 'rec-1');
});

test('POST /api/library/fix passes the overwrite opt-in through to the repair', async () => {
  applyArgs = null;
  const res = await postFix({ trackId: 3, recordingMbid: MBID, overwrite: true });
  assert.equal(res.status, 200);

  assert.equal(applyArgs.overwrite, true);
  assert.equal((await res.json()).overwritten, true);
});

test('POST /api/library/fix fills only the blanks when overwrite is not asked for', async () => {
  applyArgs = null;
  const res = await postFix({ trackId: 3, recordingMbid: MBID });
  assert.equal(res.status, 200);

  assert.equal(applyArgs.overwrite, false, 'an absent flag must not read as truthy');
});
