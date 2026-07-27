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

const RADIOHEAD = { mbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Band', score: 100 };

test('missing albums are the MusicBrainz discography minus what is owned', async () => {
  const db = dbWith(['The Bends']);
  const { getArtistDiscography } = await freshDiscography({
    searchArtists: async () => [RADIOHEAD],
    browseReleaseGroupsByArtist: async () => ({
      artist: { mbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Band' },
      albums: [
        { mbid: '11111111-1111-4111-8111-111111111111', title: 'The Bends', firstReleaseDate: '1995-03-13', coverArtUrl: '/c/1' },
        { mbid: '44444444-4444-4444-8444-444444444444', title: 'Kid A', firstReleaseDate: '2000-10-02', coverArtUrl: '/c/2' },
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
      artist: { mbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Band' },
      albums: [{ mbid: '44444444-4444-4444-8444-444444444444', title: 'Kid A', firstReleaseDate: '2000-10-02', coverArtUrl: '/c/2' }],
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
      artist: { mbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Band' },
      albums: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'The Bends', firstReleaseDate: '1995', coverArtUrl: '/c/1' }],
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
      artist: { mbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Band' },
      albums: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'The Bends', firstReleaseDate: '1995', coverArtUrl: '/c/1' }],
    }),
  });

  const result = await getArtistDiscography('Band', { db });
  assert.deepEqual(result.unmatchedLocal, ['Live At Glastonbury']);
  assert.deepEqual(result.missing.map((m) => m.title), ['The Bends']);
  setDbForTest(null);
  db.close();
});

// A wrong auto-accepted guess used to be permanent: positive results had no TTL,
// the `confirmed` column was written but never read, and there was no way to
// clear one without opening the database by hand.
test('an unconfirmed guess is re-checked later, while a user-confirmed one is kept', async () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/A/Al/1.mp3', artist: 'Ambiguous', album: 'Al', title: 'T', durationMs: 1000, changeKey: '1:1' });
  setDbForTest(db);

  let searches = 0;
  const mod = await freshDiscography({
    searchArtists: async () => {
      searches += 1;
      return [{ mbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Ambiguous', score: 100 }];
    },
  });

  // First call resolves and remembers it as an unconfirmed guess.
  assert.equal((await mod.resolveArtist('Ambiguous', { db })).mbArtistId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(searches, 1);
  // Straight away, the cache answers.
  await mod.resolveArtist('Ambiguous', { db });
  assert.equal(searches, 1);

  // Backdate the check past the re-verification window: an unconfirmed guess is
  // looked up again rather than trusted forever.
  db.prepare('UPDATE library_artist_links SET checked_at = 0').run();
  await mod.resolveArtist('Ambiguous', { db });
  assert.equal(searches, 2, 'a stale unconfirmed guess should be re-checked');

  // A choice the user made explicitly is kept regardless of age.
  mod.saveArtistLink(db, { artist: 'Ambiguous', mbArtistId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', confirmed: 1 });
  db.prepare('UPDATE library_artist_links SET checked_at = 0').run();
  const confirmed = await mod.resolveArtist('Ambiguous', { db });
  assert.equal(confirmed.mbArtistId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(searches, 2, 'a confirmed choice should never be re-searched');

  // And it can be forgotten on request.
  assert.equal(mod.deleteArtistLink(db, 'Ambiguous'), true);
  assert.equal(mod.getArtistLink(db, 'Ambiguous'), null);
  db.close();
});

// --- Joined artist credits ---------------------------------------------------
//
// A quarter of a real 1000-artist library is rows like "Justice & Thundercat"
// that resolve to nothing, stranding the artist they lead with. The fallback
// recovers those, and the tests below pin the two guards that keep it from
// inventing matches.

// Seeds the joined-credit row plus, optionally, the primary artist as its own
// separate row — which is the condition the fallback requires.
function dbWithCredit({ credit, primary }) {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: `/m/${credit}/A/01.mp3`, artist: credit, album: 'A', title: 'T1',
    durationMs: 1000, changeKey: '1:1',
  });
  if (primary) {
    repo.upsertLocalTrack(db, {
      path: `/m/${primary}/B/01.mp3`, artist: primary, album: 'B', title: 'T2',
      durationMs: 1000, changeKey: '2:1',
    });
  }
  setDbForTest(db);
  return db;
}

test('a joined credit resolves through its primary artist when that artist is owned', async () => {
  const db = dbWithCredit({ credit: 'Nine Inch Nails / Stephen Morris', primary: 'Nine Inch Nails' });
  const searched = [];
  const { resolveArtist } = await freshDiscography({
    searchArtists: async (q) => {
      searched.push(q);
      // The full credit string matches nothing, exactly as upstream behaves.
      return q.includes('Stephen Morris')
        ? []
        : [{ mbid: 'nnnnnnnn-nnnn-4nnn-8nnn-nnnnnnnnnnnn', name: 'Nine Inch Nails', score: 100 }];
    },
  });

  const result = await resolveArtist('Nine Inch Nails / Stephen Morris', { db });
  assert.equal(result.mbArtistId, 'nnnnnnnn-nnnn-4nnn-8nnn-nnnnnnnnnnnn');
  assert.equal(result.via, 'Nine Inch Nails', 'reports which artist it matched through');
  assert.equal(searched.length, 2, 'the whole string is tried before the split');
  setDbForTest(null);
  db.close();
});

// The guard that matters. MusicBrainz has a real artist exactly named
// "Florence" (a Dutch techno producer), so trusting a name match here would
// link "Florence + The Machine" to the wrong act with full confidence.
test('a joined credit is NOT resolved when the primary artist is not separately owned', async () => {
  const db = dbWithCredit({ credit: 'Florence + The Machine', primary: null });
  let searchedPrimary = false;
  const { resolveArtist } = await freshDiscography({
    searchArtists: async (q) => {
      if (q.includes('Florence"')) searchedPrimary = true;
      return [];
    },
  });

  const result = await resolveArtist('Florence + The Machine', { db });
  assert.equal(result.mbArtistId, null);
  assert.equal(result.via, undefined);
  assert.equal(searchedPrimary, false, 'the unowned segment is never even looked up');
  setDbForTest(null);
  db.close();
});

// Ordering is the other guard: a name that resolves whole must never be split,
// because a library really can contain a separate artist named "She".
test('a real band name that resolves whole is never split', async () => {
  const db = dbWithCredit({ credit: 'She & Him', primary: 'She' });
  const searched = [];
  const { resolveArtist } = await freshDiscography({
    searchArtists: async (q) => {
      searched.push(q);
      return [{ mbid: 'ssssssss-ssss-4sss-8sss-ssssssssssss', name: 'She & Him', score: 100 }];
    },
  });

  const result = await resolveArtist('She & Him', { db });
  assert.equal(result.mbArtistId, 'ssssssss-ssss-4sss-8sss-ssssssssssss');
  assert.equal(result.via, undefined, 'matched whole, not through a split');
  assert.equal(searched.length, 1, 'no fallback search happened');
  setDbForTest(null);
  db.close();
});

test('a credit resolution is remembered against the original string', async () => {
  const db = dbWithCredit({ credit: 'Justice & Thundercat', primary: 'Justice' });
  let calls = 0;
  const { resolveArtist } = await freshDiscography({
    searchArtists: async (q) => {
      calls += 1;
      return q.includes('Thundercat')
        ? []
        : [{ mbid: 'jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj', name: 'Justice', score: 100 }];
    },
  });

  await resolveArtist('Justice & Thundercat', { db });
  const before = calls;
  const again = await resolveArtist('Justice & Thundercat', { db });

  assert.equal(calls, before, 'the second call makes no upstream request');
  assert.equal(again.cached, true);
  assert.equal(again.mbArtistId, 'jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj');
  setDbForTest(null);
  db.close();
});

test('the fallback does not recurse past one level', async () => {
  // The primary is resolved with the fallback disabled, so a pathological name
  // can't drive an unbounded chain of splits and searches.
  const db = dbWithCredit({ credit: 'Alpha feat. Beta', primary: 'Alpha' });
  const searched = [];
  const { resolveArtist } = await freshDiscography({
    searchArtists: async (q) => { searched.push(q); return []; },
  });

  const result = await resolveArtist('Alpha feat. Beta', { db });
  assert.equal(result.mbArtistId, null);
  assert.equal(searched.length, 2, 'full string, then the primary — and no further');
  setDbForTest(null);
  db.close();
});

// ---------- resolveMissingTrack ----------
//
// Turns a hole in the local numbering into a named track. The interesting cases
// aren't the happy path — they're the three ways it can fail to place a position,
// because each one means something different to the person looking at the row.

const KID_A_RG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KID_A_RELEASE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function kidATracks() {
  return [
    { position: 1, discNumber: 1, recordingMbid: 'rec-1', title: 'Everything In Its Right Place', artist: 'Radiohead', lengthMs: 251000 },
    { position: 2, discNumber: 1, recordingMbid: 'rec-2', title: 'Kid A', artist: 'Radiohead', lengthMs: 274000 },
    { position: 1, discNumber: 2, recordingMbid: 'rec-3', title: 'Disc Two Opener', artist: 'Radiohead', lengthMs: 100000 },
  ];
}

function resolvingMocks(overrides = {}) {
  return {
    searchReleaseGroups: async () => [{ mbid: KID_A_RG, title: 'Kid A' }],
    resolvePrimaryReleaseForGroup: async () => KID_A_RELEASE,
    getReleaseWithTracks: async () => ({
      release: { mbid: KID_A_RELEASE, title: 'Kid A', artist: 'Radiohead' },
      tracks: kidATracks(),
    }),
    ...overrides,
  };
}

test('resolveMissingTrack names the track at a position', async () => {
  const db = dbWith(['Kid A'], 'Radiohead');
  const { resolveMissingTrack } = await freshDiscography(resolvingMocks());

  const found = await resolveMissingTrack('Radiohead', 'Kid A', { position: 2, db });
  assert.equal(found.resolved, true);
  assert.equal(found.title, 'Kid A');
  assert.equal(found.lengthMs, 274000);
  assert.equal(found.recordingMbid, 'rec-2');
  assert.equal(found.album, 'Kid A');
  assert.equal(found.releaseGroupMbid, KID_A_RG);
  db.close();
});

// A local row with no disc number is asked about as disc 1, and a single-disc
// release may carry none upstream — both sides have to fold to 1 or the lookup
// silently finds nothing.
test('resolveMissingTrack defaults to disc 1 and matches a null upstream discNumber', async () => {
  const db = dbWith(['Kid A'], 'Radiohead');
  const { resolveMissingTrack } = await freshDiscography(resolvingMocks({
    getReleaseWithTracks: async () => ({
      release: { mbid: KID_A_RELEASE, title: 'Kid A', artist: 'Radiohead' },
      tracks: [{ position: 4, discNumber: null, recordingMbid: 'rec-4', title: 'Optimistic', artist: 'Radiohead', lengthMs: 300000 }],
    }),
  }));

  const found = await resolveMissingTrack('Radiohead', 'Kid A', { position: 4, db });
  assert.equal(found.resolved, true);
  assert.equal(found.title, 'Optimistic');
  db.close();
});

test('resolveMissingTrack distinguishes discs', async () => {
  const db = dbWith(['Kid A'], 'Radiohead');
  const { resolveMissingTrack } = await freshDiscography(resolvingMocks());

  const disc2 = await resolveMissingTrack('Radiohead', 'Kid A', { position: 1, disc: 2, db });
  assert.equal(disc2.title, 'Disc Two Opener');
  db.close();
});

// The useful failure: a position past the end of the official tracklist is more
// likely a wrong track number on a file you have than a file you're missing, and
// the count is what lets the UI say so.
test('resolveMissingTrack reports a position past the tracklist with the real count', async () => {
  const db = dbWith(['Kid A'], 'Radiohead');
  const { resolveMissingTrack } = await freshDiscography(resolvingMocks());

  const found = await resolveMissingTrack('Radiohead', 'Kid A', { position: 14, db });
  assert.equal(found.resolved, false);
  assert.equal(found.reason, 'no_such_position');
  assert.equal(found.trackCount, 3);
  db.close();
});

test('resolveMissingTrack reports an album it cannot match', async () => {
  const db = dbWith(['Not A Real Album'], 'Radiohead');
  const { resolveMissingTrack } = await freshDiscography({
    searchReleaseGroups: async () => [{ mbid: KID_A_RG, title: 'Something Else Entirely' }],
  });

  const found = await resolveMissingTrack('Radiohead', 'Not A Real Album', { position: 1, db });
  assert.equal(found.resolved, false);
  assert.equal(found.reason, 'unresolved_album');
  db.close();
});

test('resolveMissingTrack reports a release group with no usable release', async () => {
  const db = dbWith(['Kid A'], 'Radiohead');
  const { resolveMissingTrack } = await freshDiscography(resolvingMocks({
    resolvePrimaryReleaseForGroup: async () => null,
  }));

  const found = await resolveMissingTrack('Radiohead', 'Kid A', { position: 1, db });
  assert.equal(found.resolved, false);
  assert.equal(found.reason, 'no_release');
  db.close();
});

// A track with no length can be named but not duration-verified, so the null has
// to survive rather than being defaulted — VerifyButton keys on it.
test('resolveMissingTrack passes a null lengthMs through untouched', async () => {
  const db = dbWith(['Kid A'], 'Radiohead');
  const { resolveMissingTrack } = await freshDiscography(resolvingMocks({
    getReleaseWithTracks: async () => ({
      release: { mbid: KID_A_RELEASE, title: 'Kid A', artist: 'Radiohead' },
      tracks: [{ position: 1, discNumber: 1, recordingMbid: 'rec-1', title: 'Untimed', artist: 'Radiohead', lengthMs: null }],
    }),
  }));

  const found = await resolveMissingTrack('Radiohead', 'Kid A', { position: 1, db });
  assert.equal(found.resolved, true);
  assert.equal(found.lengthMs, null);
  db.close();
});

// On a compilation the release credit is "Various Artists", which is not who
// performed the track — so the track's own credit wins.
test('resolveMissingTrack prefers the track credit over the release credit', async () => {
  const db = dbWith(['Comp'], 'Various Artists');
  const { resolveMissingTrack } = await freshDiscography(resolvingMocks({
    searchReleaseGroups: async () => [{ mbid: KID_A_RG, title: 'Comp' }],
    getReleaseWithTracks: async () => ({
      release: { mbid: KID_A_RELEASE, title: 'Comp', artist: 'Various Artists' },
      tracks: [{ position: 1, discNumber: 1, recordingMbid: 'rec-1', title: 'A Song', artist: 'The Real Band', lengthMs: 200000 }],
    }),
  }));

  const found = await resolveMissingTrack('Various Artists', 'Comp', { position: 1, db });
  assert.equal(found.artist, 'The Real Band');
  db.close();
});

// This is what makes a per-row button affordable: clicking three gap rows of one
// album must not cost three album searches.
test('resolveMissingTrack reuses the remembered album link on a second lookup', async () => {
  const db = dbWith(['Kid A'], 'Radiohead');
  let searches = 0;
  const { resolveMissingTrack } = await freshDiscography(resolvingMocks({
    searchReleaseGroups: async () => {
      searches += 1;
      return [{ mbid: KID_A_RG, title: 'Kid A' }];
    },
  }));

  await resolveMissingTrack('Radiohead', 'Kid A', { position: 1, db });
  await resolveMissingTrack('Radiohead', 'Kid A', { position: 2, db });
  assert.equal(searches, 1, 'the second row must come off library_album_links');
  db.close();
});
