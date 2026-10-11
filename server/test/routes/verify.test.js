import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';
import child_process from 'node:child_process';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { createApp } = await import('../../src/app.js');
const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const { getVerifiedLink } = await import('../../src/services/verifiedLinks.js');

let server;
let baseUrl;
let db;

const history = () => db.prepare(
  'SELECT recording_mbid AS mbid, artist, title, album, action, status, video_id AS videoId FROM verify_history ORDER BY id',
).all().map((r) => ({ ...r }));

test.before(async () => {
  db = openDb(':memory:');
  setDbForTest(db);
  const app = createApp({ gate: (req, res, next) => next() });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => { server.close(); setDbForTest(null); db.close(); });
test.beforeEach(() => db.exec('DELETE FROM verify_history'));

function mockMusicBrainzAgent() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/^localhost/); // let requests to our own test server through
  setGlobalDispatcher(agent);
  return agent;
}

function mockExecFile(t, impl) {
  t.mock.method(child_process, 'execFile', impl);
}

function ndjson(items) {
  return items.map((i) => JSON.stringify(i)).join('\n') + '\n';
}

function parseSse(text) {
  return text.split('\n\n').filter((b) => b.trim()).map((block) => {
    const lines = block.split('\n');
    const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
    return { event, data: data ? JSON.parse(data) : null };
  });
}

test('POST /api/verify returns 400 when required fields are missing', async () => {
  mockMusicBrainzAgent();
  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ artist: 'Only Artist' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/verify returns a confirmed match for a real-looking candidate', async (t) => {
  mockMusicBrainzAgent();
  mockExecFile(t, (bin, args, opts, callback) => {
    callback(null, ndjson([{ id: 'vid-verify-1', title: 'Verify Route Song', duration: 200 }]), '');
  });

  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({
      artist: 'Verify Route Artist',
      title: 'Verify Route Song',
      album: 'Verify Route Album',
      lengthMs: 200000,
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'confirmed');
  assert.equal(body.video.id, 'vid-verify-1');
  assert.deepEqual(history(), [{
    mbid: null, artist: 'Verify Route Artist', title: 'Verify Route Song', album: 'Verify Route Album',
    action: 'verified', status: 'confirmed', videoId: 'vid-verify-1',
  }]);
});

test('POST /api/verify surfaces a rate-limited message and 429 status', async (t) => {
  mockMusicBrainzAgent();
  mockExecFile(t, (bin, args, opts, callback) => {
    const error = new Error('Command failed');
    error.code = 1;
    callback(error, '', "ERROR: [youtube] Sign in to confirm you're not a bot");
  });

  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({
      artist: 'Rate Limited Artist',
      title: 'Rate Limited Song',
      album: 'Rate Limited Album',
      lengthMs: 200000,
    }),
  });

  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
});

// The non-streaming POST /album/:mbid this used to exercise is gone: it held one
// request open for the whole multi-minute run, which is what the streaming route
// was built to replace, and its "fallback for browsers without EventSource"
// justification described no browser that can run the client. The behaviour
// worth keeping is this one — partial results survive a rate limit landing
// mid-run — so it moved to the route that still exists.
test('GET /api/verify/album/:mbid/stream keeps earlier results when a rate limit lands mid-run', async (t) => {
  const agent = mockMusicBrainzAgent();
  const mb = agent.get('https://musicbrainz.org');

  mb.intercept({ path: /\/ws\/2\/release\?.*release-group=c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5.*/ }).reply(200, {
    releases: [{ id: 'bulk-release-id', status: 'Official' }],
  });
  mb.intercept({ path: '/ws/2/release/bulk-release-id?inc=recordings%2Bartist-credits&fmt=json' }).reply(200, {
    id: 'bulk-release-id',
    title: 'Bulk Test Album',
    'artist-credit': [{ name: 'Bulk Test Artist' }],
    media: [
      {
        tracks: [
          { position: 1, title: 'Bulk Track One', length: 180000, recording: { id: '77777777-7777-4777-8777-777777777777' } },
          { position: 2, title: 'Bulk Track Two', length: 190000, recording: { id: '88888888-8888-4888-8888-888888888888' } },
        ],
      },
    ],
  });

  mockExecFile(t, (bin, args, opts, callback) => {
    const query = args[args.length - 1];
    if (query.includes('Bulk Track One')) {
      callback(null, ndjson([{ id: 'vid-bulk-1', title: 'Bulk Track One', duration: 180 }]), '');
    } else {
      const error = new Error('Command failed');
      error.code = 1;
      callback(error, '', "ERROR: [youtube] Sign in to confirm you're not a bot");
    }
  });

  const res = await fetch(`${baseUrl}/api/verify/album/c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5/stream`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(res.status, 200);

  const events = parseSse(await res.text());
  const results = events.filter((e) => e.event === 'result');
  assert.equal(results.length, 1, 'only the first track should have completed before the rate limit hit');
  assert.equal(results[0].data.title, 'Bulk Track One');
  assert.equal(results[0].data.status, 'confirmed');

  const limited = events.find((e) => e.event === 'rate_limited');
  assert.ok(limited, 'the run reports the rate limit as its own terminal event');
  assert.equal(limited.data.code, 'RATE_LIMITED');
  // A rate limit ends the run — it is not a completed run, so no `done`.
  assert.ok(!events.some((e) => e.event === 'done'));
  // Exactly one terminal event, and it is the last thing sent before the stream closed.
  assert.equal(events.filter((e) => ['done', 'error', 'rate_limited'].includes(e.event)).length, 1);
  assert.equal(events.at(-1).event, 'rate_limited');
  assert.deepEqual(history().map((h) => [h.title, h.status]), [['Bulk Track One', 'confirmed']]);
});

test('GET /api/verify/album/:mbid/stream emits an album header, a result per track, then done', async (t) => {
  const agent = mockMusicBrainzAgent();
  const mb = agent.get('https://musicbrainz.org');

  mb.intercept({ path: /\/ws\/2\/release\?.*release-group=c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c6c6.*/ }).reply(200, {
    releases: [{ id: 'stream-release', status: 'Official' }],
  });
  mb.intercept({ path: '/ws/2/release/stream-release?inc=recordings%2Bartist-credits&fmt=json' }).reply(200, {
    id: 'stream-release',
    title: 'Stream Album',
    'artist-credit': [{ name: 'Stream Artist' }],
    media: [
      {
        tracks: [
          { position: 1, title: 'Stream One', length: 180000, recording: { id: 'r1' } },
          { position: 2, title: 'Stream Two', length: 190000, recording: { id: 'r2' } },
        ],
      },
    ],
  });

  mockExecFile(t, (bin, args, opts, callback) => {
    const query = args[args.length - 1];
    if (query.includes('Stream One')) callback(null, ndjson([{ id: 'v1', title: 'Stream One', duration: 180 }]), '');
    else callback(null, ndjson([{ id: 'v2', title: 'Stream Two', duration: 190 }]), '');
  });

  const res = await fetch(`${baseUrl}/api/verify/album/c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c6c6/stream`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const events = parseSse(await res.text());
  assert.equal(events.find((e) => e.event === 'album').data.total, 2);
  const results = events.filter((e) => e.event === 'result');
  assert.equal(results.length, 2);
  assert.equal(results[0].data.title, 'Stream One');
  assert.equal(results[0].data.status, 'confirmed');
  assert.equal(results[1].data.title, 'Stream Two');
  assert.ok(events.some((e) => e.event === 'done'), 'stream ends with a done event');
  assert.deepEqual(history(), [
    { mbid: 'r1', artist: 'Stream Artist', title: 'Stream One', album: 'Stream Album', action: 'verified', status: 'confirmed', videoId: 'v1' },
    { mbid: 'r2', artist: 'Stream Artist', title: 'Stream Two', album: 'Stream Album', action: 'verified', status: 'confirmed', videoId: 'v2' },
  ]);
  // Bulk results fill the same verified_links cache a single verify does.
  assert.equal(getVerifiedLink(db, 'r1').videoId, 'v1');
  assert.equal(getVerifiedLink(db, 'r2').videoId, 'v2');
});

test('GET /api/verify/album/:mbid/stream answers a cached recording without asking yt-dlp', async (t) => {
  const agent = mockMusicBrainzAgent();
  const mb = agent.get('https://musicbrainz.org');
  mb.intercept({ path: /\/ws\/2\/release\?.*release-group=c7c7c7c7-c7c7-4c7c-8c7c-c7c7c7c7c7c7.*/ }).reply(200, {
    releases: [{ id: 'cached-release', status: 'Official' }],
  });
  mb.intercept({ path: '/ws/2/release/cached-release?inc=recordings%2Bartist-credits&fmt=json' }).reply(200, {
    id: 'cached-release',
    title: 'Cached Album',
    'artist-credit': [{ name: 'Cached Artist' }],
    media: [{
      tracks: [
        { position: 1, title: 'Cached One', length: 180000, recording: { id: 'cached-rec' } },
        { position: 2, title: 'No Mbid', length: 190000 },
      ],
    }],
  });
  const { saveVerifiedLink } = await import('../../src/services/verifiedLinks.js');
  saveVerifiedLink(db, { recordingMbid: 'cached-rec', artist: 'Cached Artist', title: 'Cached One', video: { id: 'from-cache', title: 'Cached One', durationMs: 180000 } });

  const queries = [];
  mockExecFile(t, (bin, args, opts, callback) => {
    queries.push(args[args.length - 1]);
    callback(null, ndjson([{ id: 'fresh', title: 'No Mbid', duration: 300 }]), '');
  });

  const res = await fetch(`${baseUrl}/api/verify/album/c7c7c7c7-c7c7-4c7c-8c7c-c7c7c7c7c7c7/stream`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  const results = parseSse(await res.text()).filter((e) => e.event === 'result');
  assert.equal(results[0].data.video.id, 'from-cache');
  assert.equal(results[0].data.cached, true);
  assert.ok(queries.every((q) => !q.includes('Cached One')), 'the cached track must not reach yt-dlp');
  // No MBID: still verified (verifyTrack path), recorded, and nothing cached under a null key.
  assert.equal(results[1].data.status, 'unverified');
  assert.deepEqual(history().map((h) => [h.title, h.mbid, h.status, h.videoId]), [
    ['Cached One', 'cached-rec', 'confirmed', 'from-cache'],
    ['No Mbid', null, 'unverified', 'fresh'],
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verified_links WHERE title = 'No Mbid'").get().n, 0);
});

// An optional recordingMbid routes the lookup through verifiedLinks instead of
// verifyTrack, which is the difference between remembering the answer for an hour
// in memory and remembering it for 30 days in the database. The gap rows pass one;
// a free-text search result has none to pass.
test('POST /api/verify with a recordingMbid persists the result in verified_links', async (t) => {
  mockMusicBrainzAgent();
  let calls = 0;
  mockExecFile(t, (bin, args, opts, callback) => {
    calls += 1;
    callback(null, ndjson([{ id: 'vid-persist-1', title: 'Persisted Song', duration: 180 }]), '');
  });

  const mbid = '99999999-9999-4999-8999-999999999999';
  const body = {
    artist: 'Persist Artist',
    title: 'Persisted Song',
    album: 'Persist Album',
    lengthMs: 180000,
    recordingMbid: mbid,
  };

  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'confirmed');

  const remembered = getVerifiedLink(db, mbid);
  assert.ok(remembered, 'the answer should have been written to verified_links');
  assert.equal(remembered.videoId, 'vid-persist-1');

  // And the persistence is load-bearing: a repeat asks yt-dlp nothing.
  await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify(body),
  });
  assert.equal(calls, 1, 'the second lookup must come off verified_links');
});

// The mbid is interpolated into a cache key and a primary key, so a malformed one
// is refused rather than stored.
test('POST /api/verify rejects a malformed recordingMbid', async () => {
  mockMusicBrainzAgent();
  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({
      artist: 'A', title: 'T', lengthMs: 1000, recordingMbid: 'not-a-uuid',
    }),
  });
  assert.equal(res.status, 400);
});

// artist and title become a yt-dlp search argument and lengthMs becomes duration
// arithmetic, so both are checked for type and size rather than truthiness. Each
// of these used to reach yt-dlp (or the ranking) as-is.
test('POST /api/verify rejects non-string, oversized and out-of-range fields', async () => {
  mockMusicBrainzAgent();
  const bad = [
    { artist: ['A'], title: 'T', lengthMs: 1000 },
    { artist: { toString: 'x' }, title: 'T', lengthMs: 1000 },
    { artist: 'A', title: 42, lengthMs: 1000 },
    { artist: 'A', title: '   ', lengthMs: 1000 },
    { artist: 'A'.repeat(5000), title: 'T', lengthMs: 1000 },
    { artist: 'A', title: 'T', album: ['nope'], lengthMs: 1000 },
    { artist: 'A', title: 'T', lengthMs: -5 },
    { artist: 'A', title: 'T', lengthMs: 0 },
    { artist: 'A', title: 'T', lengthMs: 'four minutes' },
    { artist: 'A', title: 'T', lengthMs: Number.MAX_SAFE_INTEGER },
    { artist: 'A', title: 'T', lengthMs: true },
  ];
  for (const body of bad) {
    const res = await fetch(`${baseUrl}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('GET /api/verify/album/:mbid/stream records a track with no length as no_results', async (t) => {
  const agent = mockMusicBrainzAgent();
  const mb = agent.get('https://musicbrainz.org');
  mb.intercept({ path: /\/ws\/2\/release\?.*release-group=d7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7.*/ }).reply(200, {
    releases: [{ id: 'nolen-release', status: 'Official' }],
  });
  mb.intercept({ path: '/ws/2/release/nolen-release?inc=recordings%2Bartist-credits&fmt=json' }).reply(200, {
    id: 'nolen-release',
    title: 'Lengthless',
    'artist-credit': [{ name: 'Someone' }],
    media: [{ tracks: [{ position: 1, title: 'Hidden Track', length: null, recording: { id: 'r9' } }] }],
  });
  mockExecFile(t, () => assert.fail('no lookup without a length'));

  const res = await fetch(`${baseUrl}/api/verify/album/d7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7/stream`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  const results = parseSse(await res.text()).filter((e) => e.event === 'result');
  assert.equal(results[0].data.status, 'no_results');
  assert.deepEqual(history(), [
    { mbid: 'r9', artist: 'Someone', title: 'Hidden Track', album: 'Lengthless', action: 'verified', status: 'no_results', videoId: null },
  ]);
});
