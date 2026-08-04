import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The whole-branch review's top concern: playlistRepo, playlistDiscovery and
// the router were each reviewed and unit-tested alone. This file is the one
// place that walks the real seam between them — real temp DB, real router via
// createApp, real files on disk — mocking only the network (libraryDiscovery
// and listenBrainz), so a shape mismatch between /suggest's output and
// /items' input would fail here even though it passes every unit test.

const musicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-flow-music-'));

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = musicDir;

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const repo = await import('../../src/services/libraryRepo.js');

let server;
let baseUrl;
let db;

test.after(async () => {
  setDbForTest(null);
  server?.close();
  await fs.rm(musicDir, { recursive: true, force: true });
});

const postJson = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl },
  body: JSON.stringify(body),
});

async function seedFile(rel, bytes = 16) {
  const full = path.join(musicDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.alloc(bytes, 1));
  return full;
}

// One neighbour, 'Nova', with five tracks a suggestion can draw from, plus a
// sixth ('Short') that only the duration-bound test cares about — it is 45s,
// under the 60s default, and deliberately given no real file on disk since
// nothing in this file ever adds it to a playlist or exports it.
async function seedNova() {
  for (let i = 1; i <= 5; i += 1) {
    const full = await seedFile(`Nova/Al/N${i}.mp3`);
    repo.upsertLocalTrack(db, {
      path: full, artist: 'Nova', album: 'Al', title: `N${i}`,
      durationMs: 200_000, sizeBytes: 16, ext: '.mp3', year: 2000, trackNumber: i,
      changeKey: `${i}:1`,
    });
  }
  repo.upsertLocalTrack(db, {
    path: path.join(musicDir, 'Nova', 'Al', 'Short.mp3'), artist: 'Nova', album: 'Al',
    title: 'Short', durationMs: 45_000, sizeBytes: 16, ext: '.mp3', changeKey: '6:1',
  });
}

// Every test in this file shares one app instance created by the first test.
// That is deliberate, not an accident of hook ordering: t.mock.module needs a
// live TestContext, which test.before does not receive, so the mocks for
// libraryDiscovery.js/listenBrainz.js can only be registered inside a real
// test() body, before the FIRST import of app.js (which statically imports
// the playlists router, which statically imports playlistDiscovery.js, which
// is what actually binds to those two modules). Once that binding happens the
// mock is baked into playlistDiscovery.js's module instance for the rest of
// the process — ES module bindings don't re-resolve — so later tests in this
// file can keep issuing requests against the same server without registering
// anything themselves. See playlistDiscovery.test.js's importSuggestTracks
// comment for the same constraint from the other direction.
test('the full playlist flow: suggest, add exactly what suggest returned, resolve, export', async (t) => {
  db = openDb(':memory:');
  await seedNova();
  setDbForTest(db);

  // createApp() mounts every router unconditionally, and routes/library.js
  // imports several other exports of libraryDiscovery.js
  // (getSimilarArtists, getRecommendations, reconstructPlaylist) that this
  // mock has no reason to touch. Spreading the real module's exports and
  // overriding only the two functions the playlist path calls keeps the rest
  // of the app's module graph intact.
  const realDiscovery = await import('../../src/services/libraryDiscovery.js');
  t.mock.module('../../src/services/libraryDiscovery.js', {
    exports: {
      ...realDiscovery,
      resolveSeedArtists: async (_db, names) => names.map((n) => ({ artist: n, mbArtistId: `mb-${n}` })),
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-nova', name: 'Nova', score: 1, via: ['Seed'], kind: 'similar' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../../src/services/listenBrainz.js', {
    exports: { getTopRecordings: async () => null },
  });

  const { createApp } = await import('../../src/app.js');
  server = createApp({ gate: (req, res, next) => next() }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Flow' })).json();

  const suggested = await (await postJson(`${baseUrl}/api/playlists/${created.id}/suggest`, {
    seedArtists: ['Seed'], target: 2,
  })).json();
  assert.equal(suggested.picked.length, 2, 'the default 60s-12min duration bound keeps Short out');
  assert.ok(suggested.picked.every((p) => p.title && p.title.startsWith('N')));

  // The point of this call: `suggested.picked` goes to /items completely
  // unmodified, exactly as a client that shows the review table and posts
  // back what wasn't unticked would send it. If the router needed a
  // different shape, this is where that trap would spring.
  const added = await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: suggested.picked,
  });
  assert.equal(added.status, 200);
  assert.equal((await added.json()).added, 2);

  const playlist = await (await fetch(`${baseUrl}/api/playlists/${created.id}`)).json();
  assert.equal(playlist.items.length, 2);
  const resolvedPaths = playlist.items.map((i) => i.track?.path);
  assert.ok(resolvedPaths.every(Boolean), 'every item resolved to a real file');
  const addedTitles = playlist.items.map((i) => i.title);

  const exported = await postJson(`${baseUrl}/api/playlists/${created.id}/export/m3u`, {});
  assert.equal(exported.status, 200);
  const m3uText = await fs.readFile(path.join(musicDir, 'Flow.m3u'), 'utf8');
  for (const full of resolvedPaths) {
    const relative = path.relative(musicDir, full).split(path.sep).join('/');
    assert.ok(m3uText.includes(relative), `${relative} named in the exported m3u`);
  }

  // existingKeys: suggest again on the SAME playlist, now that two of Nova's
  // tracks are already in it. A second proposal must not re-offer either one.
  const suggestedAgain = await (await postJson(`${baseUrl}/api/playlists/${created.id}/suggest`, {
    seedArtists: ['Seed'], target: 10,
  })).json();
  assert.equal(suggestedAgain.picked.length, 3, 'the 3 remaining Nova tracks, Short still excluded by duration');
  const secondTitles = suggestedAgain.picked.map((p) => p.title);
  for (const title of addedTitles) {
    assert.ok(!secondTitles.includes(title), `${title} was already added and must not be re-proposed`);
  }
});

test('target is clamped into range before it reaches the sampler', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Clamp' })).json();
  const suggest = (target) => postJson(`${baseUrl}/api/playlists/${created.id}/suggest`, {
    seedArtists: ['Seed'], target,
  }).then((r) => r.json());

  // Pool is 5 (Short stays out under the default duration bound). Nothing here
  // is ever added to the playlist, so existingKeys stays empty across all four
  // calls and the pool is the same 5 every time.
  assert.equal((await suggest(0)).picked.length, 5, 'target:0 is falsy and falls back to the 50 default');
  assert.equal((await suggest(-5)).picked.length, 1, 'a negative target clamps to the floor of 1, not 0');
  assert.equal((await suggest('abc')).picked.length, 5, 'an unparsable target falls back to the default');
  assert.equal((await suggest(Infinity)).picked.length, 5, 'Infinity clamps to the 1000 ceiling, pool still binds');
});

test('minMs: 0 is a real lower bound, not the 60s default', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Bounds' })).json();

  const withZero = await (await postJson(`${baseUrl}/api/playlists/${created.id}/suggest`, {
    seedArtists: ['Seed'], target: 10, minMs: 0,
  })).json();
  assert.ok(withZero.picked.some((p) => p.title === 'Short'), 'minMs:0 must let the 45s track through');

  const withDefault = await (await postJson(`${baseUrl}/api/playlists/${created.id}/suggest`, {
    seedArtists: ['Seed'], target: 10,
  })).json();
  assert.ok(!withDefault.picked.some((p) => p.title === 'Short'), 'no minMs still falls back to the 60s default');
});
