import { Router } from 'express';
import { getDb } from '../lib/db.js';
import {
  hashPassword, verifyPassword, dummyHash, issueToken, getSigningSecret, sessionFromToken,
  adminExists, getAdmin, createAdmin, updatePassword, revokeSessions, foldUsername,
  MIN_PASSWORD_LENGTH,
} from '../services/auth.js';
import { SESSION_COOKIE, requireAuth } from '../middleware/requireAuth.js';
import { serializeCookie, parseCookies } from '../lib/cookies.js';
import { createAttemptLimiter } from '../lib/attemptLimiter.js';
import { BadRequestError, RateLimitedError } from '../lib/httpErrors.js';

export const authRouter = Router();

const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

// Throttle the credential endpoints per client IP.
//
// One limiter per endpoint, not one shared between them: they were on the same
// bucket, so changing your password a few times spent the allowance for logging
// in and locked you out of your own account for five minutes. They also guard
// different things — /login is unauthenticated guessing, /password is an
// already-authenticated session confirming the current password — and have no
// reason to share a budget.
function rateLimitBy(limiter) {
  return function rateLimit(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const { allowed, retryAfterMs } = limiter(key);
    if (!allowed) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return next(new RateLimitedError('Too many attempts — try again in a few minutes.'));
    }
    next();
  };
}

const rateLimitLogin = rateLimitBy(createAttemptLimiter({ max: 10, windowMs: 5 * 60 * 1000 }));
const rateLimitSetup = rateLimitBy(createAttemptLimiter({ max: 10, windowMs: 5 * 60 * 1000 }));
const rateLimitPassword = rateLimitBy(createAttemptLimiter({ max: 10, windowMs: 5 * 60 * 1000 }));

// req.secure already accounts for X-Forwarded-Proto, but only when the app has
// been told to trust the proxy (TRUST_PROXY — see app.js). Reading the header
// directly instead let anyone set Secure on the cookie by sending
// `X-Forwarded-Proto: https` to a plain-HTTP deployment, at which point the
// browser stopped sending the cookie back and login became impossible.
function setSession(req, res, username, epoch) {
  const token = issueToken(getSigningSecret(getDb()), username, epoch);
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, {
    maxAge: SESSION_MAX_AGE_S,
    httpOnly: true,
    sameSite: 'Strict',
    secure: req.secure,
  }));
}

function clearSession(req, res) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    sameSite: 'Strict',
    secure: req.secure,
  }));
}

function sessionFor(db, req) {
  return sessionFromToken(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

function validateCredentials(username, password) {
  const u = String(username ?? '').trim();
  if (u.length < 1 || u.length > 64) {
    throw new BadRequestError('Username must be 1-64 characters');
  }
  if (String(password ?? '').length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return u;
}

// Public: lets the client decide whether to render setup, login, or the app.
authRouter.get('/status', (req, res) => {
  const db = getDb();
  if (!adminExists(db)) return res.json({ setupRequired: true, authenticated: false });
  const session = sessionFor(db, req);
  res.json({
    setupRequired: false,
    authenticated: Boolean(session),
    username: session ? session.username : undefined,
  });
});

// First-run only: creates the single admin, then logs them in.
//
// The existence check and the insert have to be one atomic step. Hashing the
// password is ~100ms of deliberate CPU, and awaiting it between a
// SELECT-then-INSERT let two concurrent first-run requests both pass the check;
// the loser then hit a UNIQUE constraint on app_auth.id and surfaced as a 500
// rather than "already configured". So the hash happens first and createAdmin
// reports whether it actually won the insert — the same fix, for the same
// reason, as the ON CONFLICT in getSigningSecret.
authRouter.post('/setup', rateLimitSetup, async (req, res, next) => {
  try {
    if (adminExists(getDb())) {
      throw new BadRequestError('Admin account is already configured');
    }
    const { username, password } = req.body || {};
    const cleanUsername = validateCredentials(username, password);
    const passwordHash = await hashPassword(password);
    if (!createAdmin(getDb(), cleanUsername, passwordHash)) {
      throw new BadRequestError('Admin account is already configured');
    }
    setSession(req, res, cleanUsername, getAdmin(getDb()).tokenEpoch);
    res.json({ ok: true, username: cleanUsername });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', rateLimitLogin, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const admin = getAdmin(getDb());
    // Verify a password on every attempt, even when there is no admin or the
    // username is wrong. Short-circuiting on the username meant a wrong name
    // returned in microseconds while a right one paid scrypt's ~100ms, which is
    // a username oracle with a 1000x separation — the response body says nothing
    // but the clock says everything. dummyHash() gives the miss path the same
    // cost as the hit path.
    const passwordOk = await verifyPassword(
      String(password ?? ''),
      admin ? admin.passwordHash : await dummyHash(),
    );
    // Folded on both sides — see foldUsername. The admin's own stored spelling
    // is what gets stamped into the session below, so matching loosely here
    // never changes what the token or the UI says their name is.
    const usernameOk = Boolean(admin)
      && foldUsername(username) === foldUsername(admin.username);
    // Single generic error for any failure so we never reveal which half
    // (username vs. password) was wrong.
    if (!usernameOk || !passwordOk) throw new BadRequestError('Invalid username or password');
    setSession(req, res, admin.username, admin.tokenEpoch);
    res.json({ ok: true, username: admin.username });
  } catch (err) {
    next(err);
  }
});

// Changes the password and invalidates every other session at the same time
// (updatePassword bumps token_epoch). The caller gets a fresh cookie so the tab
// they're in stays logged in; every other cookie in existence stops working.
// Requires the current password, so a hijacked session can't lock the owner out.
authRouter.post('/password', requireAuth, rateLimitPassword, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const db = getDb();
    const admin = getAdmin(db);
    if (!(await verifyPassword(String(currentPassword ?? ''), admin.passwordHash))) {
      throw new BadRequestError('Current password is incorrect');
    }
    if (String(newPassword ?? '').length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    updatePassword(db, await hashPassword(newPassword));
    setSession(req, res, admin.username, getAdmin(db).tokenEpoch);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Clears this browser's cookie *and* revokes the token server-side.
//
// Clearing the cookie alone was not a logout: the token is stateless and
// self-verifying, so a copy taken from anywhere else — a shared machine, a
// backup, a proxy log — kept working for the rest of its 30 days no matter how
// many times the owner pressed the button. Bumping token_epoch is what makes the
// button mean something.
//
// This being a single-admin app, that necessarily signs out every device rather
// than just this one, which is the safe direction for the trade to fall: someone
// pressing Logout wants the session gone, not gone-here-but-fine-over-there.
authRouter.post('/logout', requireAuth, (req, res) => {
  revokeSessions(getDb());
  clearSession(req, res);
  res.json({ ok: true });
});
