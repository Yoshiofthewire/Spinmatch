import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

let server;
let baseUrl;
let cookie;

test.before(async () => {
  process.env.METUBE_URL = 'https://metube.example.com/';
  const { openDb, setDbForTest } = await import('../../src/lib/db.js');
  const { createApp } = await import('../../src/app.js');
  setDbForTest(openDb(':memory:'));
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  // An admin, so the authenticated half of this route can be exercised.
  const res = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ username: 'yoshi', password: 'hunter2hunter2' }),
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
});

test.after(() => {
  delete process.env.METUBE_URL;
  server.close();
});

// metubeUrl is typically an internal hostname, and this route is public because
// the client needs the feature flags before it can render the login screen. So
// the URL is the one field that waits for a session.
test('GET /api/config withholds metubeUrl from an unauthenticated caller', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.metubeUrl, null);
  // The flags are still public — the client needs them to decide what to render.
  assert.equal(body.libraryEnabled, false);
});

test('GET /api/config returns the configured metubeUrl to a session, trailing slash stripped', async () => {
  const res = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.metubeUrl, 'https://metube.example.com');
});

test('GET /api/config withholds metubeUrl from a forged cookie', async () => {
  const res = await fetch(`${baseUrl}/api/config`, {
    headers: { Cookie: 'spinmatch_session=not.a.real.token' },
  });
  assert.equal((await res.json()).metubeUrl, null);
});

test('config.js normalizes an unset METUBE_URL to null', async () => {
  const originalUrl = process.env.METUBE_URL;
  delete process.env.METUBE_URL;
  // Force a fresh module instance so config.js re-reads process.env now.
  const { config } = await import('../../src/config.js?variant=metube-unset');
  assert.equal(config.metubeUrl, null);
  process.env.METUBE_URL = originalUrl;
});

test('GET /api/config reports ingestEnabled: false when MUSIC_DIR/INGEST_DIR are unset', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ingestEnabled, false);
});

test('GET /api/config reports acoustidConfigured: false when ACOUSTID_API_KEY is unset', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  const body = await res.json();
  assert.equal(body.acoustidConfigured, false);
});

test('ingestEnabled() returns true when musicDir and ingestDir are set, regardless of acoustidApiKey', async () => {
  process.env.MUSIC_DIR = '/tmp/music';
  process.env.INGEST_DIR = '/tmp/ingest';
  const { ingestEnabled } = await import('../../src/config.js?variant=ingest-enabled-true');
  assert.equal(ingestEnabled(), true);
  delete process.env.MUSIC_DIR;
  delete process.env.INGEST_DIR;
});

test('ingestEnabled() returns false when only one of musicDir/ingestDir is set', async () => {
  process.env.MUSIC_DIR = '/tmp/music';
  // INGEST_DIR left unset
  const { ingestEnabled } = await import('../../src/config.js?variant=ingest-enabled-partial');
  assert.equal(ingestEnabled(), false);
  delete process.env.MUSIC_DIR;
});

test('acoustidConfigured is true when ACOUSTID_API_KEY is set', async () => {
  process.env.ACOUSTID_API_KEY = 'test-acoustid-key';
  const { config } = await import('../../src/config.js?variant=acoustid-configured-true');
  assert.equal(Boolean(config.acoustidApiKey), true);
  delete process.env.ACOUSTID_API_KEY;
});

test('GET /api/config reports libraryEnabled: false when MUSIC_DIR is unset', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  const body = await res.json();
  assert.equal(body.libraryEnabled, false);
});

test('libraryEnabled() is true when MUSIC_DIR is set', async () => {
  process.env.MUSIC_DIR = '/tmp/music';
  const { libraryEnabled } = await import('../../src/config.js?variant=library-enabled');
  assert.equal(libraryEnabled(), true);
  delete process.env.MUSIC_DIR;
});

test('config.library.dbPath falls back to a cwd-relative path when LIBRARY_DB is unset', async () => {
  const original = process.env.LIBRARY_DB;
  delete process.env.LIBRARY_DB;
  const { config } = await import('../../src/config.js?variant=db-default');
  assert.equal(config.library.dbPath, 'data/library.db');
  if (original !== undefined) process.env.LIBRARY_DB = original;
});
