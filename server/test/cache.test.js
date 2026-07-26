import test from 'node:test';
import assert from 'node:assert/strict';
import { TTLCache } from '../src/lib/cache.js';

test('TTLCache returns stored values before expiry', () => {
  const cache = new TTLCache();
  cache.set('k', { a: 1 }, 1000);
  assert.deepEqual(cache.get('k'), { a: 1 });
  assert.equal(cache.has('k'), true);
});

test('TTLCache expires entries after the TTL elapses', async () => {
  const cache = new TTLCache();
  cache.set('k', 'v', 10);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.has('k'), false);
});

test('TTLCache treats missing keys as undefined', () => {
  const cache = new TTLCache();
  assert.equal(cache.get('missing'), undefined);
});

// An entry count is a proxy for memory only when entries are a similar size, and
// for cover art they are not: the image cache's "tight bound" of 24 entries
// permitted 24 x 8 MB = 192 MB of retained Buffers.
test('maxBytes evicts before maxEntries when values are large', () => {
  const cache = new TTLCache({
    maxEntries: 100,
    maxBytes: 300,
    sizeOf: (v) => v.length,
  });
  cache.set('a', Buffer.alloc(100), 60_000);
  cache.set('b', Buffer.alloc(100), 60_000);
  cache.set('c', Buffer.alloc(100), 60_000);
  assert.equal(cache.size, 3);

  cache.set('d', Buffer.alloc(100), 60_000);
  assert.equal(cache.get('a'), undefined, 'the oldest entry was evicted to make room');
  assert.ok(cache.get('d'));
  assert.ok(cache.bytes <= 300);
});

test('the byte total is decremented on eviction, expiry and overwrite', () => {
  const cache = new TTLCache({ maxEntries: 10, maxBytes: 1000, sizeOf: (v) => v.length });
  cache.set('a', Buffer.alloc(100), 60_000);
  cache.set('a', Buffer.alloc(50), 60_000);
  assert.equal(cache.bytes, 50, 'overwriting a key does not double-count it');

  cache.set('b', Buffer.alloc(100), -1); // already expired
  cache.prune();
  assert.equal(cache.bytes, 50);
});

test('a single value larger than maxBytes is still stored rather than looping forever', () => {
  const cache = new TTLCache({ maxEntries: 10, maxBytes: 100, sizeOf: (v) => v.length });
  cache.set('a', Buffer.alloc(50), 60_000);
  cache.set('big', Buffer.alloc(500), 60_000);
  assert.equal(cache.get('a'), undefined, 'the cache was emptied making room');
  assert.ok(cache.get('big'), 'and the oversized value was stored anyway');
});

test('a cache with no sizeOf behaves exactly as before', () => {
  const cache = new TTLCache({ maxEntries: 2 });
  cache.set('a', 1, 60_000);
  cache.set('b', 2, 60_000);
  cache.set('c', 3, 60_000);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('a cached null is a hit, not a miss', () => {
  // The cover route caches "this track has no art" — the most expensive miss of
  // the three, since rediscovering it costs a tag parse and a directory scan.
  const cache = new TTLCache({ maxEntries: 4 });
  cache.set('k', null, 60_000);
  assert.equal(cache.get('k'), null);
  assert.notEqual(cache.get('k'), undefined);
});
