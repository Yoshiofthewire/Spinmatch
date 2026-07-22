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
