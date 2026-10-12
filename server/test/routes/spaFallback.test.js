import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
const { createApp } = await import('../../src/app.js');

// An install under a dot directory (~/.local/share/...) must still serve the app on a deep link.
test('deep links serve index.html even when the client lives under a dot directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-spa-'));
  const clientDist = path.join(root, '.local', 'dist');
  fs.mkdirSync(clientDist, { recursive: true });
  fs.writeFileSync(path.join(clientDist, 'index.html'), '<!doctype html><title>spa</title>');
  const server = createApp({ clientDist }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const url of ['/library', '/playlists?id=3', '/a/b/c']) {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, url);
      assert.match(await res.text(), /<title>spa<\/title>/, url);
    }
    assert.notEqual((await fetch(`${base}/api/nope`)).status, 200, '/api paths never get the app');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
