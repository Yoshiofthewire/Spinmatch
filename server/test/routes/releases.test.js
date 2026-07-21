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

function mockMusicBrainz() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/^localhost/); // let requests to our own test server through
  setGlobalDispatcher(agent);
  return agent.get('https://musicbrainz.org');
}

test('GET /api/releases/:mbid/tracks returns tracks with an estimated quota cost', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: /\/ws\/2\/release\?.*release-group=route-release-group.*/ }).reply(200, {
    releases: [{ id: 'route-release-id', status: 'Official' }],
  });
  pool.intercept({ path: '/ws/2/release/route-release-id?inc=recordings%2Bartist-credits&fmt=json' }).reply(200, {
    id: 'route-release-id',
    title: 'Route Test Album',
    'artist-credit': [{ name: 'Route Test Artist' }],
    media: [
      {
        tracks: [
          { position: 1, title: 'Track One', length: 180000, recording: { id: 'rec-1' } },
          { position: 2, title: 'Track Two', length: 200000, recording: { id: 'rec-2' } },
        ],
      },
    ],
  });

  const res = await fetch(`${baseUrl}/api/releases/route-release-group/tracks`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.release.title, 'Route Test Album');
  assert.equal(body.tracks.length, 2);
  assert.equal(body.estimatedQuotaUnits, 2 * 101);
});

test('GET /api/releases/:mbid/tracks returns 404 when the release group has no releases', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: /\/ws\/2\/release\?.*release-group=route-release-group-empty.*/ }).reply(200, {
    releases: [],
  });

  const res = await fetch(`${baseUrl}/api/releases/route-release-group-empty/tracks`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'NOT_FOUND');
});
