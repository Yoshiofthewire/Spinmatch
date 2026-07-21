import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/lib/rateLimiter.js';

test('RateLimiter spaces consecutive calls by at least minIntervalMs', async () => {
  const limiter = new RateLimiter(100);
  const timestamps = [];

  await limiter.schedule(async () => timestamps.push(Date.now()));
  await limiter.schedule(async () => timestamps.push(Date.now()));
  await limiter.schedule(async () => timestamps.push(Date.now()));

  assert.equal(timestamps.length, 3);
  assert.ok(timestamps[1] - timestamps[0] >= 95, 'second call should wait for the interval');
  assert.ok(timestamps[2] - timestamps[1] >= 95, 'third call should wait for the interval');
});

test('RateLimiter continues processing the queue after a rejected call', async () => {
  const limiter = new RateLimiter(10);
  const results = [];

  const failing = limiter.schedule(async () => {
    throw new Error('boom');
  });
  const succeeding = limiter.schedule(async () => {
    results.push('ok');
    return 'ok';
  });

  await assert.rejects(failing, /boom/);
  assert.equal(await succeeding, 'ok');
  assert.deepEqual(results, ['ok']);
});
