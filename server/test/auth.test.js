import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const {
  hashPassword, verifyPassword, issueToken, verifyToken,
  adminExists, getAdmin, createAdmin, getSigningSecret, foldUsername, needsRehash, rehashPassword,
} = await import('../src/services/auth.js');
const { randomBytes, scryptSync } = await import('node:crypto');
const { openDb } = await import('../src/lib/db.js');

test('hashPassword produces an Argon2id PHC string that verifyPassword accepts', async () => {
  const stored = await hashPassword('correct horse');
  assert.match(stored, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('wrong horse', stored), false);
  assert.equal(needsRehash(stored), false);
});

// Produced by the reference argon2 CLI:
// echo -n hunter2hunter2 | argon2 somesalt12345678 -id -t 3 -m 16 -p 4 -l 32 -e
test('verifyPassword accepts a hash from the reference argon2 implementation', async () => {
  const ref = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQxMjM0NTY3OA$ljyb/0fZNhbZRTpdL2gdmwVBxxwKOprEPhZ8yrUtqnY';
  assert.equal(await verifyPassword('hunter2hunter2', ref), true);
  assert.equal(await verifyPassword('hunter2hunter3', ref), false);
});

test('verifyPassword still accepts a legacy scrypt hash, which needs a rehash', async () => {
  const salt = randomBytes(16);
  const legacy = `scrypt$${salt.toString('hex')}$${scryptSync('old pw', salt, 64).toString('hex')}`;
  assert.equal(await verifyPassword('old pw', legacy), true);
  assert.equal(await verifyPassword('wrong', legacy), false);
  assert.equal(needsRehash(legacy), true);
});

test('verifyPassword refuses out-of-bounds Argon2 params without running them', async () => {
  const tail = '$c29tZXNhbHQxMjM0NTY3OA$ljyb/0fZNhbZRTpdL2gdmwVBxxwKOprEPhZ8yrUtqnY';
  for (const params of ['m=262145,t=3,p=4', 'm=65536,t=11,p=4', 'm=65536,t=3,p=17', 'm=65536,t=0,p=4']) {
    const started = Date.now();
    assert.equal(await verifyPassword('hunter2hunter2', `$argon2id$v=19$${params}${tail}`), false, params);
    assert.ok(Date.now() - started < 20, `${params} was refused before hashing`);
  }
  assert.equal(await verifyPassword('x', '$argon2i$v=19$m=65536,t=3,p=4' + tail), false);
});

test('needsRehash flags weaker current-scheme params', () => {
  assert.equal(needsRehash('$argon2id$v=19$m=65536,t=2,p=4$c29tZXNhbHQxMjM0NTY3OA$ljyb/0fZNhbZRTpdL2gdmwVBxxwKOprEPhZ8yrUtqnY'), true);
});

test('rehashPassword replaces the hash without revoking sessions', async () => {
  const db = openDb(':memory:');
  createAdmin(db, 'yoshi', 'scrypt$aa$bb');
  const before = getAdmin(db).tokenEpoch;
  rehashPassword(db, 'stale', 'ignored');
  assert.equal(getAdmin(db).passwordHash, 'scrypt$aa$bb', 'a stale old hash changes nothing');
  rehashPassword(db, 'scrypt$aa$bb', 'new');
  assert.equal(getAdmin(db).passwordHash, 'new');
  assert.equal(getAdmin(db).tokenEpoch, before);
  db.close();
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

test('foldUsername folds case so the admin can type their name however they like', () => {
  assert.equal(foldUsername('Yoshi'), foldUsername('yoshi'));
  assert.equal(foldUsername('YOSHI'), foldUsername('yoshi'));
  assert.equal(foldUsername('yOsHi'), foldUsername('yoshi'));
  assert.notEqual(foldUsername('yoshi'), foldUsername('yoshb'));
});

test('foldUsername trims, so a trailing space pasted from a password manager still matches', () => {
  assert.equal(foldUsername('  Yoshi  '), foldUsername('yoshi'));
});

// Two byte sequences that render identically: NFC composes the second into the
// first. Without normalizing, an admin whose name carries an accent could be
// locked out by which keyboard/OS composed it.
test('foldUsername normalizes so composed and decomposed accents match', () => {
  const composed = 'Ren\u00e9';    // é as one code point
  const decomposed = 'Rene\u0301'; // e + combining acute
  assert.notEqual(composed, decomposed, 'the two spellings must actually differ');
  assert.equal(foldUsername(composed), foldUsername(decomposed));
});

// toLocaleLowerCase() is locale-dependent: under a Turkish locale 'I' lowercases
// to dotless 'ı', so an admin registered as "IVAN" could not log into a server
// whose locale happened to differ from the one they signed up on. The fold has
// to be locale-independent.
test('foldUsername is not locale-dependent', () => {
  assert.equal(foldUsername('I'), 'i');
  assert.equal(foldUsername('IVAN'), foldUsername('ivan'));
});

test('foldUsername handles absent input without throwing', () => {
  assert.equal(foldUsername(undefined), '');
  assert.equal(foldUsername(null), '');
});
