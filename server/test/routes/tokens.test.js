// API tokens: the second credential. Uses the real gate, like security.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-tok-music-'));
process.env.MUSIC_DIR = musicDir;

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const { createApp } = await import('../../src/app.js');
const auth = await import('../../src/services/auth.js');

let server;
let baseUrl;
let db;
let cookie;

const sameOrigin = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

function mintCookie() {
  const admin = auth.getAdmin(db);
  return `spinmatch_session=${auth.issueToken(auth.getSigningSecret(db), admin.username, admin.tokenEpoch)}`;
}

async function mint(scope, name = `${scope} token`) {
  const res = await fetch(`${baseUrl}/api/tokens`, {
    method: 'POST', headers: { ...sameOrigin, Cookie: cookie }, body: JSON.stringify({ name, scope }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

const call = (url, { method = 'GET', headers = {}, body } = {}) => fetch(baseUrl + url, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body,
});

test.before(async () => {
  db = openDb(':memory:');
  setDbForTest(db);
  auth.createAdmin(db, 'yoshi', 'unused-hash');
  cookie = mintCookie();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => {
  setDbForTest(null);
  server.close();
  delete process.env.MUSIC_DIR;
  fs.rmSync(musicDir, { recursive: true, force: true });
});

test('the token is returned once, stored only as its SHA-256, and never listed', async () => {
  const created = await mint('read', 'grafana');
  assert.match(created.token, /^spm_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.name, 'grafana');
  assert.equal(created.scope, 'read');

  const listText = await (await call('/api/tokens', { headers: { Cookie: cookie } })).text();
  assert.ok(!listText.includes(created.token), 'the list leaks the token');
  const listed = JSON.parse(listText).tokens.find((t) => t.id === created.id);
  assert.deepEqual(Object.keys(listed).sort(), ['createdAt', 'id', 'lastUsedAt', 'name', 'revokedAt', 'scope']);

  const rows = db.prepare('SELECT * FROM api_tokens WHERE id = ?').all(created.id);
  assert.equal(rows[0].hash, createHash('sha256').update(created.token).digest('hex'));
  assert.ok(!JSON.stringify(rows).includes(created.token), 'the database holds the token itself');
});

test('creation validates name and scope; scope defaults to read', async () => {
  for (const body of [{ name: '' }, { name: 'x'.repeat(65) }, { name: 'ok', scope: 'admin' }]) {
    const res = await call('/api/tokens', {
      method: 'POST', headers: { ...sameOrigin, Cookie: cookie }, body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const res = await call('/api/tokens', {
    method: 'POST', headers: { ...sameOrigin, Cookie: cookie }, body: JSON.stringify({ name: 'default' }),
  });
  assert.equal((await res.json()).scope, 'read');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('a read token can GET but not change anything', async () => {
  const { token } = await mint('read');
  assert.equal((await call('/api/library/stats', { headers: bearer(token) })).status, 200);
  for (const [method, url] of [
    ['POST', '/api/library/owned'], ['PATCH', '/api/playlists/1'], ['DELETE', '/api/history'],
  ]) {
    const res = await call(url, { method, headers: bearer(token), body: '{}' });
    assert.equal(res.status, 403, `${method} ${url}`);
    assert.equal((await res.json()).error.message, 'This token is read-only');
  }
  // A GET that does real work (SSE behind sameOriginOnly) needs full scope too.
  assert.equal((await call('/api/library/missing/stream', { headers: bearer(token) })).status, 403);
});

// Over HTTP the CSRF guard refuses read tokens first; this is the gate's own layer.
test('the gate alone refuses a read token anything but GET/HEAD', async () => {
  const { requireAuth } = await import('../../src/middleware/requireAuth.js');
  const gate = (method, scope) => {
    let passed;
    requireAuth({ method, auth: { kind: 'token', scope } }, {}, (err) => { passed = err ?? true; });
    return passed;
  };
  assert.equal(gate('GET', 'read'), true);
  assert.equal(gate('HEAD', 'read'), true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(gate(method, 'read').status, 403, method);
    assert.equal(gate(method, 'full'), true, method);
  }
});

// CSRF can't ride a bearer header, so a token request needs no origin headers. A cookie still does.
test('a full token POSTs without origin headers; the same request with only a cookie is refused', async () => {
  const { token } = await mint('full');
  const body = JSON.stringify({ albums: [], recordings: [] });
  const withToken = await call('/api/library/owned', { method: 'POST', headers: bearer(token), body });
  assert.equal(withToken.status, 200, await withToken.text());

  const withCookie = await call('/api/library/owned', { method: 'POST', headers: { Cookie: cookie }, body });
  assert.equal(withCookie.status, 400);
  assert.match((await withCookie.json()).error.message, /Sec-Fetch-Site, Origin, or Referer/);
});

test('a non-Bearer Authorization header earns no CSRF exemption', async () => {
  const res = await call('/api/library/owned', {
    method: 'POST',
    headers: { Cookie: cookie, Authorization: 'Basic dXNlcjpwYXNz', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ albums: [], recordings: [] }),
  });
  assert.equal(res.status, 400);
});

test('a bad or revoked bearer is a 401 even beside a valid cookie', async () => {
  const { id, token } = await mint('full');
  const revoke = await call(`/api/tokens/${id}`, { method: 'DELETE', headers: { ...sameOrigin, Cookie: cookie } });
  assert.equal(revoke.status, 200);

  for (const value of [token, 'spm_junk', 'junk', '']) {
    const res = await call('/api/library/stats', { headers: { ...bearer(value), Cookie: cookie } });
    assert.equal(res.status, 401, `bearer ${JSON.stringify(value)}`);
    assert.equal((await res.json()).error.code, 'INVALID_TOKEN');
  }
  // The cookie alone is fine: the 401 came from the bearer.
  assert.equal((await call('/api/library/stats', { headers: { Cookie: cookie } })).status, 200);
});

test('revoking is idempotent; an unknown id is a 404; revoke-all revokes the rest', async () => {
  const { id } = await mint('read');
  const del = () => call(`/api/tokens/${id}`, { method: 'DELETE', headers: { ...sameOrigin, Cookie: cookie } });
  await del();
  const first = db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(id).revoked_at;
  assert.equal((await del()).status, 200);
  assert.equal(db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(id).revoked_at, first);
  assert.equal((await call('/api/tokens/99999', { method: 'DELETE', headers: { ...sameOrigin, Cookie: cookie } })).status, 404);

  const { token } = await mint('read');
  const all = await call('/api/tokens', { method: 'DELETE', headers: { ...sameOrigin, Cookie: cookie } });
  assert.ok((await all.json()).revoked >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL').get().n, 0);
  assert.equal((await call('/api/library/stats', { headers: bearer(token) })).status, 401);
});

test('no token, whatever its scope, reaches /api/auth or /api/tokens', async () => {
  const { token } = await mint('full');
  for (const [method, url] of [
    ['GET', '/api/auth/status'], ['POST', '/api/auth/logout'], ['POST', '/api/auth/password'],
    ['POST', '/api/auth/login'], ['POST', '/api/auth/setup'],
    ['GET', '/api/tokens'], ['POST', '/api/tokens'], ['DELETE', '/api/tokens'], ['DELETE', '/api/tokens/1'],
  ]) {
    const res = await call(url, { method, headers: bearer(token), body: method === 'GET' ? undefined : '{"name":"x"}' });
    assert.equal(res.status, 403, `${method} ${url} answered ${res.status}`);
  }
  // The logout above was refused, so sessions survive; the token was never revoked.
  assert.equal((await call('/api/library/stats', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await call('/api/library/stats', { headers: bearer(token) })).status, 200);
});

test('logout and a password change leave API tokens working', async () => {
  const { token } = await mint('read');
  const out = await call('/api/auth/logout', { method: 'POST', headers: { ...sameOrigin, Cookie: cookie } });
  assert.equal(out.status, 200);
  auth.updatePassword(db, 'another-unused-hash');
  assert.equal((await call('/api/library/stats', { headers: bearer(token) })).status, 200);
  cookie = mintCookie();
});

test('recreating the admin revokes every API token', async () => {
  const { token } = await mint('full');
  db.prepare('DELETE FROM app_auth').run();
  assert.equal((await call('/api/library/stats', { headers: bearer(token) })).status, 401);
  auth.createAdmin(db, 'someone-else', 'unused-hash');
  assert.equal((await call('/api/library/stats', { headers: bearer(token) })).status, 401);
  cookie = mintCookie();
});

test('last_used_at is stamped on use, at most once a minute', async () => {
  const { id, token } = await mint('read');
  const lastUsed = () => db.prepare('SELECT last_used_at AS t FROM api_tokens WHERE id = ?').get(id).t;
  assert.equal(lastUsed(), null);

  await call('/api/library/stats', { headers: bearer(token) });
  const first = lastUsed();
  assert.ok(first > 0);
  db.prepare('UPDATE api_tokens SET last_used_at = last_used_at - 30000 WHERE id = ?').run(id);
  await call('/api/library/stats', { headers: bearer(token) });
  assert.equal(lastUsed(), first - 30000, 'restamped within the minute');

  db.prepare('UPDATE api_tokens SET last_used_at = last_used_at - 60000 WHERE id = ?').run(id);
  await call('/api/library/stats', { headers: bearer(token) });
  assert.ok(lastUsed() >= first, 'not restamped after a minute');
});

// Last: it locks this process's caller out of bearer auth for the window.
test('20 bad bearer attempts lock the caller out, valid token included', async () => {
  const { token } = await mint('read');
  let res;
  for (let i = 0; i < 25; i += 1) {
    res = await call('/api/library/stats', { headers: bearer(`spm_guess${i}`) });
    if (res.status === 429) break;
    assert.equal(res.status, 401);
  }
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  // No oracle: a correct guess now looks the same as a wrong one.
  assert.equal((await call('/api/library/stats', { headers: bearer(token) })).status, 429);
  // Cookie sessions are a separate path and keep working.
  assert.equal((await call('/api/library/stats', { headers: { Cookie: cookie } })).status, 200);
});
