// The controls that protect everything else: the session gate, session
// revocation, the CSRF guard, and the response headers. These are the least
// interesting tests to write and the most expensive ones to be missing — the
// feature-route tests all swap the gate for a pass-through, so without this file
// nothing proves a protected route is actually protected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-sec-music-'));
process.env.MUSIC_DIR = musicDir;
process.env.INGEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-sec-ingest-'));

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const { createApp } = await import('../../src/app.js');
const repo = await import('../../src/services/libraryRepo.js');
const { hashPassword } = await import('../../src/services/auth.js');

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

let server;
let baseUrl;
let db;

// Sec-Fetch-Site is included because a browser always sends it and the CSRF
// guard now requires it: a request that identifies its origin in no way at all
// is refused rather than waved through. Tests that are specifically exercising
// the guard override it.
const asJson = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0] ?? null;

test.before(async () => {
  db = openDb(':memory:');
  setDbForTest(db);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => {
  setDbForTest(null);
  server.close();
  delete process.env.MUSIC_DIR;
  delete process.env.INGEST_DIR;
  fs.rmSync(musicDir, { recursive: true, force: true });
});

async function setupAdmin(username, password) {
  const res = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST', headers: asJson, body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, await res.text());
  return cookieOf(res);
}

// --- The gate ----------------------------------------------------------------

// The one test that catches a new router mounted without `gate`. Every path here
// is one a browser can reach; the only unauthenticated surface is the allowlist.
test('every /api route requires a session except the documented public ones', async () => {
  const PROTECTED = [
    '/api/search?q=x',
    '/api/artists/11111111-1111-4111-8111-111111111111/albums',
    '/api/releases/11111111-1111-4111-8111-111111111111/tracks',
    '/api/cover/release-group/11111111-1111-4111-8111-111111111111',
    '/api/library/stats',
    '/api/library/artists',
    '/api/library/albums',
    '/api/library/tracks',
    '/api/library/health',
    '/api/library/incomplete',
    '/api/library/duplicates',
    '/api/library/cover/1',
    '/api/library/stream/1',
    '/api/ingest/scan',
    '/api/ingest/file/candidates?path=x',
  ];
  for (const url of PROTECTED) {
    const res = await fetch(baseUrl + url, { redirect: 'manual' });
    assert.equal(res.status, 401, `${url} answered ${res.status}, so it is not gated`);
  }

  for (const url of ['/api/health', '/api/config', '/api/auth/status']) {
    assert.equal((await fetch(baseUrl + url)).status, 200, `${url} should stay public`);
  }
});

test('a protected POST is gated before it does any work', async () => {
  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { ...asJson, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ artist: 'A', title: 'T', lengthMs: 1000 }),
  });
  assert.equal(res.status, 401);
});

// --- Session revocation ------------------------------------------------------

test('changing the password revokes every other session', async () => {
  const cookie = await setupAdmin('yoshi', 'hunter2hunter2');
  // A second sign-in, standing in for the other browser / stolen cookie.
  const other = cookieOf(await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { ...asJson, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ username: 'yoshi', password: 'hunter2hunter2' }),
  }));
  assert.equal((await fetch(`${baseUrl}/api/library/stats`, { headers: { Cookie: other } })).status, 200);

  const changed = await fetch(`${baseUrl}/api/auth/password`, {
    method: 'POST',
    headers: { ...asJson, Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ currentPassword: 'hunter2hunter2', newPassword: 'correcthorsebattery' }),
  });
  assert.equal(changed.status, 200, await changed.text());

  // The other session is dead...
  assert.equal((await fetch(`${baseUrl}/api/library/stats`, { headers: { Cookie: other } })).status, 401);
  // ...and so is the one that made the change, except it got a replacement.
  assert.equal((await fetch(`${baseUrl}/api/library/stats`, { headers: { Cookie: cookie } })).status, 401);
  const fresh = cookieOf(changed);
  assert.equal((await fetch(`${baseUrl}/api/library/stats`, { headers: { Cookie: fresh } })).status, 200);
});

test('a password change requires the current password', async () => {
  const cookie = cookieOf(await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { ...asJson, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ username: 'yoshi', password: 'correcthorsebattery' }),
  }));
  const res = await fetch(`${baseUrl}/api/auth/password`, {
    method: 'POST',
    headers: { ...asJson, Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'somethingelse1' }),
  });
  assert.equal(res.status, 400);
});

// The README's recovery procedure. Deleting the credential row and setting up
// again must not leave the previous admin's cookies working — the token names a
// username and an epoch, and both are checked against the admin that exists now.
test('recreating the admin invalidates tokens issued to the old one', async () => {
  const stale = cookieOf(await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { ...asJson, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ username: 'yoshi', password: 'correcthorsebattery' }),
  }));
  assert.equal((await fetch(`${baseUrl}/api/library/stats`, { headers: { Cookie: stale } })).status, 200);

  db.prepare('DELETE FROM app_auth').run();
  await setupAdmin('someone-else', 'brandnewpassword');

  const res = await fetch(`${baseUrl}/api/library/stats`, { headers: { Cookie: stale } });
  assert.equal(res.status, 401, 'a token from the previous admin must not authenticate');
});

// --- CSRF --------------------------------------------------------------------

// Applied once for the whole API rather than per route, because per route meant
// the two POST /api/verify endpoints silently had no guard at all.
test('cross-site state-changing requests are refused across the whole API', async () => {
  const cookie = cookieOf(await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { ...asJson, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ username: 'someone-else', password: 'brandnewpassword' }),
  }));
  const POSTS = ['/api/verify', '/api/verify/album/11111111-1111-4111-8111-111111111111',
    '/api/library/scan', '/api/library/fix', '/api/library/owned', '/api/library/rescan',
    '/api/library/artist-link', '/api/ingest/process', '/api/ingest/file/resolve'];
  for (const url of POSTS) {
    const res = await fetch(baseUrl + url, {
      method: 'POST',
      headers: { ...asJson, Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' },
      body: '{}',
    });
    assert.equal(res.status, 400, `${url} accepted a cross-site POST`);
    assert.match((await res.json()).error.message, /[Cc]ross-/);
  }
});

// --- Response headers and content types --------------------------------------

test('security headers are set on every response', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

// A file's embedded art carries its own mime type, straight out of a tag written
// by whoever produced the file. Serving that verbatim let any track in the
// library choose the Content-Type of a response on this origin.
test('embedded cover art with a hostile mime type is not served as that type', async () => {
  const { File, Picture, PictureType, ByteVector } = await import('node-taglib-sharp');
  const track = path.join(musicDir, 'hostile.mp3');
  fs.copyFileSync(path.join(FIXTURES_DIR, 'silence.mp3'), track);

  const file = File.createFromPath(track);
  file.tag.pictures = [Picture.fromFullData(
    ByteVector.fromByteArray(Buffer.from('<script>alert(document.domain)</script>')),
    PictureType.FrontCover,
    'text/html',
    '',
  )];
  file.save();
  file.dispose();

  repo.upsertLocalTrack(db, {
    path: track, artist: 'A', album: 'Hostile', title: 'hostile', durationMs: 1000,
    changeKey: 'h:1', ext: 'mp3', hasCoverArt: 1,
  });
  const id = db.prepare('SELECT id FROM local_tracks WHERE path = ?').get(track).id;

  const cookie = cookieOf(await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { ...asJson, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ username: 'someone-else', password: 'brandnewpassword' }),
  }));
  const res = await fetch(`${baseUrl}/api/library/cover/${id}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

// --- Input validation --------------------------------------------------------

test('a non-UUID MusicBrainz id is refused before any upstream call', async () => {
  const cookie = cookieOf(await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { ...asJson, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ username: 'someone-else', password: 'brandnewpassword' }),
  }));
  for (const url of [
    '/api/artists/..%2F..%2Fartist%2Fx/albums',
    '/api/releases/not-a-uuid/tracks',
    '/api/cover/release-group/not-a-uuid',
    '/api/library/missing?releaseGroup=not-a-uuid',
  ]) {
    const res = await fetch(baseUrl + url, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(res.status, 400, `${url} answered ${res.status}`);
  }
});

// --- Logout has to actually revoke -------------------------------------------

test('logout revokes the token, not just the cookie in this browser', async () => {
  const cookie = cookieOf(await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: asJson,
    body: JSON.stringify({ username: 'someone-else', password: 'brandnewpassword' }),
  }));
  assert.equal((await fetch(`${baseUrl}/api/library/stats`, { headers: { Cookie: cookie } })).status, 200);

  const out = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST', headers: { ...asJson, Cookie: cookie },
  });
  assert.equal(out.status, 200);

  // The token is stateless and self-verifying, so this is the whole test: a copy
  // of the cookie kept working for the rest of its 30 days when logout only
  // cleared the browser's own copy.
  const after = await fetch(`${baseUrl}/api/library/stats`, { headers: { Cookie: cookie } });
  assert.equal(after.status, 401, 'a copied session cookie must stop working after logout');
});

// --- The CSRF guard fails closed ---------------------------------------------

test('a state-changing request identifying its origin in no way at all is refused', async () => {
  const cookie = cookieOf(await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: asJson,
    body: JSON.stringify({ username: 'someone-else', password: 'brandnewpassword' }),
  }));

  // No Sec-Fetch-Site, no Origin. This used to be allowed on the grounds that
  // "older browsers, curl, our own tests" send neither — a guard an attacker
  // could disarm by omitting a field.
  const res = await fetch(`${baseUrl}/api/library/owned`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: '{}',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Sec-Fetch-Site or Origin/);
});

test('a same-origin request identified only by Origin is still accepted', async () => {
  const cookie = cookieOf(await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: asJson,
    body: JSON.stringify({ username: 'someone-else', password: 'brandnewpassword' }),
  }));
  const res = await fetch(`${baseUrl}/api/library/owned`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: baseUrl },
    body: JSON.stringify({ albums: [], recordings: [] }),
  });
  assert.equal(res.status, 200);
});
