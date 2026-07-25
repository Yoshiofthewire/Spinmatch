// Login must not reveal which half of the credentials was wrong.
//
// The route carried a comment promising a "single generic error ... so we never
// reveal which half (username vs. password) was wrong", and then short-circuited
// on the username with `&&`. A wrong username returned in microseconds; a
// correct one paid scrypt's deliberate ~100ms. The response body said nothing
// and the clock said everything, at roughly a 1000x separation.
//
// Its own file because the login rate limiter is process-wide and holds ten
// attempts per five minutes — sampling a timing distribution inside the main
// security suite exhausted the bucket and broke every test after it. node:test
// gives each file its own process, so this one gets its own budget.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const { createApp } = await import('../../src/app.js');

const asJson = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

let server;
let baseUrl;

test.before(async () => {
  setDbForTest(openDb(':memory:'));
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const res = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: asJson,
    body: JSON.stringify({ username: 'yoshi', password: 'hunter2hunter2' }),
  });
  assert.equal(res.status, 200, await res.text());
});

test.after(() => {
  setDbForTest(null);
  server.close();
});

async function timeLogin(username, password) {
  const started = process.hrtime.bigint();
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: asJson, body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, status: res.status, text };
}

test('a wrong username costs the same order of time as a wrong password', async () => {
  // Warm up so first-call module init and the lazily-derived dummy hash aren't
  // what gets measured.
  await timeLogin('nobody-at-all', 'warmup-password-here');

  const samples = 3;
  let wrongUser = 0;
  let wrongPass = 0;
  for (let i = 0; i < samples; i += 1) {
    wrongUser += (await timeLogin('definitely-not-the-admin', 'hunter2hunter2')).ms;
    wrongPass += (await timeLogin('yoshi', 'wrong-password-entirely')).ms;
  }
  const userAvg = wrongUser / samples;
  const passAvg = wrongPass / samples;

  // Timing assertions are noisy, so this is a shape check, not a tight bound:
  // before the fix the ratio was ~1000x because the username miss did no key
  // derivation at all. Under 5x means both paths are paying scrypt.
  const ratio = Math.max(userAvg, passAvg) / Math.max(Math.min(userAvg, passAvg), 0.001);
  assert.ok(
    ratio < 5,
    `username-miss averaged ${userAvg.toFixed(1)}ms, password-miss ${passAvg.toFixed(1)}ms (${ratio.toFixed(0)}x)`,
  );
});

test('both kinds of login failure give byte-identical responses', async () => {
  const a = await timeLogin('definitely-not-the-admin', 'hunter2hunter2');
  const b = await timeLogin('yoshi', 'wrong-password-entirely');
  assert.equal(a.status, b.status);
  assert.equal(a.text, b.text);
  assert.match(a.text, /Invalid username or password/);
});
