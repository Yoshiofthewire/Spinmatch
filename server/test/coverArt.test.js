import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

const { getFrontCoverUrl, getFrontCoverImage } = await import('../src/services/coverArt.js');

function mockCoverArtArchive() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent.get('https://coverartarchive.org');
}

test('getFrontCoverUrl returns the resolved URL on a 200 response', async () => {
  const pool = mockCoverArtArchive();
  pool
    .intercept({ path: '/release-group/cover-hit-test/front', method: 'HEAD' })
    .reply(200, '', { headers: {} });

  const url = await getFrontCoverUrl('cover-hit-test');
  assert.ok(url, 'expected a resolved cover art URL');
});

test('getFrontCoverUrl returns null on a 404 (no art available)', async () => {
  const pool = mockCoverArtArchive();
  pool.intercept({ path: '/release-group/cover-miss-test/front', method: 'HEAD' }).reply(404, '');

  const url = await getFrontCoverUrl('cover-miss-test');
  assert.equal(url, null);
});

test('getFrontCoverUrl returns null (not a throw) on a network error', async () => {
  const pool = mockCoverArtArchive();
  pool.intercept({ path: '/release-group/cover-error-test/front', method: 'HEAD' }).replyWithError(new Error('network down'));

  const url = await getFrontCoverUrl('cover-error-test');
  assert.equal(url, null);
});

test('getFrontCoverUrl caches results so a repeat lookup does not hit the network again', async () => {
  const pool = mockCoverArtArchive();
  let callCount = 0;
  pool
    .intercept({ path: '/release-group/cover-cache-test/front', method: 'HEAD' })
    .reply(200, () => {
      callCount += 1;
      return '';
    })
    .persist();

  await getFrontCoverUrl('cover-cache-test');
  await getFrontCoverUrl('cover-cache-test');
  assert.equal(callCount, 1, 'second call should be served from cache');
});

test('getFrontCoverImage downloads the resolved cover art bytes', async () => {
  const pool = mockCoverArtArchive();
  pool
    .intercept({ path: '/release-group/rg-cover-image-test/front', method: 'HEAD' })
    .reply(307, '', { headers: { location: 'https://coverartarchive.org/release-group/rg-cover-image-test/front-1200.jpg' } });
  pool
    .intercept({ path: '/release-group/rg-cover-image-test/front-1200.jpg', method: 'HEAD' })
    .reply(200, '', { headers: {} });
  pool
    .intercept({ path: '/release-group/rg-cover-image-test/front-1200.jpg', method: 'GET' })
    .reply(200, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } });

  const image = await getFrontCoverImage('rg-cover-image-test');
  assert.deepEqual(image.bytes, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal(image.mimeType, 'image/jpeg');
});

test('getFrontCoverImage returns null when no cover art exists', async () => {
  const pool = mockCoverArtArchive();
  pool.intercept({ path: '/release-group/rg-no-cover/front', method: 'HEAD' }).reply(404);

  const image = await getFrontCoverImage('rg-no-cover');
  assert.equal(image, null);
});
