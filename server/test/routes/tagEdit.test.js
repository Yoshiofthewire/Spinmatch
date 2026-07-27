// Wiring for the two manual-edit endpoints. The editing behaviour itself is
// covered by tagEdit.test.js; what's checked here is that the route hands the
// service what the client sent, that a validation failure arrives as a 400 whose
// message is usable in a browser, and that PATCH — a method new to this API — is
// behind the same CSRF guard as every other write.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = '/tmp/spinmatch-tagedit-route';

let trackArgs = null;
let albumArgs = null;

// The real validator, so the 400s below are the ones a client would actually get;
// only the file IO is stubbed out.
const real = await import('../../src/services/tagEdit.js');

mock.module('../../src/services/tagEdit.js', {
  namedExports: {
    ...real,
    editTrackTags: async (args) => {
      trackArgs = args;
      const patch = real.validateTagEdit(args.fields);
      return { trackId: args.trackId, changedFields: Object.keys(patch), track: { id: args.trackId } };
    },
    editAlbumTags: async (args) => {
      albumArgs = args;
      if (!args.album) throw new Error('album is required');
      if (Object.keys(args.fields ?? {}).length) {
        real.validateTagEdit(args.fields, { allow: real.ALBUM_WIDE_FIELDS });
      }
      return { applied: [{ trackId: 1, changedFields: ['year'] }], failed: [], skipped: 0, renamed: null };
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

function patchTrack(id, body, headers = { 'Sec-Fetch-Site': 'same-origin' }) {
  return fetch(`${baseUrl}/api/library/track/${id}/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function postAlbum(body) {
  return fetch(`${baseUrl}/api/library/album/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify(body),
  });
}

test('PATCH /api/library/track/:id/tags passes the fields through and reports what changed', async () => {
  const res = await patchTrack(7, { fields: { title: 'Idioteque', year: '2000' } });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(trackArgs.trackId, 7);
  assert.deepEqual(trackArgs.fields, { title: 'Idioteque', year: '2000' });
  assert.deepEqual(body.changedFields, ['title', 'year']);
  assert.deepEqual(body.track, { id: 7 });
});

test('PATCH with no fields object at all is a 400', async () => {
  const res = await patchTrack(7, {});
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /fields must be an object/);
});

// A blank field is not an error — it means "leave this alone" — but a request in
// which EVERY field is blank has asked for nothing, and says so.
test('PATCH with only blank fields is a 400 rather than a silent no-op', async () => {
  const res = await patchTrack(7, { fields: { title: '', artist: null } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /no fields to change/);
});

// The message has to be usable as-is: the panel renders it verbatim in a banner.
test('PATCH with an out-of-range year is a 400 naming the allowed range', async () => {
  const res = await patchTrack(7, { fields: { year: 3000 } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /between 1 and 2999/);
});

test('PATCH with an unknown tag field is a 400', async () => {
  const res = await patchTrack(7, { fields: { albumArtist: 'Various' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /cannot be set here/);
});

test('PATCH with no track id is a 400', async () => {
  const res = await patchTrack('abc', { fields: { title: 'X' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /track id is required/);
});

// PATCH is a new method for this API, and the app-wide guard keys on the method —
// so this is the case where a new verb could quietly arrive unprotected.
test('PATCH without a same-origin signal is rejected by the CSRF guard', async () => {
  const res = await fetch(`${baseUrl}/api/library/track/7/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { title: 'X' } }),
  });
  assert.equal(res.status, 400, 'an unmarked PATCH must not reach the service');
  assert.match((await res.json()).error.message, /Sec-Fetch-Site, Origin, or Referer/);
});

test('a cross-site PATCH is rejected', async () => {
  const res = await patchTrack(7, { fields: { title: 'X' } }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Cross-site requests are not allowed/);
});

test('POST /api/library/album/tags passes artist, album, fields and perTrack through', async () => {
  const res = await postAlbum({
    artist: 'Radiohead',
    album: 'Kid A',
    fields: { year: 2000 },
    perTrack: [{ trackId: 3, fields: { title: 'Idioteque' } }],
    trackIds: [3, 4],
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(albumArgs.artist, 'Radiohead');
  assert.equal(albumArgs.album, 'Kid A');
  assert.deepEqual(albumArgs.fields, { year: 2000 });
  assert.deepEqual(albumArgs.perTrack, [{ trackId: 3, fields: { title: 'Idioteque' } }]);
  assert.deepEqual(albumArgs.trackIds, [3, 4]);
  assert.deepEqual(body.applied, [{ trackId: 1, changedFields: ['year'] }]);
  assert.equal(body.renamed, null);
});

test('POST /api/library/album/tags treats a missing artist as null, not undefined', async () => {
  const res = await postAlbum({ album: 'Untitled', fields: { artist: 'Aphex Twin' } });
  assert.equal(res.status, 200);
  assert.equal(albumArgs.artist, null);
});

test('POST /api/library/album/tags without an album is a 400', async () => {
  const res = await postAlbum({ fields: { year: 2000 } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /album is required/);
});

test('POST /api/library/album/tags rejects a per-album title', async () => {
  const res = await postAlbum({ album: 'Kid A', fields: { title: 'One title for all' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /cannot be set here/);
});

test('POST /api/library/album/tags refuses more tracks than the bulk ceiling', async () => {
  const { MAX_BULK_FIX } = await import('../../src/services/libraryBulkFix.js');
  const res = await postAlbum({
    album: 'Kid A',
    fields: { year: 2000 },
    trackIds: Array.from({ length: MAX_BULK_FIX + 1 }, (_, i) => i + 1),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /at most/);
});
