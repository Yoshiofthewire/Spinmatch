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
  mock.module('../src/services/verifyTrack.js', { namedExports: { verifyTrack: verifyMock } });
  return import(`../src/services/libraryGaps.js?fresh=${counter}`);
}

test('detectAlbumGaps splits owned vs missing and looks up links for gaps', async () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/Band/Rec/01.mp3', artist: 'Band', album: 'Rec', title: 'Kept', durationMs: 180000, changeKey: '1:1' });
  repo.recomputeStats(db);
  setDbForTest(db);

  const mb = {
    resolvePrimaryReleaseForGroup: async () => 'release-1',
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
  const result = await detectAlbumGaps('rg-1');

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
    resolvePrimaryReleaseForGroup: async () => 'release-1',
    getReleaseWithTracks: async () => ({
      release: { title: 'Rec', artist: 'Band' },
      tracks: [{ position: 1, title: 'Kept', lengthMs: 180000 }],
    }),
  };
  let verifyCalls = 0;
  const verify = async () => { verifyCalls += 1; return { status: 'verified', video: { url: 'x' }, deltaSeconds: 1 }; };

  const { detectAlbumGaps } = await freshGaps(mb, verify);
  const result = await detectAlbumGaps('rg-1');

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
    resolvePrimaryReleaseForGroup: async () => 'release-1',
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
  const result = await detectAlbumGaps('rg-1', { onMissing: (entry) => streamed.push(entry) });

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
    resolvePrimaryReleaseForGroup: async () => 'release-1',
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

  const result = await detectAlbumGaps('rg-1', { signal: ac.signal });
  assert.equal(calls, 2, 'no further yt-dlp lookups after the abort');
  assert.equal(result.missing.length, 2);
  setDbForTest(null);
  db.close();
});
