// The stream and cover routes are the only places that read arbitrary bytes off
// disk, so containment is the thing worth testing hardest: a row whose path
// escapes MUSIC_DIR — directly or through a symlink planted inside it — must be
// refused even though it is in the index.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-stream-music-'));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-stream-outside-'));
process.env.MUSIC_DIR = musicDir;

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const repo = await import('../../src/services/libraryRepo.js');

// 2048 bytes of recognisable content so range maths is checkable.
const BODY = Buffer.from('abcdefgh'.repeat(256));
const SECRET = Buffer.from('TOP SECRET NOT MUSIC');

let server;
let baseUrl;
let ids;

test.before(async () => {
  fs.writeFileSync(path.join(musicDir, 'song.mp3'), BODY);
  fs.writeFileSync(path.join(outsideDir, 'secret.mp3'), SECRET);
  // A symlink that lives inside MUSIC_DIR but resolves outside it.
  fs.symlinkSync(path.join(outsideDir, 'secret.mp3'), path.join(musicDir, 'escape.mp3'));

  const db = openDb(':memory:');
  const add = (p) => {
    repo.upsertLocalTrack(db, {
      path: p, artist: 'A', album: 'Al', title: path.basename(p),
      durationMs: 1000, changeKey: '1:1', ext: 'mp3',
    });
    return db.prepare('SELECT id FROM local_tracks WHERE path = ?').get(p).id;
  };
  ids = {
    ok: add(path.join(musicDir, 'song.mp3')),
    symlinked: add(path.join(musicDir, 'escape.mp3')),
    outside: add(path.join(outsideDir, 'secret.mp3')),
  };
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
  fs.rmSync(musicDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

test('streams a whole file with an audio content type', async () => {
  const res = await fetch(`${baseUrl}/api/library/stream/${ids.ok}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-length'), String(BODY.length));
  assert.equal(Buffer.from(await res.arrayBuffer()).length, BODY.length);
});

test('a range request returns 206 with just that slice', async () => {
  const res = await fetch(`${baseUrl}/api/library/stream/${ids.ok}`, {
    headers: { Range: 'bytes=8-15' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 8-15/${BODY.length}`);
  assert.equal(res.headers.get('content-length'), '8');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'abcdefgh');
});

test('an open-ended range runs to the end of the file', async () => {
  const res = await fetch(`${baseUrl}/api/library/stream/${ids.ok}`, {
    headers: { Range: 'bytes=2040-' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 2040-2047/${BODY.length}`);
  assert.equal(Buffer.from(await res.arrayBuffer()).length, 8);
});

test('a suffix range returns the last N bytes', async () => {
  const res = await fetch(`${baseUrl}/api/library/stream/${ids.ok}`, {
    headers: { Range: 'bytes=-8' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 2040-2047/${BODY.length}`);
});

test('a range past the end of the file is rejected with 416', async () => {
  const res = await fetch(`${baseUrl}/api/library/stream/${ids.ok}`, {
    headers: { Range: 'bytes=99999-' },
  });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${BODY.length}`);
});

test('a symlink inside MUSIC_DIR pointing outside it is refused', async () => {
  const res = await fetch(`${baseUrl}/api/library/stream/${ids.symlinked}`);
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.ok(!body.includes('TOP SECRET'), 'must not leak the file contents');
});

test('an indexed path outside MUSIC_DIR is refused', async () => {
  const res = await fetch(`${baseUrl}/api/library/stream/${ids.outside}`);
  assert.equal(res.status, 400);
});

// Regression: the route used to be createReadStream(real).pipe(res), and pipe()
// does not forward source errors — an unhandled 'error' on the ReadStream is an
// uncaught exception that kills the process. A file that passes the containment
// check and then fails to open (deleted mid-request, EACCES, or an I/O error on
// the network mount a library usually lives on) has to be a failed request.
test('a file that passes containment but cannot be opened fails the request, not the process', async (t) => {
  const unreadable = path.join(musicDir, 'unreadable.mp3');
  fs.writeFileSync(unreadable, BODY);
  // realpath() still resolves; open() is what fails.
  fs.chmodSync(unreadable, 0o000);
  t.after(() => { fs.chmodSync(unreadable, 0o644); fs.rmSync(unreadable, { force: true }); });
  if (fs.accessSync && (() => { try { fs.accessSync(unreadable, fs.constants.R_OK); return true; } catch { return false; } })()) {
    t.skip('running as a user that ignores file modes (root)');
    return;
  }

  const db = (await import('../../src/lib/db.js')).getDb();
  repo.upsertLocalTrack(db, {
    path: unreadable, artist: 'A', album: 'Al', title: 'unreadable.mp3',
    durationMs: 1000, changeKey: '9:9', ext: 'mp3',
  });
  const id = db.prepare('SELECT id FROM local_tracks WHERE path = ?').get(unreadable).id;

  const res = await fetch(`${baseUrl}/api/library/stream/${id}`);
  assert.equal(res.status, 500);
  // The process is still up to answer this, which is the whole point.
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
});

test('an unknown track id is a 404', async () => {
  const res = await fetch(`${baseUrl}/api/library/stream/999999`);
  assert.equal(res.status, 404);
});

test('the cover route refuses an escaping path too', async () => {
  const res = await fetch(`${baseUrl}/api/library/cover/${ids.symlinked}`);
  assert.equal(res.status, 400);
});

test('the cover route answers 204 when a track has no art of any kind', async () => {
  // song.mp3 is raw bytes with no tags and no cover image beside it. A 204 (not
  // a 404) keeps "no art" out of the browser console for every artless album,
  // and the client falls back to the placeholder either way.
  const res = await fetch(`${baseUrl}/api/library/cover/${ids.ok}`);
  assert.equal(res.status, 204);
  assert.match(res.headers.get('cache-control') ?? '', /max-age/);
});

test('the cover route serves a cover image sitting beside the audio', async () => {
  // A 1x1 PNG named cover.png, i.e. art stored the way most rippers store it
  // rather than embedded in the file.
  const dir = path.join(musicDir, 'Sidecar');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'track.mp3'), BODY);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  fs.writeFileSync(path.join(dir, 'cover.png'), png);

  const db = (await import('../../src/lib/db.js')).getDb();
  repo.upsertLocalTrack(db, {
    path: path.join(dir, 'track.mp3'), artist: 'A', album: 'Sidecar', title: 'track.mp3',
    durationMs: 1000, changeKey: '1:1', ext: 'mp3',
  });
  const id = db.prepare('SELECT id FROM local_tracks WHERE path = ?')
    .get(path.join(dir, 'track.mp3')).id;

  const res = await fetch(`${baseUrl}/api/library/cover/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await res.arrayBuffer()).length, png.length);
});

// The cover endpoint's ETag used to be set on the way out, and on the no-art
// path that made it decorative: the comment promised "a re-visit is a 304", but
// res.end() does no freshness checking — only res.send() does — so every repeat
// request re-parsed the file and re-scanned its folder to rediscover that there
// is still no cover. It is now set (and answered) from the indexed row before
// anything touches the disk.
test('a conditional cover request is answered 304 without reading the file', async () => {
  const first = await fetch(`${baseUrl}/api/library/cover/${ids.ok}`);
  assert.ok([200, 204].includes(first.status), `unexpected ${first.status}`);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'the response must carry a validator to be revalidated against');

  // Cache-Control is overridden because undici's fetch injects
  // `cache-control: no-cache` on every request, and the `fresh` module (rightly)
  // refuses to answer 304 to a client that asked for a non-cached response. A
  // browser revalidating an expired entry sends no such header.
  const second = await fetch(`${baseUrl}/api/library/cover/${ids.ok}`, {
    headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' },
  });
  assert.equal(second.status, 304);
  assert.equal(second.headers.get('etag'), etag);
});

test('a cover request with a stale validator is answered in full', async () => {
  const res = await fetch(`${baseUrl}/api/library/cover/${ids.ok}`, {
    headers: { 'If-None-Match': '"0-0-stale"', 'Cache-Control': 'max-age=0' },
  });
  assert.notEqual(res.status, 304);
});

// Every early exit from the SSE handlers used to `return res.end()` inside a try
// whose `finally` also called res.end(), ending the response twice, and `send`
// wrote to the response without checking whether it was still there.
test('an invalid releaseGroup on the SSE stream emits one error event and ends cleanly', async () => {
  const res = await fetch(`${baseUrl}/api/library/missing/stream?releaseGroup=not-a-uuid`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const body = await res.text();
  assert.match(body, /event: error/);
  assert.match(body, /a valid releaseGroup is required/);
  assert.equal(body.match(/event: error/g).length, 1, 'exactly one error event');
  assert.ok(!body.includes('event: done'), 'a rejected request must not also report done');
});

test('an artist-missing stream with no artist emits one error event and ends cleanly', async () => {
  const res = await fetch(`${baseUrl}/api/library/artist-missing/stream`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /an artist is required/);
  assert.equal(body.match(/event: error/g).length, 1);
  assert.ok(!body.includes('event: done'));
});
