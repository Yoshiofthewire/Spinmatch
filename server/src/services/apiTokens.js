import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'spm_';
const TOUCH_INTERVAL_MS = 60 * 1000;
const META = 'id, name, scope, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt';

// Plain SHA-256 is right here: a 256-bit random token can't be guessed offline, unlike a password.
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

// The only time the token itself exists outside the caller's hands.
export function createToken(db, { name, scope }) {
  const token = PREFIX + randomBytes(32).toString('base64url');
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO api_tokens (name, hash, scope, created_at) VALUES (?, ?, ?, ?)'
  ).run(name, hashToken(token), scope, Date.now());
  return { token, ...db.prepare(`SELECT ${META} FROM api_tokens WHERE id = ?`).get(lastInsertRowid) };
}

export function listTokens(db) {
  return db.prepare(`SELECT ${META} FROM api_tokens ORDER BY id DESC`).all();
}

// Idempotent: keeps the first revocation time. False only when no such token exists.
export function revokeToken(db, id) {
  return db.prepare('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
    .run(Date.now(), id).changes > 0;
}

export function revokeAllTokens(db) {
  return Number(db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE revoked_at IS NULL')
    .run(Date.now()).changes);
}

// The live token behind a presented value, or null. Stamps last_used_at at most once a minute.
export function tokenFromBearer(db, value) {
  if (!value.startsWith(PREFIX)) return null;
  const row = db.prepare('SELECT id, scope FROM api_tokens WHERE hash = ? AND revoked_at IS NULL')
    .get(hashToken(value));
  if (!row) return null;
  const now = Date.now();
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)')
    .run(now, row.id, now - TOUCH_INTERVAL_MS);
  return row;
}
