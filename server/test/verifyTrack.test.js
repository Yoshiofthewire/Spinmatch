import test from 'node:test';
import assert from 'node:assert/strict';
import child_process from 'node:child_process';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { verifyTrack } = await import('../src/services/verifyTrack.js');

function mockExecFile(t, impl) {
  t.mock.method(child_process, 'execFile', impl);
}

function ndjson(items) {
  return items.map((i) => JSON.stringify(i)).join('\n') + '\n';
}

test('verifyTrack retries without the album title when the full query has zero candidates', async (t) => {
  let searchCallCount = 0;
  mockExecFile(t, (bin, args, opts, callback) => {
    searchCallCount += 1;
    const query = args[args.length - 1];
    if (query.includes('Fallback Test Album')) {
      callback(null, ndjson([]), '');
    } else {
      callback(null, ndjson([{ id: 'vid-1', title: 'Found It', duration: 200 }]), '');
    }
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

test('verifyTrack caches results so an identical repeat call makes no further yt-dlp calls', async (t) => {
  let searchCallCount = 0;
  mockExecFile(t, (bin, args, opts, callback) => {
    searchCallCount += 1;
    callback(null, ndjson([{ id: 'vid-cache', title: 'Cached Song', duration: 200 }]), '');
  });

  const args = { artist: 'Cache Test Artist', title: 'Cache Test Song', album: 'Cache Test Album', lengthMs: 200000 };
  const first = await verifyTrack(args);
  const second = await verifyTrack(args);

  assert.equal(searchCallCount, 1, 'second call should be served from cache, not re-invoke yt-dlp');
  assert.deepEqual(first, second);
});

test('verifyTrack returns no_results when yt-dlp has nothing even after the retry', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => callback(null, ndjson([]), ''));

  const result = await verifyTrack({
    artist: 'Empty Result Artist',
    title: 'Empty Result Song',
    album: 'Empty Result Album',
    lengthMs: 200000,
  });

  assert.equal(result.status, 'no_results');
  assert.equal(result.video, null);
});
