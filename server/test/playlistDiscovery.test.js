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
    namedExports: {
      resolveSeedArtists: async () => [{ artist: 'Portishead', mbArtistId: 'seed-1' }],
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-1', name: 'Massive Attack', score: 2, via: ['Portishead'], kind: 'both' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../src/services/listenBrainz.js', {
    namedExports: { getTopRecordings: async () => null },  // the live 500
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
    namedExports: {
      resolveSeedArtists: async () => [{ artist: 'P', mbArtistId: 'seed-1' }],
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-1', name: 'Massive Attack', score: 1, via: ['P'], kind: 'similar' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../src/services/listenBrainz.js', {
    namedExports: {
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
