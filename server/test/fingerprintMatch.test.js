// The fingerprint half of candidate gathering, shared by the ingest picker and
// the library's tag-repair panel. tagMatch.test.js covers the counterpart that
// runs when there's no AcoustID key.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.ACOUSTID_API_KEY = 'test-key';

let counter = 0;

async function freshFingerprintMatch(t, { lookupResult = [], recording = null } = {}) {
  counter += 1;

  t.mock.module('../src/services/fpcalc.js', {
    exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
  });
  t.mock.module('../src/services/acoustid.js', {
    exports: { lookup: async () => lookupResult },
  });
  t.mock.module('../src/services/musicbrainz.js', {
    exports: {
      getRecording: recording ?? (async (mbid) => ({
        mbid,
        title: `Title for ${mbid}`,
        artist: 'Some Artist',
        lengthMs: 200_000,
        releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Some Album' }],
        date: '2020-01-01',
      })),
    },
  });

  return import(`../src/services/fingerprintMatch.js?fresh=${counter}`);
}

test('candidatesFromFingerprint returns a row per AcoustID candidate, in score order', async (t) => {
  const { candidatesFromFingerprint } = await freshFingerprintMatch(t, {
    lookupResult: [
      { recordingMbid: 'rec-hi', score: 0.4 },
      { recordingMbid: 'rec-lo', score: 0.1 },
    ],
  });

  const { candidates } = await candidatesFromFingerprint('/music/whatever.mp3');

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].recordingMbid, 'rec-hi');
  assert.equal(candidates[0].score, 0.4, 'the AcoustID 0-1 score is passed through unscaled');
  assert.equal(candidates[0].title, 'Title for rec-hi');
  assert.equal(candidates[0].artist, 'Some Artist');
  assert.equal(candidates[0].lengthMs, 200_000);
  assert.equal(candidates[0].releaseGroupTitle, 'Some Album');
  assert.equal(candidates[1].recordingMbid, 'rec-lo');
});

test('candidatesFromFingerprint still offers a recording that belongs to no release group', async (t) => {
  const { candidatesFromFingerprint } = await freshFingerprintMatch(t, {
    lookupResult: [{ recordingMbid: 'rec-orphan', score: 0.9 }],
    recording: async (mbid) => ({ mbid, title: 'Orphan', artist: 'A', lengthMs: 1000, releaseGroups: [] }),
  });

  const { candidates } = await candidatesFromFingerprint('/music/whatever.mp3');

  assert.equal(candidates.length, 1, 'a recording on no release is still a candidate');
  assert.equal(candidates[0].releaseGroupTitle, null);
});

test('candidatesFromFingerprint returns nothing when AcoustID has never seen the file', async (t) => {
  const { candidatesFromFingerprint } = await freshFingerprintMatch(t, { lookupResult: [] });

  const { candidates } = await candidatesFromFingerprint('/music/whatever.mp3');

  assert.deepEqual(candidates, []);
});

// AcoustID can return a long tail for a common recording; the picker shows a
// shortlist, so the expensive per-candidate getRecording calls are capped.
test('candidatesFromFingerprint caps the shortlist at ten candidates', async (t) => {
  const { candidatesFromFingerprint } = await freshFingerprintMatch(t, {
    lookupResult: Array.from({ length: 25 }, (_, i) => ({ recordingMbid: `rec-${i}`, score: 1 - i / 100 })),
  });

  const { candidates } = await candidatesFromFingerprint('/music/whatever.mp3');

  assert.equal(candidates.length, 10);
  assert.equal(candidates[0].recordingMbid, 'rec-0');
});
