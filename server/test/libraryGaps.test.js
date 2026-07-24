import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

let counter = 0;
async function freshGaps(mbMocks, verifyMock) {
  counter += 1;
  const { mock } = await import('node:test');
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
