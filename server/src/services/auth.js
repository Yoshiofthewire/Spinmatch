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

// A real scrypt hash of nothing in particular, used to give the "no such user"
// path the same cost as the "wrong password" path. Computed once and reused:
// it is not a secret (verifying against it always fails), and re-deriving it per
// request would double the CPU cost of a login flood rather than hide anything.
let dummyHashPromise = null;

export function dummyHash() {
  // A rejection must not be what gets memoized. scrypt can fail transiently
  // (it allocates, and this runs under exactly the memory pressure a login flood
  // creates), and caching the rejected promise made every subsequent failed
  // login throw a 500 instead of returning "Invalid username or password" —
  // turning the timing-attack mitigation into a louder behavioural oracle than
  // the timing difference it exists to hide.
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('hex')).catch((err) => {
    dummyHashPromise = null;
    throw err;
  });
  return dummyHashPromise;
}

// ---- Username matching ----

// Usernames are compared folded, so the admin can type theirs however their
// keyboard, phone autocapitalise, or password manager felt like spelling it.
// The stored row keeps the original spelling — that is what the UI shows and
// what the session token carries — and only the comparison folds.
//
// toLowerCase(), not toLocaleLowerCase(): the latter is locale-dependent, and
// under a Turkish locale 'I' lowercases to dotless 'ı'. That would make a login
// succeed or fail based on the server process's locale, which is not a property
// anyone would think to check.
//
// NFC first, because two spellings of an accented name can be different byte
// sequences that render identically, and which one the browser sends depends on
// the OS and keyboard that composed it. Composing them to one canonical form is
// what RFC 8265's UsernameCaseMapped profile does, and for the same reason.
export function foldUsername(username) {
  return String(username ?? '').trim().normalize('NFC').toLowerCase();
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

// `epoch` is the admin's current token_epoch, stamped into the payload so the
// token can be invalidated server-side without a session table — see
// sessionFromToken below.
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
  // A token predating the epoch column has no `e`; treat it as epoch 0, which
  // the v4 migration bumps every existing install past.
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

// Creates the single admin row, or reports that someone else already did.
//
// ON CONFLICT DO NOTHING rather than a bare INSERT: the caller has to hash a
// password first, and that await is a window in which a second concurrent
// first-run request can land. A UNIQUE constraint failure there escaped as a 500
// on the very first request an install ever serves; `false` lets the route say
// "already configured" instead.
//
// @returns {boolean} true if this call created the admin.
export function createAdmin(db, username, passwordHash) {
  const { changes } = db.prepare(
    'INSERT INTO app_auth (id, username, password_hash, token_epoch, created_at) '
    + 'VALUES (1, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING'
  ).run(username, passwordHash, Date.now());
  if (!changes) return false;
  // A brand-new admin must not inherit the previous one's signing secret. The
  // documented recovery path is "delete the app_auth row and set up again", and
  // without this rotation every token issued to the *old* admin would still
  // verify — and, since the payload's username is now checked against the
  // current admin, would simply be rejected rather than silently accepted. The
  // rotation makes that airtight regardless of what the payload claims.
  rotateSigningSecret(db);
  return true;
}

// Changes the password and revokes every outstanding session in one step.
// Bumping token_epoch is what does the revoking: sessionFromToken compares the
// epoch in the cookie against this value on every request.
export function updatePassword(db, passwordHash) {
  db.prepare(
    'UPDATE app_auth SET password_hash = ?, token_epoch = token_epoch + 1 WHERE id = 1'
  ).run(passwordHash);
}

// Invalidates every outstanding token without touching the password. What makes
// logout actually log you out: the token is stateless and self-verifying, so
// clearing the cookie only ever disarmed the browser that asked, and a copy
// taken from anywhere else stayed valid for the rest of its 30 days. Bumping the
// epoch is a single-admin app's whole session table.
export function revokeSessions(db) {
  db.prepare('UPDATE app_auth SET token_epoch = token_epoch + 1 WHERE id = 1').run();
}

// Resolves a cookie value to a session, or null. The single place that decides
// whether a token is currently good: the signature has to verify, it has to be
// unexpired, and — the part a bare HMAC check misses — it has to name the admin
// that exists *right now*, at their current token epoch. Without those last two
// checks a stolen 30-day cookie survives both a password change and the
// delete-the-row-and-start-over recovery procedure.
export function sessionFromToken(db, token) {
  const admin = getAdmin(db);
  if (!admin) return null;
  const payload = verifyToken(getSigningSecret(db), token);
  if (!payload) return null;
  // Exact, deliberately — not foldUsername. Login folds because what arrives
  // there is a human typing their name; this value was minted by issueToken from
  // the admin row itself, so anything other than an exact match means the token
  // is not one we issued for the admin who currently exists. Folding it would
  // widen what a forged or stale payload can claim, and buy nothing.
  if (payload.username !== admin.username) return null;
  if (payload.epoch !== admin.tokenEpoch) return null;
  return { username: admin.username };
}

// Lazily generates and persists a random HMAC secret on first use so session
// tokens survive restarts (a fresh secret would invalidate everyone's cookie).
//
// Memoized per database: this is read on every authenticated request, and it is
// a value that changes only when the admin is recreated.
const secretCache = new WeakMap();

export function getSigningSecret(db) {
  const cached = secretCache.get(db);
  if (cached) return cached;
  // ON CONFLICT rather than SELECT-then-INSERT: two requests racing on a fresh
  // database both saw no row and both inserted id = 1, and the loser got a
  // UNIQUE constraint failure as a 500. The SPA's first paint fires several
  // requests at once, so that race was on the very first page load.
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
