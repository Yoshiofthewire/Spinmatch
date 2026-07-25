import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { parseTrustProxy } = await import('../src/config.js');

// The regression this file exists for: TRUST_PROXY is an environment variable,
// so it arrives as a string, and Express only reads a *number* as a hop count. A
// string went down the IP/subnet branch instead, compiled to a matcher that
// matched nothing, and was ignored — while README and .env.example both told the
// user to set exactly that. The setting looked on and was off, which left the
// login rate limiter keyed to the proxy's single IP for every client and the
// session cookie without its Secure flag behind TLS.
//
// These assert the behaviour end to end (does req.ip actually follow
// X-Forwarded-For?) rather than just the parse, because asserting the parse
// alone is how the original bug survived review.

test('a hop count arrives as a number, not the string Express would misread', () => {
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(typeof parseTrustProxy('1'), 'number');
  assert.equal(parseTrustProxy(' 2 '), 2);
});

test('booleans, subnets and presets are passed through in the shape Express wants', () => {
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
  assert.equal(parseTrustProxy('loopback'), 'loopback');
});

test('unset, empty and whitespace all mean "no proxy"', () => {
  assert.equal(parseTrustProxy(undefined), null);
  assert.equal(parseTrustProxy(null), null);
  assert.equal(parseTrustProxy(''), null);
  assert.equal(parseTrustProxy('   '), null);
});

// Spins up a real Express app so the assertion is about Express's actual
// behaviour, not our belief about it.
async function reqWithForwarded(trustProxyEnv) {
  const express = (await import('express')).default;
  const app = express();
  const parsed = parseTrustProxy(trustProxyEnv);
  if (parsed != null) app.set('trust proxy', parsed);
  app.get('/x', (req, res) => res.json({ ip: req.ip, secure: req.secure }));

  const server = http.createServer(app).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/x`, {
      headers: { 'X-Forwarded-For': '9.9.9.9', 'X-Forwarded-Proto': 'https' },
    });
    return res.json();
  } finally {
    server.close();
  }
}

test('TRUST_PROXY=1 actually makes Express honour X-Forwarded-For and -Proto', async () => {
  const body = await reqWithForwarded('1');
  assert.equal(body.ip, '9.9.9.9', 'the rate limiter would otherwise key every client to the proxy');
  assert.equal(body.secure, true, 'the session cookie would otherwise never be marked Secure');
});

test('TRUST_PROXY unset ignores X-Forwarded-*, which is the safe direct-exposure default', async () => {
  const body = await reqWithForwarded(undefined);
  assert.notEqual(body.ip, '9.9.9.9');
  assert.equal(body.secure, false);
});

test('TRUST_PROXY=true is accepted rather than throwing at boot', async () => {
  // proxy-addr threw `invalid IP address: true` on the raw string, which killed
  // the process at startup for anyone who read "anything Express accepts"
  // literally.
  const body = await reqWithForwarded('true');
  assert.equal(body.ip, '9.9.9.9');
  assert.equal(body.secure, true);
});
