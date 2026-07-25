import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

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

function mockMusicBrainz() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/^localhost/); // let requests to our own test server through
  setGlobalDispatcher(agent);
  return agent.get('https://musicbrainz.org');
}

test('GET /api/artists/:mbid/albums returns studio albums for the artist', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: '/ws/2/artist/c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1?fmt=json' }).reply(200, {
    id: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
    name: 'Route Test Artist',
  });
  pool.intercept({ path: /\/ws\/2\/release-group\?.*artist=c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1.*/ }).reply(200, {
    'release-groups': [
      { id: '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a', title: 'Album A', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2001' },
    ],
  });

  const res = await fetch(`${baseUrl}/api/artists/c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1/albums`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.artist.name, 'Route Test Artist');
  assert.equal(body.albums.length, 1);
  assert.equal(body.albums[0].title, 'Album A');
});

test('GET /api/artists/:mbid/albums returns 502 when MusicBrainz is unreachable', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: '/ws/2/artist/c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2?fmt=json' }).reply(503, {});

  const res = await fetch(`${baseUrl}/api/artists/c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2/albums`);
  assert.equal(res.status, 502);
});
