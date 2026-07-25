import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const {
  hashPassword, verifyPassword, issueToken, verifyToken,
  adminExists, getAdmin, createAdmin, getSigningSecret,
} = await import('../src/services/auth.js');
const { openDb } = await import('../src/lib/db.js');

test('hashPassword produces a scrypt string that verifyPassword accepts', async () => {
  const stored = await hashPassword('correct horse');
  assert.match(stored, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('wrong horse', stored), false);
});

test('hashPassword salts: same password hashes differently each time', async () => {
  const a = await hashPassword('same');
  const b = await hashPassword('same');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same', a), true);
  assert.equal(await verifyPassword('same', b), true);
});

test('verifyPassword rejects malformed stored values without throwing', async () => {
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', 'scrypt$deadbeef'), false);
});

test('issueToken/verifyToken round-trips and binds to the secret', () => {
  const secret = 'a'.repeat(64);
  const token = issueToken(secret, 'admin');
  assert.equal(verifyToken(secret, token)?.username, 'admin');
  assert.equal(verifyToken('different-secret', token), null);
});

test('verifyToken rejects tampered payloads', () => {
  const secret = 'a'.repeat(64);
  const token = issueToken(secret, 'admin');
  const [body, sig] = token.split('.');
  const forged = `${Buffer.from(JSON.stringify({ u: 'root', exp: Date.now() + 1e9 })).toString('base64url')}.${sig}`;
  assert.equal(verifyToken(secret, forged), null);
  assert.equal(verifyToken(secret, `${body}.deadbeef`), null);
  assert.equal(verifyToken(secret, ''), null);
  assert.equal(verifyToken(secret, undefined), null);
});

test('verifyToken rejects expired tokens', () => {
  const secret = 'a'.repeat(64);
  const past = Date.now() - 1000;
  const token = issueToken(secret, 'admin', 0, past - 60_000, past - 30_000);
  assert.equal(verifyToken(secret, token), null);
});

test('createAdmin/getAdmin/adminExists operate on a single admin row', async () => {
  const db = openDb(':memory:');
  assert.equal(adminExists(db), false);
  assert.equal(getAdmin(db), null);

  const hash = await hashPassword('pw12345678');
  assert.equal(createAdmin(db, 'yoshi', hash), true);
  assert.equal(adminExists(db), true);
  assert.equal(getAdmin(db).username, 'yoshi');

  // A second admin is refused (single-row table). Reported rather than thrown,
  // because the caller has to await a password hash before getting here and a
  // racing first-run request must produce "already configured", not a 500.
  assert.equal(createAdmin(db, 'other', hash), false);
  assert.equal(getAdmin(db).username, 'yoshi', 'the losing insert changed nothing');
  db.close();
});

test('getSigningSecret is stable across calls and non-empty', () => {
  const db = openDb(':memory:');
  const s1 = getSigningSecret(db);
  const s2 = getSigningSecret(db);
  assert.ok(s1 && s1.length >= 32);
  assert.equal(s1, s2);
  db.close();
});
