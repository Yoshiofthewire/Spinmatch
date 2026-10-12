import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

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

// Content-Length is what the sender claims. Buffering the whole body first and
// checking its size afterwards means the claim decides how much memory the
// process allocates, which is the wrong way round.
test('getFrontCoverImage refuses a body that runs past the limit despite a small Content-Length', async () => {
  const pool = mockCoverArtArchive();
  const { MAX_IMAGE_BYTES } = await import('../src/lib/imageBytes.js');
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1024, 0x41);

  pool
    .intercept({ path: '/release-group/rg-liar/front', method: 'HEAD' })
    .reply(307, '', { headers: { location: 'https://coverartarchive.org/release-group/rg-liar/front-1200.jpg' } });
  pool
    .intercept({ path: '/release-group/rg-liar/front-1200.jpg', method: 'HEAD' })
    .reply(200, '', { headers: {} });
  pool
    .intercept({ path: '/release-group/rg-liar/front-1200.jpg', method: 'GET' })
    .reply(200, oversized, { headers: { 'content-type': 'image/jpeg', 'content-length': '1024' } });

  assert.equal(await getFrontCoverImage('rg-liar'), null);
});

// The honest oversized case is still refused on the header alone, without
// reading the body at all.
test('getFrontCoverImage refuses art that declares itself over the limit', async () => {
  const pool = mockCoverArtArchive();
  const { MAX_IMAGE_BYTES } = await import('../src/lib/imageBytes.js');

  pool
    .intercept({ path: '/release-group/rg-huge/front', method: 'HEAD' })
    .reply(307, '', { headers: { location: 'https://coverartarchive.org/release-group/rg-huge/front-1200.jpg' } });
  pool
    .intercept({ path: '/release-group/rg-huge/front-1200.jpg', method: 'HEAD' })
    .reply(200, '', { headers: {} });
  pool
    .intercept({ path: '/release-group/rg-huge/front-1200.jpg', method: 'GET' })
    .reply(200, '', { headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_IMAGE_BYTES + 1) } });

  assert.equal(await getFrontCoverImage('rg-huge'), null);
});

test('a redirect off Cover Art Archive / archive.org, or to plain http, is never followed', async () => {
  for (const [id, location] of [
    ['rg-lan', 'https://192.168.1.10/admin.png'],
    ['rg-other-host', 'https://evil.example/front.jpg'],
    ['rg-http', 'http://ia800.us.archive.org/front.jpg'],
    ['rg-lookalike', 'https://notarchive.org/front.jpg'],
  ]) {
    const pool = mockCoverArtArchive();
    pool.intercept({ path: `/release-group/${id}/front`, method: 'HEAD' }).reply(307, '', { headers: { location } });
    // The target would answer if it were ever asked.
    const target = new URL(location);
    getGlobalDispatcher().get(target.origin).intercept({ path: target.pathname, method: 'HEAD' }).reply(200, '');
    assert.equal(await getFrontCoverUrl(id), null, location);
  }
});

test('a redirect to an archive.org mirror is followed', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  agent.get('https://coverartarchive.org')
    .intercept({ path: '/release-group/rg-mirror/front', method: 'HEAD' })
    .reply(307, '', { headers: { location: 'https://ia800.us.archive.org/0/items/x/front.jpg' } });
  agent.get('https://ia800.us.archive.org')
    .intercept({ path: '/0/items/x/front.jpg', method: 'HEAD' })
    .reply(200, '');
  assert.equal(await getFrontCoverUrl('rg-mirror'), 'https://ia800.us.archive.org/0/items/x/front.jpg');
});
