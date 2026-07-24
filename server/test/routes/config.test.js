import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

let server;
let baseUrl;

test.before(async () => {
  process.env.METUBE_URL = 'https://metube.example.com/';
  const { createApp } = await import('../../src/app.js');
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => {
  delete process.env.METUBE_URL;
  server.close();
});

test('GET /api/config returns the configured metubeUrl with a trailing slash stripped', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.metubeUrl, 'https://metube.example.com');
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
