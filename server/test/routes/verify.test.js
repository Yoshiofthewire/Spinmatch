import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';
import child_process from 'node:child_process';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { createApp } = await import('../../src/app.js');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp({ gate: (req, res, next) => next() });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => server.close());

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
});
