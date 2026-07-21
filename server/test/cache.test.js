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
