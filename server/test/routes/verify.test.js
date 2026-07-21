import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.YOUTUBE_API_KEY = 'test-key';
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

function mockAgent() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/^localhost/); // let requests to our own test server through
  setGlobalDispatcher(agent);
  return agent;
}

test('POST /api/verify returns 400 when required fields are missing', async () => {
  mockAgent();
  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artist: 'Only Artist' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/verify returns a confirmed match for a real-looking candidate', async () => {
  const agent = mockAgent();
  const yt = agent.get('https://www.googleapis.com');
  yt.intercept({ path: /\/youtube\/v3\/search\?/ }).reply(200, {
    items: [{ id: { videoId: 'vid-verify-1' }, snippet: { title: 'Verify Route Song' } }],
  });
  yt.intercept({ path: /\/youtube\/v3\/videos\?/ }).reply(200, {
    items: [{ id: 'vid-verify-1', contentDetails: { duration: 'PT3M20S' } }],
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

test('POST /api/verify surfaces the quota-exceeded message and 403 status', async () => {
  const agent = mockAgent();
  const yt = agent.get('https://www.googleapis.com');
  yt.intercept({ path: /\/youtube\/v3\/search\?/ })
    .reply(403, { error: { errors: [{ reason: 'quotaExceeded' }] } })
    .persist();

  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      artist: 'Quota Route Artist',
      title: 'Quota Route Song',
      album: 'Quota Route Album',
      lengthMs: 200000,
    }),
  });

  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, 'QUOTA_EXCEEDED');
  assert.match(body.error.message, /try again tomorrow/i);
});

test('POST /api/verify/album/:mbid returns partial results plus a quota error when quota runs out mid-batch', async () => {
  const agent = mockAgent();
  const mb = agent.get('https://musicbrainz.org');
  const yt = agent.get('https://www.googleapis.com');

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

  // Track one succeeds…
  yt.intercept({ path: (p) => /\/youtube\/v3\/search\?/.test(p) && p.includes('Bulk+Track+One') }).reply(200, {
    items: [{ id: { videoId: 'vid-bulk-1' }, snippet: { title: 'Bulk Track One' } }],
  });
  yt.intercept({ path: /\/youtube\/v3\/videos\?.*vid-bulk-1.*/ }).reply(200, {
    items: [{ id: 'vid-bulk-1', contentDetails: { duration: 'PT3M0S' } }],
  });
  // …track two hits the quota wall.
  yt.intercept({ path: (p) => /\/youtube\/v3\/search\?/.test(p) && p.includes('Bulk+Track+Two') }).reply(403, {
    error: { errors: [{ reason: 'quotaExceeded' }] },
  });

  const res = await fetch(`${baseUrl}/api/verify/album/bulk-album-test`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.results.length, 1, 'only the first track should have completed before the quota error');
  assert.equal(body.results[0].title, 'Bulk Track One');
  assert.equal(body.results[0].status, 'confirmed');
  assert.equal(body.error.code, 'QUOTA_EXCEEDED');
});
