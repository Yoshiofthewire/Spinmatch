import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { createAttemptLimiter } = await import('../src/lib/attemptLimiter.js');

test('allows up to max attempts per key, then blocks', () => {
  let t = 0;
  const limit = createAttemptLimiter({ max: 3, windowMs: 1000, now: () => t });
  assert.equal(limit('ip1').allowed, true);
  assert.equal(limit('ip1').allowed, true);
  assert.equal(limit('ip1').allowed, true);
  const blocked = limit('ip1');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
});

test('keys are independent', () => {
  let t = 0;
  const limit = createAttemptLimiter({ max: 1, windowMs: 1000, now: () => t });
  assert.equal(limit('a').allowed, true);
  assert.equal(limit('a').allowed, false);
  assert.equal(limit('b').allowed, true); // different key, its own budget
});

test('the window resets after windowMs', () => {
  let t = 0;
  const limit = createAttemptLimiter({ max: 1, windowMs: 1000, now: () => t });
  assert.equal(limit('ip').allowed, true);
  assert.equal(limit('ip').allowed, false);
  t = 1001; // window elapsed
  assert.equal(limit('ip').allowed, true);
});
