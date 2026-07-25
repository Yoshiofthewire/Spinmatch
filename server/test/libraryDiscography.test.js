import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

// Mocking a module replaces it wholesale, so the mock has to expose every export
// anything in the import graph binds to — libraryDiscography pulls in
// libraryGaps, which imports the release lookups. Tests override just the parts
// they exercise; anything left at the default throws if unexpectedly called.
const unexpected = (name) => async () => {
  throw new Error(`${name} should not have been called`);
};

const DEFAULT_MB = {
  searchArtists: unexpected('searchArtists'),
  searchReleaseGroups: unexpected('searchReleaseGroups'),
  searchRecordings: unexpected('searchRecordings'),
  searchAll: unexpected('searchAll'),
  getArtist: unexpected('getArtist'),
  browseReleaseGroupsByArtist: unexpected('browseReleaseGroupsByArtist'),
  resolvePrimaryReleaseForGroup: unexpected('resolvePrimaryReleaseForGroup'),
  getReleaseWithTracks: unexpected('getReleaseWithTracks'),
  getRecording: unexpected('getRecording'),
};

let counter = 0;
// Same module-mock pattern as libraryGaps.test.js: reset before each
// registration, then import with a cache-busting suffix.
async function freshDiscography(mbMocks) {
  counter += 1;
  const { mock } = await import('node:test');
  mock.reset();
  mock.module('../src/services/musicbrainz.js', {
    namedExports: { ...DEFAULT_MB, ...mbMocks },
  });
  return import(`../src/services/libraryDiscography.js?fresh=${counter}`);
}

function dbWith(albums, artist = 'Band') {
  const db = openDb(':memory:');
  albums.forEach((album, i) => {
    repo.upsertLocalTrack(db, {
      path: `/m/${artist}/${album}/01.mp3`,
      artist, album, title: `T${i}`, durationMs: 1000, changeKey: `${i}:1`,
    });
  });
  setDbForTest(db);
  return db;
}

const RADIOHEAD = { mbid: 'artist-1', name: 'Band', score: 100 };

test('missing albums are the MusicBrainz discography minus what is owned', async () => {
  const db = dbWith(['The Bends']);
  const { getArtistDiscography } = await freshDiscography({
    searchArtists: async () => [RADIOHEAD],
    browseReleaseGroupsByArtist: async () => ({
      artist: { mbid: 'artist-1', name: 'Band' },
      albums: [
        { mbid: 'rg-1', title: 'The Bends', firstReleaseDate: '1995-03-13', coverArtUrl: '/c/1' },
        { mbid: 'rg-2', title: 'Kid A', firstReleaseDate: '2000-10-02', coverArtUrl: '/c/2' },
      ],
    }),
  });

  const result = await getArtistDiscography('Band', { db });
  assert.equal(result.owned.length, 1);
  assert.equal(result.owned[0].title, 'The Bends');
  assert.deepEqual(result.missing.map((m) => m.title), ['Kid A']);
  assert.equal(result.missing[0].year, 2000);
  setDbForTest(null);
  db.close();
});

test('a parenthetical local edition still counts as owning the album', async () => {
  // The point of normalizeTitle: "Kid A (Deluxe Edition)" on disk must not be
  // reported as missing "Kid A".
  const db = dbWith(['Kid A (Deluxe Edition)']);
  const { getArtistDiscography } = await freshDiscography({
    searchArtists: async () => [RADIOHEAD],
    browseReleaseGroupsByArtist: async () => ({
      artist: { mbid: 'artist-1', name: 'Band' },
      albums: [{ mbid: 'rg-2', title: 'Kid A', firstReleaseDate: '2000-10-02', coverArtUrl: '/c/2' }],
    }),
  });

  const result = await getArtistDiscography('Band', { db });
  assert.deepEqual(result.missing, []);
  assert.equal(result.owned.length, 1);
  setDbForTest(null);
  db.close();
});

test('an ambiguous artist returns candidates instead of guessing', async () => {
  const db = dbWith(['Some Album']);
  const { getArtistDiscography } = await freshDiscography({
    searchArtists: async () => [
      { mbid: 'a', name: 'Band', score: 60 },
      { mbid: 'b', name: 'Band (UK)', score: 55 },
    ],
    browseReleaseGroupsByArtist: async () => { throw new Error('must not be called'); },
  });

  const result = await getArtistDiscography('Band', { db });
  assert.equal(result.unresolved, true);
  assert.equal(result.mbArtistId, null);
  assert.equal(result.candidates.length, 2);
  // The local albums still come back, so the view can render them.
  assert.equal(result.owned.length, 1);
  setDbForTest(null);
  db.close();
});

test('an upstream failure propagates as an error rather than an empty diff', async () => {
  // A silent empty result would read as "you own everything", which is worse
  // than an error banner — so this must throw and let the panel report it.
  const db = dbWith(['Some Album']);
  const { getArtistDiscography } = await freshDiscography({
    searchArtists: async () => { throw new Error("Could not reach MusicBrainz"); },
    browseReleaseGroupsByArtist: async () => ({ artist: {}, albums: [] }),
  });

  await assert.rejects(
    () => getArtistDiscography('Band', { db }),
    /Could not reach MusicBrainz/,
  );
  setDbForTest(null);
  db.close();
});

test('a resolved artist id is cached so the next call skips the search', async () => {
  const db = dbWith(['The Bends']);
  let searches = 0;
  const { getArtistDiscography } = await freshDiscography({
    searchArtists: async () => {
      searches += 1;
      return [RADIOHEAD];
    },
    browseReleaseGroupsByArtist: async () => ({
      artist: { mbid: 'artist-1', name: 'Band' },
      albums: [{ mbid: 'rg-1', title: 'The Bends', firstReleaseDate: '1995', coverArtUrl: '/c/1' }],
    }),
  });

  await getArtistDiscography('Band', { db });
  await getArtistDiscography('Band', { db });
  assert.equal(searches, 1, 'the artist search should be cached');
  setDbForTest(null);
  db.close();
});

test('album resolution rejects a loose title match', async () => {
  // MusicBrainz search always returns something. If a top hit were accepted
  // blindly, the panel would show another album's tracklist and report every
  // one of its tracks as missing.
  const db = dbWith(['OK Computer']);
  const { resolveAlbum } = await freshDiscography({
    searchArtists: async () => [RADIOHEAD],
    searchReleaseGroups: async () => [
      { mbid: 'wrong-1', title: 'OK Computer OKNOTOK 1997 2017', score: 95 },
      { mbid: 'wrong-2', title: 'Computer World', score: 80 },
    ],
    browseReleaseGroupsByArtist: async () => ({ artist: {}, albums: [] }),
  });

  const result = await resolveAlbum('Band', 'OK Computer', { db });
  assert.equal(result.releaseGroupMbid, null, 'neither title normalizes to "ok computer"');
  setDbForTest(null);
  db.close();
});

test('album resolution accepts an exact normalized title and caches it', async () => {
  const db = dbWith(['OK Computer']);
  let searches = 0;
  const { resolveAlbum } = await freshDiscography({
    searchArtists: async () => [RADIOHEAD],
    searchReleaseGroups: async () => {
      searches += 1;
      return [
        { mbid: 'wrong', title: 'Something Else', score: 99 },
        { mbid: 'right', title: 'OK Computer', score: 70 },
      ];
    },
    browseReleaseGroupsByArtist: async () => ({ artist: {}, albums: [] }),
  });

  // Lower-scoring exact match wins over the higher-scoring wrong title.
  assert.equal((await resolveAlbum('Band', 'OK Computer', { db })).releaseGroupMbid, 'right');
  assert.equal((await resolveAlbum('Band', 'OK Computer', { db })).releaseGroupMbid, 'right');
  assert.equal(searches, 1, 'the resolution should be cached');
  setDbForTest(null);
  db.close();
});

test('albums on disk that MusicBrainz does not list are surfaced, not hidden', async () => {
  const db = dbWith(['Live At Glastonbury']);
  const { getArtistDiscography } = await freshDiscography({
    searchArtists: async () => [RADIOHEAD],
    browseReleaseGroupsByArtist: async () => ({
      artist: { mbid: 'artist-1', name: 'Band' },
      albums: [{ mbid: 'rg-1', title: 'The Bends', firstReleaseDate: '1995', coverArtUrl: '/c/1' }],
    }),
  });

  const result = await getArtistDiscography('Band', { db });
  assert.deepEqual(result.unmatchedLocal, ['Live At Glastonbury']);
  assert.deepEqual(result.missing.map((m) => m.title), ['The Bends']);
  setDbForTest(null);
  db.close();
});
