import { scrypt as _scrypt, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);
const KEYLEN = 64;
const SALT_BYTES = 16;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const MIN_PASSWORD_LENGTH = 8;

// ---- Password hashing (scrypt, salted, constant-time verify) ----

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(String(password), salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;
  const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---- Session tokens (stateless: base64url(payload).HMAC-SHA256) ----

function sign(secret, data) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueToken(secret, username, now = Date.now(), exp = now + TOKEN_TTL_MS) {
  const body = Buffer.from(JSON.stringify({ u: username, exp })).toString('base64url');
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
  return { username: payload.u };
}

// ---- Persistence (single admin row + a persisted signing secret) ----

export function adminExists(db) {
  return Boolean(db.prepare('SELECT 1 FROM app_auth WHERE id = 1').get());
}

export function getAdmin(db) {
  const row = db.prepare('SELECT username, password_hash FROM app_auth WHERE id = 1').get();
  return row ? { username: row.username, passwordHash: row.password_hash } : null;
}

export function createAdmin(db, username, passwordHash) {
  db.prepare(
    'INSERT INTO app_auth (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)'
  ).run(username, passwordHash, Date.now());
}

// Lazily generates and persists a random HMAC secret on first use so session
// tokens survive restarts (a fresh secret would invalidate everyone's cookie).
export function getSigningSecret(db) {
  const row = db.prepare('SELECT secret FROM auth_secret WHERE id = 1').get();
  if (row) return row.secret;
  const secret = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO auth_secret (id, secret) VALUES (1, ?)').run(secret);
  return secret;
}
