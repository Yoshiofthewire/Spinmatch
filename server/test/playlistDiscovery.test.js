import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

// Node's ESM module cache holds playlistDiscovery.js itself across tests in
// this file (only the specifiers passed to t.mock.module get cache-busted by
// the mock loader, not their importers). Without a unique query string per
// import, the second test's mock.module registrations would be invisible:
// playlistDiscovery.js would still be bound to the FIRST test's mocked
// collectNeighbours/getTopRecordings. A counter forces a fresh module
// instance — and fresh imports of its now-currently-mocked dependencies —
// each time.
let importCount = 0;
function importSuggestTracks() {
  return import(`../src/services/playlistDiscovery.js?t=${importCount++}`);
}

test('builds a pool from owned neighbours and reports popularity being down', async (t) => {
  const db = openDb(':memory:');
  for (let i = 1; i <= 4; i += 1) {
    repo.upsertLocalTrack(db, {
      path: `/m/MA/Mez/0${i}.flac`, artist: 'Massive Attack', album: 'Mezzanine',
      title: `T${i}`, durationMs: 200_000, sizeBytes: 1000, year: 1998,
      trackNumber: i, changeKey: `${i}:1`,
    });
  }
  // A track that must not survive the duration filter.
  repo.upsertLocalTrack(db, {
    path: '/m/MA/Mez/99.flac', artist: 'Massive Attack', album: 'Mezzanine',
    title: 'Silence', durationMs: 900_000, sizeBytes: 1000, changeKey: '99:1',
  });

  t.mock.module('../src/services/libraryDiscovery.js', {
    exports: {
      resolveSeedArtists: async () => [{ artist: 'Portishead', mbArtistId: 'seed-1' }],
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-1', name: 'Massive Attack', score: 2, via: ['Portishead'], kind: 'both' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../src/services/listenBrainz.js', {
    exports: { getTopRecordings: async () => null },  // the live 500
  });

  const { suggestTracks } = await importSuggestTracks();
  const result = await suggestTracks(db, { seedArtists: ['Portishead'], method: 'popular', target: 3 });

  assert.equal(result.picked.length, 3);
  assert.ok(result.picked.every((p) => p.artist === 'Massive Attack'));
  assert.ok(!result.picked.some((p) => p.title === 'Silence'), 'the 15-minute track is filtered out');
  assert.equal(result.popularity, 'unavailable');
  // With no ranks, popular falls back to year then track number.
  assert.deepEqual(result.picked.map((p) => p.title), ['T1', 'T2', 'T3']);
  db.close();
});

test('ranks owned tracks by the popularity list when it answers', async (t) => {
  const db = openDb(':memory:');
  ['Alpha', 'Beta', 'Gamma'].forEach((title, i) => {
    repo.upsertLocalTrack(db, {
      path: `/m/MA/${title}.flac`, artist: 'Massive Attack', album: 'Mezzanine',
      title, durationMs: 200_000, sizeBytes: 1000, year: 1998, trackNumber: i + 1,
      changeKey: `${i}:1`,
    });
  });

  t.mock.module('../src/services/libraryDiscovery.js', {
    exports: {
      resolveSeedArtists: async () => [{ artist: 'P', mbArtistId: 'seed-1' }],
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-1', name: 'Massive Attack', score: 1, via: ['P'], kind: 'similar' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../src/services/listenBrainz.js', {
    exports: {
      getTopRecordings: async () => [
        { name: 'Gamma', recordingMbid: null, listenCount: 900 },
        { name: 'Alpha', recordingMbid: null, listenCount: 100 },
      ],
    },
  });

  const { suggestTracks } = await importSuggestTracks();
  const result = await suggestTracks(db, { seedArtists: ['P'], method: 'popular', target: 3 });

  assert.deepEqual(result.picked.map((p) => p.title), ['Gamma', 'Alpha', 'Beta']);
  assert.equal(result.popularity, 'ok');
  db.close();
});

test('two owned copies of one recording are proposed once, keeping the better file', async (t) => {
  const db = openDb(':memory:');
  // The spec's own example: you own Creep on Pablo Honey and on a compilation.
  // Both fold to one matchKey, both take the same popularityRank (rankTracks
  // folds on titleKey), so they sorted adjacent and were both picked.
  repo.upsertLocalTrack(db, {
    path: '/m/RH/Pablo Honey/03.flac', artist: 'Radiohead', album: 'Pablo Honey',
    title: 'Creep', durationMs: 240_000, sizeBytes: 40_000_000, year: 1993,
    trackNumber: 3, changeKey: '1:1',
  });
  repo.upsertLocalTrack(db, {
    path: '/m/RH/Hits/07.mp3', artist: 'Radiohead', album: 'Greatest Hits',
    title: 'Creep', durationMs: 240_000, sizeBytes: 7_000_000, year: 2008,
    trackNumber: 7, changeKey: '2:1',
  });

  t.mock.module('../src/services/libraryDiscovery.js', {
    exports: {
      resolveSeedArtists: async () => [{ artist: 'P', mbArtistId: 'seed-1' }],
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-1', name: 'Radiohead', score: 1, via: ['P'], kind: 'similar' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../src/services/listenBrainz.js', {
    exports: { getTopRecordings: async () => [{ name: 'Creep', recordingMbid: null, listenCount: 9 }] },
  });

  const { suggestTracks } = await importSuggestTracks();
  const result = await suggestTracks(db, { seedArtists: ['P'], method: 'popular', target: 10 });

  assert.equal(result.picked.length, 1, 'one recording, one proposal');
  // playlistRepo.preferBest's tie-break with no album named: the larger file.
  assert.equal(result.picked[0].album, 'Pablo Honey');
  db.close();
});

test('Chance does not pay for popularity data its ordering ignores', async (t) => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: '/m/MA/one.flac', artist: 'Massive Attack', album: 'Mezzanine',
    title: 'One', durationMs: 200_000, sizeBytes: 1000, year: 1998,
    trackNumber: 1, changeKey: '1:1',
  });

  let asked = 0;
  t.mock.module('../src/services/libraryDiscovery.js', {
    exports: {
      resolveSeedArtists: async () => [{ artist: 'P', mbArtistId: 'seed-1' }],
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-1', name: 'Massive Attack', score: 1, via: ['P'], kind: 'similar' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../src/services/listenBrainz.js', {
    exports: { getTopRecordings: async () => { asked += 1; return null; } },
  });

  const { suggestTracks } = await importSuggestTracks();
  const result = await suggestTracks(db, { seedArtists: ['P'], method: 'random', target: 1 });

  assert.equal(asked, 0, 'a shuffle never reads popularityRank, so it never asks for it');
  assert.equal(result.picked.length, 1);
  // Not 'unavailable': nothing was asked, so nothing can be reported down.
  assert.equal(result.popularity, 'unused');
  db.close();
});

test('a folded-title collision in the popularity list keeps the more-listened rank', async (t) => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: '/m/MA/Teardrop.flac', artist: 'Massive Attack', album: 'Mezzanine',
    title: 'Teardrop', durationMs: 200_000, sizeBytes: 1000, year: 1998,
    trackNumber: 1, changeKey: '1:1',
  });
  repo.upsertLocalTrack(db, {
    path: '/m/MA/Control.flac', artist: 'Massive Attack', album: 'Mezzanine',
    title: 'Control', durationMs: 200_000, sizeBytes: 1000, year: 1998,
    trackNumber: 2, changeKey: '2:1',
  });

  t.mock.module('../src/services/libraryDiscovery.js', {
    exports: {
      resolveSeedArtists: async () => [{ artist: 'P', mbArtistId: 'seed-1' }],
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-1', name: 'Massive Attack', score: 1, via: ['P'], kind: 'similar' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../src/services/listenBrainz.js', {
    exports: {
      // 'Teardrop' (rank 0, the hit) and 'Teardrop (Remaster)' both fold to
      // the titleKey 'teardrop'. rankTracks must keep the FIRST — most
      // listened — occurrence. A regression to last-wins would overwrite
      // Teardrop's rank with the obscure remaster's index (2), demoting it
      // behind Control (rank 1) — the assertion below is what would catch
      // that: with the correct first-wins rule Teardrop still outranks
      // Control.
      getTopRecordings: async () => [
        { name: 'Teardrop', recordingMbid: null, listenCount: 999 },
        { name: 'Control', recordingMbid: null, listenCount: 500 },
        { name: 'Teardrop (Remaster)', recordingMbid: null, listenCount: 1 },
      ],
    },
  });

  const { suggestTracks } = await importSuggestTracks();
  const result = await suggestTracks(db, { seedArtists: ['P'], method: 'popular', target: 2 });

  assert.deepEqual(
    result.picked.map((p) => p.title), ['Teardrop', 'Control'],
    'Teardrop keeps its rank-0 popularity, not the remaster\'s rank-2',
  );
  db.close();
});

test('an empty popularity list is a real answer, not an outage', async (t) => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: '/m/MA/one.flac', artist: 'Massive Attack', album: 'Mezzanine',
    title: 'One', durationMs: 200_000, sizeBytes: 1000, year: 1998,
    trackNumber: 1, changeKey: '1:1',
  });

  t.mock.module('../src/services/libraryDiscovery.js', {
    exports: {
      resolveSeedArtists: async () => [{ artist: 'P', mbArtistId: 'seed-1' }],
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-1', name: 'Massive Attack', score: 1, via: ['P'], kind: 'similar' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../src/services/listenBrainz.js', {
    // [] means ListenBrainz answered and this artist has no recorded
    // listens — a real result, not the 500 that getTopRecordings turns into
    // null. Reporting 'unavailable' here would be a false claim of outage.
    exports: { getTopRecordings: async () => [] },
  });

  const { suggestTracks } = await importSuggestTracks();
  const result = await suggestTracks(db, { seedArtists: ['P'], method: 'popular', target: 1 });

  assert.equal(result.picked.length, 1);
  assert.equal(result.popularity, 'ok');
  db.close();
});

test('prefer-popular still asks, because the shuffle narrows on the answer', async (t) => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: '/m/MA/two.flac', artist: 'Massive Attack', album: 'Mezzanine',
    title: 'Two', durationMs: 200_000, sizeBytes: 1000, year: 1998,
    trackNumber: 1, changeKey: '1:1',
  });

  let asked = 0;
  t.mock.module('../src/services/libraryDiscovery.js', {
    exports: {
      resolveSeedArtists: async () => [{ artist: 'P', mbArtistId: 'seed-1' }],
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-1', name: 'Massive Attack', score: 1, via: ['P'], kind: 'similar' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../src/services/listenBrainz.js', {
    exports: { getTopRecordings: async () => { asked += 1; return null; } },
  });

  const { suggestTracks } = await importSuggestTracks();
  const result = await suggestTracks(db, {
    seedArtists: ['P'], method: 'random', preferPopular: true, target: 1,
  });

  assert.equal(asked, 1);
  assert.equal(result.popularity, 'unavailable');
  db.close();
});
