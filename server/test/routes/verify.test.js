import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';
import child_process from 'node:child_process';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { createApp } = await import('../../src/app.js');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp();
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

test('POST /api/verify returns 400 when required fields are missing', async () => {
  mockMusicBrainzAgent();
  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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

test('POST /api/verify/album/:mbid returns partial results plus a rate-limited error mid-batch', async (t) => {
  const agent = mockMusicBrainzAgent();
  const mb = agent.get('https://musicbrainz.org');

  mb.intercept({ path: /\/ws\/2\/release\?.*release-group=bulk-album-test.*/ }).reply(200, {
    releases: [{ id: 'bulk-release-id', status: 'Official' }],
  });
  mb.intercept({ path: '/ws/2/release/bulk-release-id?inc=recordings%2Bartist-credits&fmt=json' }).reply(200, {
    id: 'bulk-release-id',
    title: 'Bulk Test Album',
    'artist-credit': [{ name: 'Bulk Test Artist' }],
    media: [
      {
        tracks: [
          { position: 1, title: 'Bulk Track One', length: 180000, recording: { id: 'rec-1' } },
          { position: 2, title: 'Bulk Track Two', length: 190000, recording: { id: 'rec-2' } },
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

  const res = await fetch(`${baseUrl}/api/verify/album/bulk-album-test`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.results.length, 1, 'only the first track should have completed before the rate limit hit');
  assert.equal(body.results[0].title, 'Bulk Track One');
  assert.equal(body.results[0].status, 'confirmed');
  assert.equal(body.error.code, 'RATE_LIMITED');
});
