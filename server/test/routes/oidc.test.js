import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockIdp, rsaKey, jwk } from '../fixtures/mockIdp.js';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const {
  createAdmin, hashPassword, issueToken, getSigningSecret, getAdmin,
} = await import('../../src/services/auth.js');

const CLIENT_ID = 'spinmatch';
const CLIENT_SECRET = 'client-secret-0123456789abcdef';
let server;
let base;
let idp;
let db;

// A fresh settings object also drops the cached discovery.
function configure(extra = {}) {
  config.oidc = {
    issuer: idp.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    redirectUri: `${base}/api/auth/oidc/callback`, postLogoutUri: null, only: false, ...extra,
  };
}

test.before(async () => {
  db = openDb(':memory:');
  setDbForTest(db);
  createAdmin(db, 'yoshi', await hashPassword('hunter2hunter2'));
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${server.address().port}`;
  idp = await startMockIdp({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
});

test.after(async () => {
  config.oidc = null;
  server.close();
  await idp.close();
});

test.beforeEach(() => {
  configure();
  idp.metadata = {};
  idp.sub = 'user-1';
  db.prepare('UPDATE app_auth SET oidc_issuer = NULL, oidc_sub = NULL').run();
});

const cookieOf = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const pair = (setCookie) => setCookie.split(';')[0];
const sameOrigin = { 'Sec-Fetch-Site': 'same-origin' };

// Minted directly: the login rate limiter would trip across this many tests.
function passwordSession() {
  return `spinmatch_session=${issueToken(getSigningSecret(db), 'yoshi', getAdmin(db).tokenEpoch)}`;
}

async function passwordLogin() {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sameOrigin },
    body: JSON.stringify({ username: 'yoshi', password: 'hunter2hunter2' }),
  });
  assert.equal(res.status, 200);
  return pair(cookieOf(res, 'spinmatch_session'));
}

async function status(cookie) {
  return (await fetch(`${base}/api/auth/status`, { headers: cookie ? { cookie } : {} })).json();
}

// Start (login or link) -> IdP authorize -> callback; returns the callback outcome.
async function roundTrip({ purpose = 'login', session, editCallback } = {}) {
  let start;
  let authorizeUrl;
  if (purpose === 'link') {
    start = await fetch(`${base}/api/auth/oidc/link`, { method: 'POST', headers: { cookie: session, ...sameOrigin } });
    assert.equal(start.status, 200);
    authorizeUrl = (await start.json()).url;
  } else {
    start = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    authorizeUrl = start.headers.get('location');
  }
  const pending = cookieOf(start, 'spinmatch_oidc');
  if (!authorizeUrl.startsWith(idp.issuer)) return { location: authorizeUrl, pending };
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  let callbackUrl = authorize.headers.get('location');
  if (editCallback) callbackUrl = editCallback(callbackUrl);
  const callback = () => fetch(callbackUrl, { redirect: 'manual', headers: { cookie: pair(pending) } });
  const res = await callback();
  assert.equal(res.status, 302);
  const issued = cookieOf(res, 'spinmatch_session');
  return { location: res.headers.get('location'), session: issued && pair(issued), pending, callback };
}

async function link() {
  const result = await roundTrip({ purpose: 'link', session: passwordSession() });
  assert.equal(result.location, '/account?sso_linked=1');
}

// ---- Login and link ----

test('status advertises SSO only when configured', async () => {
  assert.deepEqual((await status()).oidc, { enabled: true, only: false });
  config.oidc = null;
  assert.deepEqual((await status()).oidc, { enabled: false });
  assert.equal((await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' })).status, 404);
});

test('login start uses code flow with PKCE S256, state, nonce, and a Lax pending cookie', async () => {
  const before = idp.authorizeRequests.length;
  const { location, pending } = await roundTrip();
  const req = idp.authorizeRequests[before];
  assert.equal(req.response_type, 'code');
  assert.equal(req.scope, 'openid profile email');
  assert.equal(req.code_challenge_method, 'S256');
  assert.ok(req.code_challenge && req.state && req.nonce);
  assert.equal(req.redirect_uri, config.oidc.redirectUri);
  assert.match(pending, /HttpOnly/);
  assert.match(pending, /SameSite=Lax/);
  assert.match(pending, /Path=\/api\/auth\/oidc/);
  assert.equal(location, '/?sso_error=unlinked');
});

test('an unlinked identity cannot sign in', async () => {
  const { location, session } = await roundTrip();
  assert.equal(location, '/?sso_error=unlinked');
  assert.equal(session, undefined);
});

test('link needs a session, then the linked identity signs in', async () => {
  const anon = await fetch(`${base}/api/auth/oidc/link`, { method: 'POST', headers: sameOrigin });
  assert.equal(anon.status, 401);

  await link();
  const session = passwordSession();
  const info = await (await fetch(`${base}/api/auth/oidc/link`, { headers: { cookie: session } })).json();
  assert.deepEqual(info, { link: { issuer: idp.issuer, sub: 'user-1' }, only: false });

  const { location, session: ssoSession } = await roundTrip();
  assert.equal(location, '/');
  assert.equal((await status(ssoSession)).authenticated, true);
});

test('login matches (iss, sub) only: another sub with the same email is refused', async () => {
  await link();
  idp.sub = 'user-2';
  const { location, session } = await roundTrip();
  assert.equal(location, '/?sso_error=unlinked');
  assert.equal(session, undefined);
});

test('a link from another issuer does not sign in', async () => {
  db.prepare("UPDATE app_auth SET oidc_issuer = 'https://other.example', oidc_sub = 'user-1'").run();
  assert.equal((await roundTrip()).location, '/?sso_error=unlinked');
});

test('unlink is session-only and ends SSO sign-in', async () => {
  await link();
  const session = passwordSession();
  const token = await fetch(`${base}/api/auth/oidc/link`, {
    method: 'DELETE', headers: { Authorization: 'Bearer nope' },
  });
  assert.equal(token.status, 401);
  const res = await fetch(`${base}/api/auth/oidc/link`, { method: 'DELETE', headers: { cookie: session, ...sameOrigin } });
  assert.equal(res.status, 200);
  assert.equal((await roundTrip()).location, '/?sso_error=unlinked');
});

// ---- ID token and flow rejections ----

async function rejectedLogin(setup, expected = '/?sso_error=failed') {
  await link();
  setup();
  const { location, session } = await roundTrip();
  assert.equal(location, expected);
  assert.equal(session, undefined, 'no session cookie');
}

const now = () => Math.floor(Date.now() / 1000);
const tamper = (fn) => () => { idp.mutate = fn; };

test('rejects HS256 signed with the client secret', () => rejectedLogin(() => {
  idp.mutate = (h) => { h.alg = 'HS256'; };
  idp.signWith = { secret: CLIENT_SECRET };
}));
test('rejects alg none', () => rejectedLogin(() => {
  idp.mutate = (h) => { h.alg = 'none'; };
  idp.signWith = {};
}));
test('rejects a 1024-bit RSA key', () => rejectedLogin(() => {
  const weak = rsaKey(1024);
  idp.keys = [...idp.keys.filter((k) => k.kid !== 'weak'), jwk(weak, 'weak')];
  configure(); // fresh discovery, so the JWKS with the weak key is fetched
  idp.mutate = (h) => { h.kid = 'weak'; };
  idp.signWith = { key: weak.privateKey };
}));
test('rejects a token signed by a key not in the JWKS', () => rejectedLogin(() => {
  idp.signWith = { key: rsaKey().privateKey };
}));
test('rejects typ logout+jwt', () => rejectedLogin(tamper((h) => { h.typ = 'logout+jwt'; })));
test('accepts typ at+jwt and absent typ', async () => {
  await link();
  for (const typ of ['at+jwt', undefined]) {
    idp.mutate = (h) => { h.typ = typ; };
    assert.equal((await roundTrip()).location, '/');
  }
});
test('rejects an events claim in an ID token', () => rejectedLogin(tamper((h, c) => { c.events = {}; })));
test('rejects an audience array naming another client', () => rejectedLogin(
  tamper((h, c) => { c.aud = [CLIENT_ID, 'other']; c.azp = CLIENT_ID; }),
));
test('rejects a wrong audience', () => rejectedLogin(tamper((h, c) => { c.aud = 'other'; })));
test('rejects an expired token beyond the 60 s leeway', () => rejectedLogin(tamper((h, c) => {
  c.iat = now() - 600; c.auth_time = c.iat; c.exp = now() - 61;
})));
test('rejects a token without exp', () => rejectedLogin(tamper((h, c) => { delete c.exp; })));
test('rejects iat in the future', () => rejectedLogin(tamper((h, c) => { c.iat = now() + 120; })));
test('rejects nbf in the future', () => rejectedLogin(tamper((h, c) => { c.nbf = now() + 120; })));
test('rejects a missing sub', () => rejectedLogin(tamper((h, c) => { delete c.sub; })));
test('rejects an empty sub', () => rejectedLogin(tamper((h, c) => { c.sub = ''; })));
test('rejects a wrong issuer claim', () => rejectedLogin(tamper((h, c) => { c.iss = `${idp.issuer}/`; })));
test('rejects a nonce mismatch', () => rejectedLogin(tamper((h, c) => { c.nonce = 'other'; })));
test('rejects a missing sid when the IdP supports session logout', () => rejectedLogin(
  tamper((h, c) => { delete c.sid; }),
));
test('accepts no sid when the IdP does not advertise session logout', async () => {
  await link();
  idp.metadata = { backchannel_logout_session_supported: false };
  configure();
  idp.mutate = (h, c) => { delete c.sid; };
  assert.equal((await roundTrip()).location, '/');
});
test('rejects auth_time later than iat + 60 s', () => rejectedLogin(tamper((h, c) => { c.auth_time = c.iat + 61; })));
test('a logout token never works as an ID token', () => rejectedLogin(tamper((h, c) => {
  h.typ = 'logout+jwt'; c.events = { 'http://schemas.openid.net/event/backchannel-logout': {} }; c.jti = 'j';
})));

test('rejects a state mismatch, and the pending row is spent', async () => {
  await link();
  const first = await roundTrip({ editCallback: (u) => u.replace(/state=[^&]+/, 'state=forged') });
  assert.equal(first.location, '/?sso_error=failed');
  const again = await first.callback();
  assert.equal(again.headers.get('location'), '/?sso_error=expired');
});

test('a replayed callback is refused', async () => {
  await link();
  const first = await roundTrip();
  assert.equal(first.location, '/');
  const replay = await first.callback();
  assert.equal(replay.headers.get('location'), '/?sso_error=expired');
  assert.equal(cookieOf(replay, 'spinmatch_session'), undefined);
});

test('a callback without the pending cookie is refused', async () => {
  const res = await fetch(`${base}/api/auth/oidc/callback?code=x&state=y`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/?sso_error=expired');
});

test('a pending row older than five minutes is refused', async () => {
  await link();
  const { location } = await roundTrip({
    editCallback: (u) => {
      db.prepare('UPDATE oidc_pending SET created_at = created_at - 300001').run();
      return u;
    },
  });
  assert.equal(location, '/?sso_error=expired');
});

test('an IdP error maps to a fixed code, never its description', async () => {
  idp.denyNext = true;
  const { location } = await roundTrip();
  assert.equal(location, '/?sso_error=denied');
});

test('a link failure returns to the account page', async () => {
  idp.mutate = (h, c) => { c.aud = 'other'; };
  const result = await roundTrip({ purpose: 'link', session: passwordSession() });
  assert.equal(result.location, '/account?sso_error=failed');
  assert.equal(db.prepare('SELECT oidc_sub FROM app_auth').get().oidc_sub, null);
});

// ---- Discovery ----

test('discovery must return exactly OIDC_ISSUER', async () => {
  idp.metadata = { issuer: `${idp.issuer}/` };
  assert.equal((await roundTrip()).location, '/?sso_error=failed');
  configure({ issuer: `${idp.issuer}/` }); // URL-equal but not the same string
  idp.metadata = {};
  assert.equal((await roundTrip()).location, '/?sso_error=failed');
});

test('discovery refuses plain-http endpoints off loopback', async () => {
  idp.metadata = { token_endpoint: 'http://idp.example/token' };
  assert.equal((await roundTrip()).location, '/?sso_error=failed');
});

test('discovery does not follow redirects', async () => {
  idp.redirectDiscovery = true;
  try {
    assert.equal((await roundTrip()).location, '/?sso_error=failed');
  } finally {
    idp.redirectDiscovery = false;
  }
});

test('the token endpoint is not called twice for one code', async () => {
  await link();
  const before = idp.tokenRequests;
  const first = await roundTrip();
  await first.callback();
  assert.equal(idp.tokenRequests - before, 1);
});

// ---- OIDC_ONLY ----

test('OIDC_ONLY blocks password login only once an identity is linked', async () => {
  configure({ only: true });
  await passwordLogin();
  await link();
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sameOrigin },
    body: JSON.stringify({ username: 'yoshi', password: 'hunter2hunter2' }),
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error.message, /OIDC_ONLY/);
  assert.equal((await roundTrip()).location, '/');
});

// ---- RP-initiated logout ----

async function logout(session) {
  const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: session, ...sameOrigin } });
  assert.equal(res.status, 200);
  return res.json();
}

test('logout returns the IdP end-session URL only when linked', async () => {
  assert.deepEqual(await logout(passwordSession()), { ok: true });
  await link();
  const plain = new URL((await logout(passwordSession())).endSessionUrl);
  assert.equal(plain.origin + plain.pathname, `${idp.issuer}/logout`);
  assert.equal(plain.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(plain.searchParams.has('post_logout_redirect_uri'), false);

  configure({ postLogoutUri: `${base}/` });
  const back = new URL((await logout(passwordSession())).endSessionUrl);
  assert.equal(back.searchParams.get('post_logout_redirect_uri'), `${base}/`);
});

// ---- Back-channel logout ----

function postLogout(token, headers = {}) {
  return fetch(`${base}/api/auth/oidc/backchannel-logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(token === undefined ? {} : { logout_token: token }),
  });
}

test('a valid logout token signs out every session; its replay is refused', async () => {
  await link();
  const session = passwordSession();
  const token = idp.logoutToken();
  // No Origin, Referer or Sec-Fetch-Site: a server-to-server post must get through.
  const res = await postLogout(token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await status(session)).authenticated, false);

  const replay = await postLogout(token);
  assert.equal(replay.status, 400);
  assert.equal(replay.headers.get('cache-control'), 'no-store');
});

test('the replay record is kept past the token lifetime', async () => {
  await link();
  const token = idp.logoutToken();
  assert.equal((await postLogout(token)).status, 200);
  const row = db.prepare('SELECT expires_at FROM oidc_logout_replay ORDER BY rowid DESC').get();
  assert.ok(row.expires_at > Date.now() + 60_000, 'kept past the token lifetime');
});

test('sid-only and sub-only logout tokens are accepted', async () => {
  await link();
  assert.equal((await postLogout(idp.logoutToken((h, c) => { delete c.sub; }))).status, 200);
  assert.equal((await postLogout(idp.logoutToken((h, c) => { delete c.sid; }))).status, 200);
});

const badLogout = {
  'nonce present': (h, c) => { c.nonce = 'n'; },
  'events missing': (h, c) => { delete c.events; },
  'wrong event': (h, c) => { c.events = { other: {} }; },
  'event not an object': (h, c) => { c.events = { 'http://schemas.openid.net/event/backchannel-logout': true }; },
  'wrong sub': (h, c) => { c.sub = 'user-2'; },
  'no sub or sid': (h, c) => { delete c.sub; delete c.sid; },
  'no jti': (h, c) => { delete c.jti; },
  'typ JWT': (h) => { h.typ = 'JWT'; },
  'typ absent': (h) => { delete h.typ; },
  'alg HS256': (h) => { h.alg = 'HS256'; },
  'wrong issuer': (h, c) => { c.iss = 'https://other.example'; },
  'wrong audience': (h, c) => { c.aud = 'other'; },
  'audience array': (h, c) => { c.aud = [CLIENT_ID, 'other']; },
  'iat older than 5 min + leeway': (h, c) => { c.iat = now() - 361; c.exp = now() + 60; },
  'iat in the future': (h, c) => { c.iat = now() + 120; c.exp = now() + 240; },
  expired: (h, c) => { c.iat = now() - 200; c.exp = now() - 61; },
  'no exp': (h, c) => { delete c.exp; },
  'exp not after iat': (h, c) => { c.exp = c.iat; },
  'token_use marker': (h, c) => { c.token_use = 'access'; },
};
for (const [name, mutate] of Object.entries(badLogout)) {
  test(`back-channel logout rejects: ${name}`, async () => {
    await link();
    const session = passwordSession();
    const res = await postLogout(idp.logoutToken(mutate));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: { code: 'BAD_REQUEST', message: 'Invalid logout token' } });
    assert.equal((await status(session)).authenticated, true, 'sessions untouched');
  });
}

test('back-channel logout rejects a 1024-bit RSA key', async () => {
  const weak = rsaKey(1024);
  idp.keys = [...idp.keys.filter((k) => k.kid !== 'weak'), jwk(weak, 'weak')];
  configure();
  await link();
  const token = idp.logoutToken((h) => { h.kid = 'weak'; }, { key: weak.privateKey });
  assert.equal((await postLogout(token)).status, 400);
});

test('back-channel logout rejects when no identity is linked, or no token is sent', async () => {
  assert.equal((await postLogout(idp.logoutToken())).status, 400);
  await link();
  assert.equal((await postLogout(undefined)).status, 400);
  const oversized = await postLogout('x'.repeat(20_000));
  assert.equal(oversized.status, 413);
});

test('a logout token never authenticates as a session or API token', async () => {
  await link();
  const token = idp.logoutToken();
  assert.equal((await status(`spinmatch_session=${token}`)).authenticated, false);
  const bearer = await fetch(`${base}/api/search?q=x`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(bearer.status, 401);
});

test('only the back-channel path is exempt from the CSRF guard', async () => {
  const evil = { Origin: 'https://evil.example' };
  const logoutRes = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
  assert.equal(logoutRes.status, 400);
  assert.match((await logoutRes.json()).error.message, /Sec-Fetch-Site, Origin, or Referer/);
  const linkRes = await fetch(`${base}/api/auth/oidc/link`, { method: 'POST', headers: evil });
  assert.equal(linkRes.status, 400);
  const queried = await fetch(`${base}/api/auth/oidc/backchannel-logout?x=1`, { method: 'POST', headers: evil });
  assert.equal(queried.status, 400);
  assert.match((await queried.json()).error.message, /Cross-origin/);
  const exempt = await postLogout('junk', evil);
  assert.deepEqual(await exempt.json(), { error: { code: 'BAD_REQUEST', message: 'Invalid logout token' } });
});
