import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const musicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-rm-'));
const dropoffDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-rd-'));

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = musicDir;
process.env.DROPOFF_DIR = dropoffDir;

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const repo = await import('../../src/services/libraryRepo.js');

let server;
let baseUrl;
let db;

test.before(async () => {
  await fs.mkdir(path.join(musicDir, 'A', 'Al'), { recursive: true });
  await fs.writeFile(path.join(musicDir, 'A', 'Al', '01.mp3'), Buffer.alloc(16, 1));

  db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: path.join(musicDir, 'A', 'Al', '01.mp3'), artist: 'A', album: 'Al',
    title: 'One', durationMs: 200_000, sizeBytes: 16, ext: '.mp3', changeKey: '1:1',
  });
  setDbForTest(db);
  const { createApp } = await import('../../src/app.js');
  server = createApp({ gate: (req, res, next) => next() }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  setDbForTest(null);
  server.close();
  await fs.rm(musicDir, { recursive: true, force: true });
  await fs.rm(dropoffDir, { recursive: true, force: true });
});

const postJson = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl },
  body: JSON.stringify(body),
});

test('creates a playlist and adds an item that resolves', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Trip' })).json();
  assert.ok(created.id);

  const added = await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  assert.equal(added.status, 200);

  const body = await (await fetch(`${baseUrl}/api/playlists/${created.id}`)).json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].track.title, 'One');
});

test('rejects a blank name', async () => {
  const res = await postJson(`${baseUrl}/api/playlists`, { name: '   ' });
  assert.equal(res.status, 400);
});

test('rejects a duplicate name with a 409', async () => {
  await postJson(`${baseUrl}/api/playlists`, { name: 'Dupe' });
  const res = await postJson(`${baseUrl}/api/playlists`, { name: 'dupe' });
  assert.equal(res.status, 409);
});

test('rejects an over-long name', async () => {
  const res = await postJson(`${baseUrl}/api/playlists`, { name: 'x'.repeat(300) });
  assert.equal(res.status, 400);
});

test('rejects more items than the cap allows', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Big' })).json();
  const items = Array.from({ length: 5001 }, (_, i) => ({ title: `t${i}`, source: 'manual' }));
  const res = await postJson(`${baseUrl}/api/playlists/${created.id}/items`, { items });
  assert.equal(res.status, 400);
});

test('404s an unknown playlist', async () => {
  const res = await fetch(`${baseUrl}/api/playlists/99999`);
  assert.equal(res.status, 404);
});

test('exports an m3u to the music root', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'M3U Test' })).json();
  await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  const res = await postJson(`${baseUrl}/api/playlists/${created.id}/export/m3u`, {});
  assert.equal(res.status, 200);
  const text = await fs.readFile(path.join(musicDir, 'M3U Test.m3u'), 'utf8');
  assert.match(text, /A\/Al\/01\.mp3/);
});

test('reports an existing drop-off folder instead of overwriting it', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Drop' })).json();
  await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  await fs.mkdir(path.join(dropoffDir, 'Drop'), { recursive: true });
  await fs.writeFile(path.join(dropoffDir, 'Drop', 'stale.mp3'), 'x');

  // sameOriginOnly fails closed on a request carrying none of Sec-Fetch-Site,
  // Origin or Referer (see security.test.js) — an EventSource sends
  // Sec-Fetch-Site on a trustworthy origin, so that's what a real caller of
  // this GET provides.
  const res = await fetch(`${baseUrl}/api/playlists/${created.id}/export/dropoff`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.existing.fileCount, 1);
});

test('config advertises whether export to player is available', async () => {
  const body = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(body.playlistExportEnabled, true);
});
