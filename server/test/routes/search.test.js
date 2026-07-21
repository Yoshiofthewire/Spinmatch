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

test('GET /api/search returns 400 when q is missing', async () => {
  const res = await fetch(`${baseUrl}/api/search`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'BAD_REQUEST');
});

test('GET /api/search returns grouped results for a valid query', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: /\/ws\/2\/artist\?.*query=route-test-query.*/ }).reply(200, { artists: [] });
  pool
    .intercept({ path: /\/ws\/2\/release-group\?.*query=route-test-query.*/ })
    .reply(200, { 'release-groups': [] });
  pool.intercept({ path: /\/ws\/2\/recording\?.*query=route-test-query.*/ }).reply(200, { recordings: [] });

  const res = await fetch(`${baseUrl}/api/search?q=route-test-query`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { artists: [], releaseGroups: [], recordings: [] });
});

test('GET /api/search returns 502 when MusicBrainz is unreachable', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: /\/ws\/2\/artist\?.*query=route-error-query.*/ }).reply(500, {});
  pool.intercept({ path: /\/ws\/2\/release-group\?.*query=route-error-query.*/ }).reply(500, {});
  pool.intercept({ path: /\/ws\/2\/recording\?.*query=route-error-query.*/ }).reply(500, {});

  const res = await fetch(`${baseUrl}/api/search?q=route-error-query`);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.code, 'UPSTREAM_UNAVAILABLE');
});
