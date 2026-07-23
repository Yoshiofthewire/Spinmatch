import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-route-'));

process.env.ACOUSTID_API_KEY = 'test-key';
process.env.MUSIC_DIR = await fs.mkdtemp(path.join(__dirname, '.tmp-music-route-'));
process.env.INGEST_DIR = tmpDir;

const { createApp } = await import('../../src/app.js');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(process.env.MUSIC_DIR, { recursive: true, force: true });
});

test('GET /api/ingest/scan lists items in the configured ingest dir', async () => {
  await fs.writeFile(path.join(tmpDir, 'route-track.mp3'), 'fake-audio');

  const res = await fetch(`${baseUrl}/api/ingest/scan`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.items.some((i) => i.name === 'route-track.mp3'));
});
