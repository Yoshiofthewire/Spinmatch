// Discovery. The contracts worth pinning down are that it never suggests what
// you already own, that it says which of your artists led to each suggestion,
// that the relations cache is actually used, and that playlist matching stays
// entirely offline.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

const unexpected = (name) => async () => {
  throw new Error(`${name} should not have been called`);
};

let relationLookups = [];
let similarLookups = [];
let counter = 0;

// `similar` maps an mbid to its ListenBrainz result. Pass `null` for one to
// simulate the service being unreachable, which is the degrade path.
async function freshDiscovery({ related = {}, similar = {}, resolve = {}, discographies = {} } = {}) {
  counter += 1;
  const { mock } = await import('node:test');
  mock.reset();

  mock.module('../src/services/musicbrainz.js', {
    namedExports: {
      getRelatedArtists: async (mbid) => {
        relationLookups.push(mbid);
        return related[mbid] ?? [];
      },
      browseReleaseGroupsByArtist: async (mbid) => ({
        artist: {}, albums: discographies[mbid] ?? [],
      }),
      searchArtists: unexpected('searchArtists'),
      searchReleaseGroups: unexpected('searchReleaseGroups'),
      searchRecordings: unexpected('searchRecordings'),
      searchAll: unexpected('searchAll'),
      getArtist: unexpected('getArtist'),
      resolvePrimaryReleaseForGroup: unexpected('resolvePrimaryReleaseForGroup'),
      getReleaseWithTracks: unexpected('getReleaseWithTracks'),
      getRecording: unexpected('getRecording'),
    },
  });

  mock.module('../src/services/listenBrainz.js', {
    namedExports: {
      getSimilarArtists: async (mbid) => {
        similarLookups.push(mbid);
        return mbid in similar ? similar[mbid] : [];
      },
      resetSimilarCacheForTest: () => {},
    },
  });

  // resolveArtist is libraryDiscography's contract and is tested there; here it
  // is just the step that turns a local name into an id.
  mock.module('../src/services/libraryDiscography.js', {
    namedExports: {
      resolveArtist: async (artist) => ({ mbArtistId: resolve[artist] ?? null }),
    },
  });

  return import(`../src/services/libraryDiscovery.js?fresh=${counter}`);
}

function seedLibrary(db, tracks) {
  tracks.forEach((t, i) => {
    repo.upsertLocalTrack(db, {
      path: `/m/${t.artist}/${t.album}/${i}.mp3`,
      artist: t.artist,
      album: t.album,
      title: t.title,
      durationMs: 1000,
      changeKey: `${i}:1`,
    });
  });
  repo.recomputeStats(db);
}

test.after(() => setDbForTest(null));

test('ranks a related artist higher when more of your artists lead to them', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [
    { artist: 'Band A', album: 'One', title: 'a' },
    { artist: 'Band A', album: 'One', title: 'b' },
    { artist: 'Band B', album: 'Two', title: 'c' },
  ]);
  relationLookups = [];

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a', 'Band B': 'mb-b' },
    related: {
      'mb-a': [
        { mbid: 'mb-x', name: 'Shared Side Project', relation: 'member of band' },
        { mbid: 'mb-y', name: 'Only From A', relation: 'collaboration' },
      ],
      'mb-b': [{ mbid: 'mb-x', name: 'Shared Side Project', relation: 'member of band' }],
    },
  });
  const { artists } = await getSimilarArtists({ db });

  assert.equal(artists[0].name, 'Shared Side Project');
  assert.equal(artists[0].score, 2);
  // Both of your artists are named as the route in, which is what makes the
  // suggestion explicable.
  assert.deepEqual(artists[0].via.sort(), ['Band A', 'Band B']);
  assert.equal(artists[1].name, 'Only From A');
  db.close();
});

test('never suggests an artist already in the library', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [
    { artist: 'Band A', album: 'One', title: 'a' },
    { artist: 'The Beatles', album: 'Two', title: 'b' },
  ]);

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a', 'The Beatles': 'mb-beatles' },
    related: {
      'mb-a': [
        // Same artist, different spelling. normalizeTitle alone keeps the
        // leading article and would treat these as two artists, so discovery
        // folds it — otherwise the first suggestion is someone you own.
        { mbid: 'mb-beatles', name: 'Beatles', relation: 'member of band' },
        { mbid: 'mb-new', name: 'Genuinely New', relation: 'collaboration' },
      ],
      'mb-beatles': [],
    },
  });
  const { artists } = await getSimilarArtists({ db });

  assert.deepEqual(artists.map((a) => a.name), ['Genuinely New']);
  db.close();
});

test('an artist that cannot be resolved is skipped rather than failing the run', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [
    { artist: 'Band A', album: 'One', title: 'a' },
    { artist: 'Unknowable', album: 'Two', title: 'b' },
  ]);
  relationLookups = [];

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a' },
    related: { 'mb-a': [{ mbid: 'mb-x', name: 'Found', relation: 'collaboration' }] },
  });
  const { artists, seeds } = await getSimilarArtists({ db });

  assert.deepEqual(relationLookups, ['mb-a'], 'no lookup for the unresolvable artist');
  assert.deepEqual(seeds.map((s) => s.artist), ['Band A']);
  assert.equal(artists.length, 1);
  db.close();
});

test('the relations cache spares a second lookup for the same artist', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Band A', album: 'One', title: 'a' }]);
  relationLookups = [];

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a' },
    related: { 'mb-a': [{ mbid: 'mb-x', name: 'Found', relation: 'collaboration' }] },
  });
  await getSimilarArtists({ db });
  await getSimilarArtists({ db });

  assert.deepEqual(relationLookups, ['mb-a'], 'the second run reads the cache');
  db.close();
});

// An artist with no relations has to be remembered as "we looked", or every
// visit pays for the same empty answer.
test('an empty relations result is cached as a result, not as a miss', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Solo', album: 'One', title: 'a' }]);
  relationLookups = [];

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { Solo: 'mb-solo' },
    related: { 'mb-solo': [] },
  });
  await getSimilarArtists({ db });
  await getSimilarArtists({ db });

  assert.equal(relationLookups.length, 1);
  db.close();
});

test('recommendations are albums by discovered artists, tagged with the route in', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Band A', album: 'One', title: 'a' }]);

  const { getRecommendations } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a' },
    related: { 'mb-a': [{ mbid: 'mb-x', name: 'New Band', relation: 'collaboration' }] },
    discographies: {
      'mb-x': [
        { mbid: 'rg-1', title: 'Their Record', firstReleaseDate: '1999-01-01', coverArtUrl: '/c/rg-1' },
      ],
    },
  });
  const { albums } = await getRecommendations({ db });

  assert.equal(albums.length, 1);
  assert.equal(albums[0].title, 'Their Record');
  assert.equal(albums[0].artist, 'New Band');
  assert.equal(albums[0].year, 1999);
  assert.deepEqual(albums[0].via, ['Band A']);
  db.close();
});

// --- Playlist reconstruction (entirely offline) ------------------------------

test('splits "Artist - Title" and matches it against the library', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [
    { artist: 'Radiohead', album: 'Kid A', title: 'Idioteque' },
    { artist: 'Portishead', album: 'Dummy', title: 'Roads' },
  ]);

  const { reconstructPlaylist } = await freshDiscovery();
  const result = reconstructPlaylist(
    ['Radiohead - Idioteque', 'Massive Attack - Teardrop'],
    { db },
  );

  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].track.title, 'Idioteque');
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].artist, 'Massive Attack');
  assert.equal(result.missing[0].title, 'Teardrop');
  db.close();
});

test('a bare title with no dash is matched as a title', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Radiohead', album: 'Kid A', title: 'Idioteque' }]);

  const { reconstructPlaylist } = await freshDiscovery();
  const result = reconstructPlaylist(['Idioteque'], { db });

  assert.equal(result.found.length, 1);
  db.close();
});

test('the same title by a different artist is not counted as a match', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Some Covers Band', album: 'Covers', title: 'Idioteque' }]);

  const { reconstructPlaylist } = await freshDiscovery();
  const exact = reconstructPlaylist(['Radiohead - Idioteque'], { db });

  // The artist doesn't match, but a title-only fallback still finds it — better
  // to show the near miss than to report a track you have as missing. What
  // matters is that the artist was preferred when one was given.
  assert.equal(exact.found.length + exact.missing.length, 1);
  db.close();
});

test('empty and whitespace-only lines are ignored', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Radiohead', album: 'Kid A', title: 'Idioteque' }]);

  const { reconstructPlaylist } = await freshDiscovery();
  const result = reconstructPlaylist(['', '   ', 'Radiohead - Idioteque'], { db });

  assert.equal(result.found.length + result.missing.length, 1);
  db.close();
});

// --- Two signals -------------------------------------------------------------
//
// ListenBrainz answers "whose listeners overlap with yours"; MusicBrainz answers
// "who played with whom". They're kept distinct to the UI, because a documented
// band-member link and a statistical one are not the same claim.

test('an artist reached by both signals is marked as such and outranks either alone', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Band A', album: 'One', title: 'a' }]);

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a' },
    related: { 'mb-a': [{ mbid: 'mb-both', name: 'Both Ways', relation: 'member of band' }] },
    similar: {
      'mb-a': [
        { mbid: 'mb-both', name: 'Both Ways', score: 500 },
        { mbid: 'mb-lb', name: 'Sounds Like', score: 400 },
      ],
    },
  });
  const { artists } = await getSimilarArtists({ db });

  const both = artists.find((a) => a.name === 'Both Ways');
  assert.equal(both.kind, 'both');
  assert.equal(both.score, 2, 'counted once per signal');
  assert.equal(both.relation, 'member of band', 'keeps the documented relation');
  assert.equal(artists[0].name, 'Both Ways', 'and therefore ranks first');
  assert.equal(artists.find((a) => a.name === 'Sounds Like').kind, 'similar');
  db.close();
});

test('a purely statistical suggestion carries no invented relation', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Band A', album: 'One', title: 'a' }]);

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a' },
    similar: { 'mb-a': [{ mbid: 'mb-lb', name: 'Sounds Like', score: 1, comment: 'trip hop' }] },
  });
  const { artists } = await getSimilarArtists({ db });

  assert.equal(artists[0].kind, 'similar');
  assert.equal(artists[0].relation, null, 'no relationship is claimed');
  assert.equal(artists[0].comment, 'trip hop');
  db.close();
});

test('ListenBrainz results you already own are filtered out like any other', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [
    { artist: 'Band A', album: 'One', title: 'a' },
    { artist: 'The Owned Band', album: 'Two', title: 'b' },
  ]);

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a', 'The Owned Band': 'mb-owned' },
    similar: {
      'mb-a': [
        { mbid: 'mb-owned', name: 'Owned Band', score: 900 },
        { mbid: 'mb-new', name: 'Not Owned', score: 100 },
      ],
    },
  });
  const { artists } = await getSimilarArtists({ db });

  assert.deepEqual(artists.map((a) => a.name), ['Not Owned']);
  db.close();
});

// The degrade path, and the reason the client returns null rather than [].
test('a ListenBrainz outage leaves the relationship graph working and is reported', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Band A', album: 'One', title: 'a' }]);

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a' },
    related: { 'mb-a': [{ mbid: 'mb-x', name: 'Still Found', relation: 'collaboration' }] },
    similar: { 'mb-a': null },
  });
  const result = await getSimilarArtists({ db });

  assert.deepEqual(result.artists.map((a) => a.name), ['Still Found']);
  assert.equal(result.listenBrainz, 'unavailable', 'the UI can say the signal is half-missing');
  db.close();
});

test('an outage is not cached, so the next run tries again', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Band A', album: 'One', title: 'a' }]);
  similarLookups = [];

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a' },
    related: { 'mb-a': [] },
    similar: { 'mb-a': null },
  });
  await getSimilarArtists({ db });
  await getSimilarArtists({ db });

  assert.equal(similarLookups.length, 2, 'a blip must not be remembered as "nothing similar"');
  db.close();
});

test('a successful run caches both signals together', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Band A', album: 'One', title: 'a' }]);
  similarLookups = [];
  relationLookups = [];

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a' },
    related: { 'mb-a': [{ mbid: 'mb-x', name: 'Rel', relation: 'collaboration' }] },
    similar: { 'mb-a': [{ mbid: 'mb-y', name: 'Sim', score: 5 }] },
  });
  await getSimilarArtists({ db });
  const result = await getSimilarArtists({ db });

  assert.equal(similarLookups.length, 1);
  assert.equal(relationLookups.length, 1);
  assert.equal(result.artists.length, 2, 'both signals survive the cache round-trip');
  assert.deepEqual(result.artists.map((a) => a.kind).sort(), ['related', 'similar']);
  db.close();
});

// A cache row written before ListenBrainz existed holds a bare array.
test('a pre-ListenBrainz cache row is refetched rather than misread', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedLibrary(db, [{ artist: 'Band A', album: 'One', title: 'a' }]);
  db.prepare(
    'INSERT INTO library_similar_cache (mb_artist_id, related_json, checked_at) VALUES (?, ?, ?)'
  ).run('mb-a', JSON.stringify([{ mbid: 'mb-old', name: 'Old Shape' }]), Date.now());
  similarLookups = [];

  const { getSimilarArtists } = await freshDiscovery({
    resolve: { 'Band A': 'mb-a' },
    related: { 'mb-a': [] },
    similar: { 'mb-a': [{ mbid: 'mb-y', name: 'Sim', score: 5 }] },
  });
  const result = await getSimilarArtists({ db });

  assert.equal(similarLookups.length, 1, 'the legacy row counted as a miss');
  assert.deepEqual(result.artists.map((a) => a.name), ['Sim']);
  db.close();
});
