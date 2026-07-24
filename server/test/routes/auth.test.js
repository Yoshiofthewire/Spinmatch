import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const { createApp } = await import('../../src/app.js');

let server;
let baseUrl;

test.before(async () => {
  setDbForTest(openDb(':memory:'));
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => server.close());

function sessionCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0]; // "spinmatch_session=..."
}

let cookie; // captured across the ordered tests below

test('status reports setupRequired before any admin exists', async () => {
  const res = await fetch(`${baseUrl}/api/auth/status`);
  const body = await res.json();
  assert.deepEqual(body, { setupRequired: true, authenticated: false });
});

test('protected routes return 401 SETUP_REQUIRED before setup', async () => {
  const res = await fetch(`${baseUrl}/api/search?q=hello`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'SETUP_REQUIRED');
});

test('setup rejects a too-short password', async () => {
  const res = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'yoshi', password: 'short' }),
  });
  assert.equal(res.status, 400);
});

test('setup creates the admin and issues a session cookie', async () => {
  const res = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'yoshi', password: 'hunter2hunter2' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).username, 'yoshi');
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /spinmatch_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = sessionCookie(res);
});

test('status reports authenticated when the cookie is presented', async () => {
  const res = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } });
  const body = await res.json();
  assert.equal(body.setupRequired, false);
  assert.equal(body.authenticated, true);
  assert.equal(body.username, 'yoshi');
});

test('setup is refused once an admin exists', async () => {
  const res = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other', password: 'hunter2hunter2' }),
  });
  assert.equal(res.status, 400);
});

test('protected route is 401 UNAUTHENTICATED without a cookie, passes with one', async () => {
  const noCookie = await fetch(`${baseUrl}/api/ingest/scan`);
  assert.equal(noCookie.status, 401);
  assert.equal((await noCookie.json()).error.code, 'UNAUTHENTICATED');

  // With a valid session the gate passes; the ingest feature itself is
  // unconfigured here, so we get its own 404 (NOT_FOUND), never a 401.
  const withCookie = await fetch(`${baseUrl}/api/ingest/scan`, { headers: { Cookie: cookie } });
  assert.notEqual(withCookie.status, 401);
  assert.equal((await withCookie.json()).error.code, 'NOT_FOUND');
});

test('login rejects a wrong password with a generic error', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'yoshi', password: 'nope' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Invalid username or password/);
});

test('login succeeds with correct credentials and sets a fresh cookie', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'yoshi', password: 'hunter2hunter2' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /spinmatch_session=/);
});

test('logout clears the session cookie', async () => {
  const res = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /spinmatch_session=;?.*Max-Age=0/);
});
