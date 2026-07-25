import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-noacoustid-'));

// Intentionally NOT setting ACOUSTID_API_KEY: the ingest feature should still
// be reachable (gated only on MUSIC_DIR + INGEST_DIR) and fall back to
// tag-based matching instead of erroring or 404ing.
process.env.MUSIC_DIR = await fs.mkdtemp(path.join(__dirname, '.tmp-music-noacoustid-'));
process.env.INGEST_DIR = tmpDir;

const { createApp } = await import('../../src/app.js');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp({ gate: (req, res, next) => next() });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(process.env.MUSIC_DIR, { recursive: true, force: true });
});

test('GET /api/config reports ingestEnabled: true and acoustidConfigured: false', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ingestEnabled, true);
  assert.equal(body.acoustidConfigured, false);
});

test('GET /api/ingest/scan is reachable without an AcoustID key', async () => {
  await fs.writeFile(path.join(tmpDir, 'no-key-track.mp3'), 'fake-audio');

  const res = await fetch(`${baseUrl}/api/ingest/scan`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.items.some((i) => i.name === 'no-key-track.mp3'));
});

// The fallback picker offers whatever MusicBrainz knows about the file's tags;
// this fixture is a text file with no readable tags at all, so the endpoint has
// nothing to offer — and must say so rather than fail.
test('GET /api/ingest/file/candidates returns an empty list for an unreadable file', async () => {
  const filePath = path.join(tmpDir, 'no-key-track.mp3');

  const res = await fetch(`${baseUrl}/api/ingest/file/candidates?path=${encodeURIComponent(filePath)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.candidates, []);
});
