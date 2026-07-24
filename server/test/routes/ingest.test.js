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

test('GET /api/ingest/process-stream streams SSE and ends with a done event', async () => {
  // Empty the ingest dir so the stream finishes deterministically without
  // depending on external tools to process a fixture file.
  await fs.rm(path.join(tmpDir, 'route-track.mp3'), { force: true });

  const res = await fetch(`${baseUrl}/api/ingest/process-stream`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const body = await res.text();
  assert.match(body, /event: done/);
});

test('GET /api/ingest/file/candidates requires a path query param', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/file/candidates`);
  assert.equal(res.status, 400);
});

test('GET /api/ingest/file/candidates rejects a path outside INGEST_DIR', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/file/candidates?path=${encodeURIComponent('/etc/passwd')}`);
  assert.equal(res.status, 400);
});

test('POST /api/ingest/file/resolve requires path, name, and recordingMbid', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/file/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('POST /api/ingest/file/resolve rejects cross-site requests (CSRF guard)', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/file/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ path: path.join(tmpDir, 'x.mp3'), name: 'x.mp3', recordingMbid: 'rec-1' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/ingest/file/resolve rejects a path outside INGEST_DIR', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/file/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/etc/passwd', name: 'passwd', recordingMbid: 'rec-1' }),
  });
  assert.equal(res.status, 400);
});

test('the mutating ingest routes reject cross-site requests (CSRF guard)', async () => {
  const stream = await fetch(`${baseUrl}/api/ingest/process-stream`, {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(stream.status, 400);

  const process = await fetch(`${baseUrl}/api/ingest/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ dryRun: true }),
  });
  assert.equal(process.status, 400);
});

test('a same-origin request to the stream is allowed', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/process-stream`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /event: done/);
});
