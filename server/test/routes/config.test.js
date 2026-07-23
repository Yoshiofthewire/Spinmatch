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

test('GET /api/config reports ingestEnabled: false when ACOUSTID_API_KEY/MUSIC_DIR/INGEST_DIR are unset', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ingestEnabled, false);
});

test('ingestEnabled() returns true only when acoustidApiKey, musicDir, and ingestDir are all set', async () => {
  process.env.ACOUSTID_API_KEY = 'test-acoustid-key';
  process.env.MUSIC_DIR = '/tmp/music';
  process.env.INGEST_DIR = '/tmp/ingest';
  const { ingestEnabled } = await import('../../src/config.js?variant=ingest-enabled-true');
  assert.equal(ingestEnabled(), true);
  delete process.env.ACOUSTID_API_KEY;
  delete process.env.MUSIC_DIR;
  delete process.env.INGEST_DIR;
});

test('ingestEnabled() returns false when only some ingest vars are set', async () => {
  process.env.ACOUSTID_API_KEY = 'test-acoustid-key';
  // MUSIC_DIR / INGEST_DIR left unset
  const { ingestEnabled } = await import('../../src/config.js?variant=ingest-enabled-partial');
  assert.equal(ingestEnabled(), false);
  delete process.env.ACOUSTID_API_KEY;
});
