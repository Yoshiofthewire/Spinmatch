import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

let counter = 0;
async function freshGaps(mbMocks, verifyMock) {
  counter += 1;
  const { mock } = await import('node:test');
  // The global mock tracker doesn't auto-restore module mocks between separate
  // top-level test() calls, so re-registering the same specifier throws
  // ERR_INVALID_STATE. Reset before each registration (same pattern as
  // libraryScanner.test.js).
  mock.reset();
  mock.module('../src/services/musicbrainz.js', { namedExports: mbMocks });
  // verifiedLinks, not verifyTrack: libraryGaps imports the former, and
  // mock.module only intercepts *future* resolutions. Mocking the transitive
  // dependency leaves the cached verifiedLinks bound to whichever verifyTrack
  // mock was registered first, so every test after the first would silently
  // exercise test one's stub. Whether an answer is remembered is verifiedLinks'
  // own contract and is tested in verifiedLinks.test.js.
  mock.module('../src/services/verifiedLinks.js', {
    namedExports: { verifyRecording: verifyMock },
  });
  return import(`../src/services/libraryGaps.js?fresh=${counter}`);
}

test('detectAlbumGaps splits owned vs missing and looks up links for gaps', async () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/Band/Rec/01.mp3', artist: 'Band', album: 'Rec', title: 'Kept', durationMs: 180000, changeKey: '1:1' });
  repo.recomputeStats(db);
  setDbForTest(db);

  const mb = {
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      release: { title: 'Rec', artist: 'Band' },
      tracks: [
        { position: 1, title: 'Kept', lengthMs: 180000 },
        { position: 2, title: 'Gone', lengthMs: 200000 },
      ],
    }),
  };
  let verifyCalls = 0;
  const verify = async ({ title }) => { verifyCalls += 1; return { status: 'verified', video: { url: `yt:${title}` }, deltaSeconds: 1 }; };

  const { detectAlbumGaps } = await freshGaps(mb, verify);
  const result = await detectAlbumGaps('11111111-1111-4111-8111-111111111111');

  assert.equal(result.owned.length, 1);
  assert.equal(result.owned[0].title, 'Kept');
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].title, 'Gone');
  assert.equal(result.missing[0].video.url, 'yt:Gone');
  assert.equal(verifyCalls, 1); // only the missing track is looked up
  setDbForTest(null);
  db.close();
});

test('an owned track counts even when its title has a (Remastered) suffix the tracklist lacks', async () => {
  const db = openDb(':memory:');
  // Library title carries a suffix MusicBrainz's canonical title does not.
  repo.upsertLocalTrack(db, { path: '/m/Band/Rec/01.mp3', artist: 'Band', album: 'Rec', title: 'Kept (Remastered 2011)', durationMs: 180000, changeKey: '1:1' });
  repo.recomputeStats(db);
  setDbForTest(db);

  const mb = {
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      release: { title: 'Rec', artist: 'Band' },
      tracks: [{ position: 1, title: 'Kept', lengthMs: 180000 }],
    }),
  };
  let verifyCalls = 0;
  const verify = async () => { verifyCalls += 1; return { status: 'verified', video: { url: 'x' }, deltaSeconds: 1 }; };

  const { detectAlbumGaps } = await freshGaps(mb, verify);
  const result = await detectAlbumGaps('11111111-1111-4111-8111-111111111111');

  assert.equal(result.owned.length, 1, 'normalized match should treat the remaster as owned');
  assert.equal(result.missing.length, 0);
  assert.equal(verifyCalls, 0, 'no YouTube lookup for a track we already own');
  setDbForTest(null);
  db.close();
});

test('onMissing streams each missing track as it is verified', async () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/Band/Rec/01.mp3', artist: 'Band', album: 'Rec', title: 'Kept', durationMs: 180000, changeKey: '1:1' });
  repo.recomputeStats(db);
  setDbForTest(db);

  const mb = {
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      release: { title: 'Rec', artist: 'Band' },
      tracks: [
        { position: 1, title: 'Kept', lengthMs: 180000 },
        { position: 2, title: 'Gone', lengthMs: 200000 },
        { position: 3, title: 'Also Gone', lengthMs: 210000 },
      ],
    }),
  };
  const verify = async ({ title }) => ({ status: 'confirmed', video: { url: `yt:${title}` }, deltaSeconds: 0 });
  const { detectAlbumGaps } = await freshGaps(mb, verify);

  const streamed = [];
  const result = await detectAlbumGaps('11111111-1111-4111-8111-111111111111', { onMissing: (entry) => streamed.push(entry) });

  // Only the tracks you don't own, and streamed in the same order they land in
  // the final result — the streaming route relies on both.
  assert.deepEqual(streamed.map((s) => s.title), ['Gone', 'Also Gone']);
  assert.deepEqual(result.missing.map((m) => m.title), ['Gone', 'Also Gone']);
  assert.equal(streamed[0].video.url, 'yt:Gone');
  setDbForTest(null);
  db.close();
});

test('an aborted signal stops the run partway instead of finishing every lookup', async () => {
  const db = openDb(':memory:');
  repo.recomputeStats(db);
  setDbForTest(db);

  const mb = {
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      release: { title: 'Rec', artist: 'Band' },
      tracks: [1, 2, 3, 4, 5].map((n) => ({ position: n, title: `T${n}`, lengthMs: 1000 })),
    }),
  };
  const ac = new AbortController();
  let calls = 0;
  const verify = async ({ title }) => {
    calls += 1;
    if (calls === 2) ac.abort(); // client disconnects mid-run
    return { status: 'confirmed', video: { url: `yt:${title}` }, deltaSeconds: 0 };
  };
  const { detectAlbumGaps } = await freshGaps(mb, verify);

  const result = await detectAlbumGaps('11111111-1111-4111-8111-111111111111', { signal: ac.signal });
  assert.equal(calls, 2, 'no further yt-dlp lookups after the abort');
  assert.equal(result.missing.length, 2);
  setDbForTest(null);
  db.close();
});

// Regression: ownership was judged against `release.artist`, MusicBrainz's joined
// artist-credit string. For a collaboration that string ("Danger
// MouseSparklehorse") matches no local artist tag, so every track came back
// missing even for an album owned in full.
test('a collaboration album is not reported as entirely missing', async () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/DM/Dark/01.mp3', artist: 'Danger Mouse', album: 'Dark Night', title: 'Revenge', durationMs: 180000, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/DM/Dark/02.mp3', artist: 'Danger Mouse', album: 'Dark Night', title: 'Just War', durationMs: 200000, changeKey: '2:1' });
  repo.recomputeStats(db);
  setDbForTest(db);

  const mb = {
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      // Exactly what musicbrainz.js produces for a two-artist credit: the names
      // joined with nothing in between.
      release: { title: 'Dark Night', artist: 'Danger MouseSparklehorse' },
      tracks: [
        { position: 1, title: 'Revenge', lengthMs: 180000 },
        { position: 2, title: 'Just War', lengthMs: 200000 },
        { position: 3, title: 'Little Girl', lengthMs: 150000 },
      ],
    }),
  };

  const { detectAlbumGaps } = await freshGaps(mb, async () => ({ status: 'no_results', video: null, deltaSeconds: null }));
  const result = await detectAlbumGaps('11111111-1111-4111-8111-111111111111', {
    verify: false, localArtist: 'Danger Mouse', localAlbum: 'Dark Night',
  });

  assert.deepEqual(result.owned.map((t) => t.title), ['Revenge', 'Just War']);
  assert.deepEqual(result.missing.map((t) => t.title), ['Little Girl']);
  db.close();
});

// Without a local album to scope to (the release-group page, which asks about an
// album you may not own at all), fall back to the artist's titles as before.
test('with no local album given, ownership falls back to the artist scope', async () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/Band/Other/01.mp3', artist: 'Band', album: 'Other', title: 'Shared', durationMs: 180000, changeKey: '1:1' });
  repo.recomputeStats(db);
  setDbForTest(db);

  const mb = {
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      release: { title: 'Rec', artist: 'Band' },
      tracks: [{ position: 1, title: 'Shared', lengthMs: 180000 }],
    }),
  };
  const { detectAlbumGaps } = await freshGaps(mb, async () => ({ status: 'no_results', video: null, deltaSeconds: null }));
  const result = await detectAlbumGaps('11111111-1111-4111-8111-111111111111', { verify: false });
  assert.equal(result.owned.length, 1);
  assert.equal(result.missing.length, 0);
  db.close();
});
