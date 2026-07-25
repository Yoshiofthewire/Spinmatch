// Persistent memory of YouTube matches. This exists so an artist-wide sweep —
// minutes of 1-req/s lookups — survives a restart, so the contracts worth
// pinning down are that a remembered answer is returned without a lookup, that
// a weak match is NOT remembered, and that both kinds of answer expire.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb, setDbForTest } = await import('../src/lib/db.js');

const MBID = '77777777-7777-4777-8777-777777777777';
const DAY = 24 * 60 * 60 * 1000;

let lookups = [];
let counter = 0;

async function freshLinks(verifyResult) {
  counter += 1;
  const { mock } = await import('node:test');
  mock.reset();
  mock.module('../src/services/verifyTrack.js', {
    namedExports: {
      verifyTrack: async (args) => {
        lookups.push(args);
        return verifyResult;
      },
    },
  });
  return import(`../src/services/verifiedLinks.js?fresh=${counter}`);
}

function freshDb() {
  const db = openDb(':memory:');
  setDbForTest(db);
  return db;
}

test.after(() => setDbForTest(null));

test('a confirmed match is remembered and returned without a second lookup', async () => {
  const db = freshDb();
  lookups = [];
  const { verifyRecording } = await freshLinks({
    status: 'confirmed',
    video: { id: 'abc123', title: 'Idioteque', durationMs: 300_000, url: 'https://youtu.be/abc123' },
    deltaSeconds: 1,
  });

  const first = await verifyRecording({ recordingMbid: MBID, artist: 'Radiohead', title: 'Idioteque', lengthMs: 300_000 });
  assert.equal(first.status, 'confirmed');
  assert.equal(lookups.length, 1);

  const second = await verifyRecording({ recordingMbid: MBID, artist: 'Radiohead', title: 'Idioteque', lengthMs: 300_000 });
  assert.equal(lookups.length, 1, 'the remembered answer short-circuits the lookup');
  assert.equal(second.video.id, 'abc123');
  assert.equal(second.cached, true);
  db.close();
});

test('a miss is remembered too, so a sweep stops re-asking for what is not there', async () => {
  const db = freshDb();
  lookups = [];
  const { verifyRecording } = await freshLinks({ status: 'no_results', video: null, deltaSeconds: null });

  await verifyRecording({ recordingMbid: MBID, artist: 'A', title: 'B', lengthMs: 1000 });
  const again = await verifyRecording({ recordingMbid: MBID, artist: 'A', title: 'B', lengthMs: 1000 });

  assert.equal(lookups.length, 1);
  assert.equal(again.status, 'no_results');
  assert.equal(again.video, null);
  db.close();
});

// A video was found but its duration disagrees with MusicBrainz. That's a guess
// worth re-making later, not a fact worth keeping for a month.
test('an unverified match is not remembered', async () => {
  const db = freshDb();
  lookups = [];
  const { verifyRecording } = await freshLinks({
    status: 'unverified',
    video: { id: 'wrong', title: 'Live version', durationMs: 900_000, url: 'https://youtu.be/wrong' },
    deltaSeconds: 600,
  });

  await verifyRecording({ recordingMbid: MBID, artist: 'A', title: 'B', lengthMs: 300_000 });
  await verifyRecording({ recordingMbid: MBID, artist: 'A', title: 'B', lengthMs: 300_000 });

  assert.equal(lookups.length, 2, 'a weak match is looked up again rather than cached');
  db.close();
});

test('a track with no recording id is looked up every time rather than mis-keyed', async () => {
  const db = freshDb();
  lookups = [];
  const { verifyRecording } = await freshLinks({
    status: 'confirmed', video: { id: 'x', title: 't', durationMs: 1 }, deltaSeconds: 0,
  });

  await verifyRecording({ recordingMbid: null, artist: 'A', title: 'B', lengthMs: 1000 });
  await verifyRecording({ recordingMbid: null, artist: 'A', title: 'B', lengthMs: 1000 });

  assert.equal(lookups.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM verified_links').get().c, 0);
  db.close();
});

test('a remembered hit expires after 30 days, a miss after 7', async () => {
  const db = freshDb();
  const { getVerifiedLink, saveVerifiedLink } = await freshLinks({ status: 'no_results', video: null });

  // A hit 10 days old is still good; a miss of the same age is not.
  saveVerifiedLink(db, { recordingMbid: MBID, artist: 'A', title: 'B', video: { id: 'v', title: 't', durationMs: 1 } });
  db.prepare('UPDATE verified_links SET checked_at = ?').run(Date.now() - 10 * DAY);
  assert.ok(getVerifiedLink(db, MBID), 'a 10-day-old hit still stands');

  saveVerifiedLink(db, { recordingMbid: MBID, artist: 'A', title: 'B', video: null });
  db.prepare('UPDATE verified_links SET checked_at = ?').run(Date.now() - 10 * DAY);
  assert.equal(getVerifiedLink(db, MBID), null, 'a 10-day-old miss is retried');

  // And a hit does eventually expire.
  saveVerifiedLink(db, { recordingMbid: MBID, artist: 'A', title: 'B', video: { id: 'v', title: 't', durationMs: 1 } });
  db.prepare('UPDATE verified_links SET checked_at = ?').run(Date.now() - 40 * DAY);
  assert.equal(getVerifiedLink(db, MBID), null, 'a 40-day-old hit is retried');
  db.close();
});

test('re-verifying an expired entry overwrites it rather than failing on the primary key', async () => {
  const db = freshDb();
  const { saveVerifiedLink, getVerifiedLink } = await freshLinks({ status: 'no_results', video: null });

  saveVerifiedLink(db, { recordingMbid: MBID, artist: 'A', title: 'B', video: { id: 'old', title: 't', durationMs: 1 } });
  saveVerifiedLink(db, { recordingMbid: MBID, artist: 'A', title: 'B', video: { id: 'new', title: 't', durationMs: 1 } });

  assert.equal(db.prepare('SELECT COUNT(*) c FROM verified_links').get().c, 1);
  assert.equal(getVerifiedLink(db, MBID).videoId, 'new');
  db.close();
});
