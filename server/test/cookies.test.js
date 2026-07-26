import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { parseCookies, serializeCookie } = await import('../src/lib/cookies.js');

test('a normal cookie header parses into name/value pairs', () => {
  assert.deepEqual(
    parseCookies('spinmatch_session=abc.def; theme=dark'),
    { spinmatch_session: 'abc.def', theme: 'dark' },
  );
});

test('percent-encoded values are decoded', () => {
  assert.deepEqual(parseCookies('x=a%20b'), { x: 'a b' });
});

// The bug this exists for: decodeURIComponent throws URIError on a malformed
// escape, and parseCookies runs inside requireAuth on every protected route and
// inside /api/auth/status. Any page on a sibling subdomain can set a cookie
// scoped to the parent domain, so one junk value turned the whole app into a 500
// wall with no in-app way back.
test('a malformed percent-escape does not throw', () => {
  for (const header of ['spinmatch_session=%', 'x=%zz', 'x=100%', 'x=%E0%A4%A']) {
    assert.doesNotThrow(() => parseCookies(header), `threw on: ${header}`);
  }
});

test('an undecodable value is kept raw rather than dropped', () => {
  // It can't be a real token (those are base64url and never need escaping), so
  // it goes on to fail the signature check — which is the correct outcome, and
  // is only reachable if the key is present at all.
  assert.deepEqual(parseCookies('spinmatch_session=%'), { spinmatch_session: '%' });
});

test('a malformed cookie does not hide the valid ones beside it', () => {
  const parsed = parseCookies('junk=%; spinmatch_session=good.token');
  assert.equal(parsed.spinmatch_session, 'good.token');
});

test('serializeCookie emits the flags it is given', () => {
  const raw = serializeCookie('n', 'v', { maxAge: 60, httpOnly: true, sameSite: 'Strict', secure: true });
  assert.match(raw, /^n=v; Path=\/; Max-Age=60; HttpOnly; SameSite=Strict; Secure$/);
});
