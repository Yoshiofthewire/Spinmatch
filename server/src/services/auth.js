import {
  argon2 as _argon2, scrypt as _scrypt, randomBytes, createHash, createHmac, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const argon2 = promisify(_argon2);
const scrypt = promisify(_scrypt);
const SALT_BYTES = 16;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const MIN_PASSWORD_LENGTH = 8;

// ---- Password hashing (Argon2id PHC string; legacy scrypt still verifies) ----

const ARGON2 = { m: 65536, t: 3, p: 4, tagLength: 32 };
// Bounds on stored params, so a tampered row can't turn login into a DoS.
const ARGON2_MAX = { m: 262144, t: 10, p: 16 };
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function argon2id(password, salt, { m, t, p }, tagLength) {
  return argon2('argon2id', {
    message: String(password), nonce: salt, memory: m, passes: t, parallelism: p, tagLength,
  });
}

const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await argon2id(password, salt, ARGON2, ARGON2.tagLength);
  return `$argon2id$v=19$m=${ARGON2.m},t=${ARGON2.t},p=${ARGON2.p}$${b64(salt)}$${b64(hash)}`;
}

function parseArgon2(stored) {
  const match = PHC.exec(stored);
  if (!match) return null;
  const [m, t, p] = match.slice(1, 4).map(Number);
  if (p < 1 || p > ARGON2_MAX.p || t < 1 || t > ARGON2_MAX.t || m < 8 * p || m > ARGON2_MAX.m) return null;
  const salt = Buffer.from(match[4], 'base64');
  const hash = Buffer.from(match[5], 'base64');
  if (salt.length < 8 || hash.length < 4) return null;
  return { m, t, p, salt, hash };
}

async function verifyScrypt(password, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex || '', 'hex');
  if (!saltHex || expected.length === 0) return false;
  const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export async function verifyPassword(password, stored) {
  stored = String(stored || '');
  if (stored.startsWith('scrypt$')) return verifyScrypt(password, stored);
  const parsed = parseArgon2(stored);
  if (!parsed) return false;
  const actual = await argon2id(password, parsed.salt, parsed, parsed.hash.length);
  return timingSafeEqual(actual, parsed.hash);
}

// True for a legacy scheme or params that differ from the current ones.
export function needsRehash(stored) {
  const parsed = parseArgon2(String(stored || ''));
  return !parsed || parsed.m !== ARGON2.m || parsed.t !== ARGON2.t || parsed.p !== ARGON2.p
    || parsed.hash.length !== ARGON2.tagLength || parsed.salt.length !== SALT_BYTES;
}

// Gives "no such user" the same cost as "wrong password". Not secret; computed once.
let dummyHashPromise = null;

export function dummyHash() {
  // Don't memoize a rejection: every failed login would 500, an oracle.
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('hex')).catch((err) => {
    dummyHashPromise = null;
    throw err;
  });
  return dummyHashPromise;
}

// ---- First-run setup token (memory only, printed to the server log) ----

let setupToken = null;

export function issueSetupToken() {
  setupToken = randomBytes(24).toString('base64url');
  return setupToken;
}

export function clearSetupToken() {
  setupToken = null;
}

export function checkSetupToken(candidate) {
  if (!setupToken || typeof candidate !== 'string') return false;
  const sha = (v) => createHash('sha256').update(v).digest();
  return timingSafeEqual(sha(candidate), sha(setupToken));
}

// ---- Username matching ----

// Comparison only; the stored spelling is kept. NFC per RFC 8265; toLowerCase,
// not toLocaleLowerCase, so login doesn't depend on server locale (Turkish 'I').
export function foldUsername(username) {
  return String(username ?? '').trim().normalize('NFC').toLowerCase();
}

// ---- Session tokens (stateless: base64url(payload).HMAC-SHA256) ----

function sign(secret, data) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

// `epoch` (token_epoch) lets sessionFromToken revoke tokens without a session table.
export function issueToken(secret, username, epoch = 0, now = Date.now(), exp = now + TOKEN_TTL_MS) {
  const body = Buffer.from(JSON.stringify({ u: username, e: epoch, exp })).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

export function verifyToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || !token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, body));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
  if (!payload || typeof payload.u !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp < now) return null;
  // Missing `e` = epoch 0, which the v4 migration bumped past.
  return { username: payload.u, epoch: typeof payload.e === 'number' ? payload.e : 0 };
}

// ---- Persistence (single admin row + a persisted signing secret) ----

export function adminExists(db) {
  return Boolean(db.prepare('SELECT 1 FROM app_auth WHERE id = 1').get());
}

export function getAdmin(db) {
  const row = db.prepare(
    'SELECT username, password_hash, token_epoch FROM app_auth WHERE id = 1'
  ).get();
  return row
    ? { username: row.username, passwordHash: row.password_hash, tokenEpoch: row.token_epoch }
    : null;
}

// Returns false if a concurrent first-run request already created the admin.
export function createAdmin(db, username, passwordHash) {
  const { changes } = db.prepare(
    'INSERT INTO app_auth (id, username, password_hash, token_epoch, created_at) '
    + 'VALUES (1, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING'
  ).run(username, passwordHash, Date.now());
  if (!changes) return false;
  // A recreated admin must not accept the previous admin's tokens.
  rotateSigningSecret(db);
  return true;
}

// Also revokes every session by bumping token_epoch.
export function updatePassword(db, passwordHash) {
  db.prepare(
    'UPDATE app_auth SET password_hash = ?, token_epoch = token_epoch + 1 WHERE id = 1'
  ).run(passwordHash);
}

// Upgrades the hash of an unchanged password; sessions stay valid. A no-op if
// the password changed since `oldHash` was read.
export function rehashPassword(db, oldHash, newHash) {
  db.prepare('UPDATE app_auth SET password_hash = ? WHERE id = 1 AND password_hash = ?')
    .run(newHash, oldHash);
}

// Logout: tokens are stateless, so clearing the cookie alone leaves copies valid.
export function revokeSessions(db) {
  db.prepare('UPDATE app_auth SET token_epoch = token_epoch + 1 WHERE id = 1').run();
}

// The single token check: valid HMAC, unexpired, current admin, current epoch.
export function sessionFromToken(db, token) {
  const admin = getAdmin(db);
  if (!admin) return null;
  const payload = verifyToken(getSigningSecret(db), token);
  if (!payload) return null;
  // Exact match, not folded: we minted this from the admin row.
  if (payload.username !== admin.username) return null;
  if (payload.epoch !== admin.tokenEpoch) return null;
  return { username: admin.username };
}

// Persisted so tokens survive restarts; memoized per db.
const secretCache = new WeakMap();

export function getSigningSecret(db) {
  const cached = secretCache.get(db);
  if (cached) return cached;
  // Insert-or-ignore then read: concurrent first requests race here.
  const secret = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO auth_secret (id, secret) VALUES (1, ?) ON CONFLICT(id) DO NOTHING')
    .run(secret);
  const row = db.prepare('SELECT secret FROM auth_secret WHERE id = 1').get();
  secretCache.set(db, row.secret);
  return row.secret;
}

export function rotateSigningSecret(db) {
  const secret = randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO auth_secret (id, secret) VALUES (1, ?) '
    + 'ON CONFLICT(id) DO UPDATE SET secret = excluded.secret'
  ).run(secret);
  secretCache.set(db, secret);
  return secret;
}
