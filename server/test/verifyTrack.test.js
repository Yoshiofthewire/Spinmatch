import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.YOUTUBE_API_KEY = 'test-key';
process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { verifyTrack } = await import('../src/services/verifyTrack.js');

function mockYouTube() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent.get('https://www.googleapis.com');
}

test('verifyTrack retries without the album title when the full query has zero candidates', async () => {
  const pool = mockYouTube();
  let searchCallCount = 0;

  pool
    .intercept({ path: (path) => /\/youtube\/v3\/search\?/.test(path) && path.includes('Fallback+Test+Album') })
    .reply(200, () => {
      searchCallCount += 1;
      return { items: [] };
    });

  pool
    .intercept({ path: (path) => /\/youtube\/v3\/search\?/.test(path) && !path.includes('Fallback+Test+Album') })
    .reply(200, () => {
      searchCallCount += 1;
      return { items: [{ id: { videoId: 'vid-1' }, snippet: { title: 'Found It' } }] };
    });

  pool.intercept({ path: /\/youtube\/v3\/videos\?/ }).reply(200, {
    items: [{ id: 'vid-1', contentDetails: { duration: 'PT3M20S' } }],
  });

  const result = await verifyTrack({
    artist: 'Fallback Test Artist',
    title: 'Fallback Test Song',
    album: 'Fallback Test Album',
    lengthMs: 200000,
  });

  assert.equal(searchCallCount, 2, 'expected one search with album, one retry without it');
  assert.equal(result.status, 'confirmed');
  assert.equal(result.video.id, 'vid-1');
});

test('verifyTrack caches results so an identical repeat call makes no further HTTP requests', async () => {
  const pool = mockYouTube();
  let searchCallCount = 0;

  pool
    .intercept({ path: /\/youtube\/v3\/search\?/ })
    .reply(200, () => {
      searchCallCount += 1;
      return { items: [{ id: { videoId: 'vid-cache' }, snippet: { title: 'Cached Song' } }] };
    });
  pool.intercept({ path: /\/youtube\/v3\/videos\?/ }).reply(200, {
    items: [{ id: 'vid-cache', contentDetails: { duration: 'PT3M20S' } }],
  });

  const args = { artist: 'Cache Test Artist', title: 'Cache Test Song', album: 'Cache Test Album', lengthMs: 200000 };
  const first = await verifyTrack(args);
  const second = await verifyTrack(args);

  assert.equal(searchCallCount, 1, 'second call should be served from cache, not re-hit YouTube');
  assert.deepEqual(first, second);
});

test('verifyTrack returns no_results when YouTube has nothing even after the retry', async () => {
  const pool = mockYouTube();
  pool.intercept({ path: /\/youtube\/v3\/search\?/ }).reply(200, { items: [] }).persist();

  const result = await verifyTrack({
    artist: 'Empty Result Artist',
    title: 'Empty Result Song',
    album: 'Empty Result Album',
    lengthMs: 200000,
  });

  assert.equal(result.status, 'no_results');
  assert.equal(result.video, null);
});
