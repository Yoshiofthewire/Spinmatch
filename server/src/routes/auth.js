import { Router } from 'express';
import { getDb } from '../lib/db.js';
import {
  hashPassword, verifyPassword, dummyHash, issueToken, getSigningSecret, sessionFromToken,
  adminExists, getAdmin, createAdmin, updatePassword, revokeSessions, foldUsername,
  checkSetupToken, clearSetupToken, needsRehash, rehashPassword, MIN_PASSWORD_LENGTH,
} from '../services/auth.js';
import { SESSION_COOKIE, requireAuth } from '../middleware/requireAuth.js';
import { serializeCookie, parseCookies } from '../lib/cookies.js';
import { createAttemptLimiter } from '../lib/attemptLimiter.js';
import { BadRequestError, ForbiddenError, RateLimitedError } from '../lib/httpErrors.js';
import { oidcEnabled, passwordLoginBlocked, endSessionUrl, describe } from '../services/oidc.js';
import { config } from '../config.js';

export const authRouter = Router();

const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

// Per-IP throttle, one bucket per endpoint so password changes can't lock out login.
export function rateLimitBy(limiter) {
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

// req.secure honours X-Forwarded-Proto only under TRUST_PROXY; never read the header directly.
export function setSession(req, res, username, epoch) {
  const token = issueToken(getSigningSecret(getDb()), username, epoch);
  res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, token, {
    maxAge: SESSION_MAX_AGE_S,
    httpOnly: true,
    sameSite: 'Strict',
    secure: req.secure,
  }));
}

function clearSession(req, res) {
  res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
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
    oidc: oidcEnabled() ? { enabled: true, only: config.oidc.only } : { enabled: false },
  });
});

// First-run only: creates the single admin, then logs them in. createAdmin's
// return is the atomic check; adminExists is just a fast path before hashing.
authRouter.post('/setup', rateLimitSetup, async (req, res, next) => {
  try {
    if (adminExists(getDb())) {
      throw new BadRequestError('Admin account is already configured');
    }
    const { username, password, setupToken } = req.body || {};
    // Without this, whoever reaches a fresh install first owns it.
    if (!checkSetupToken(setupToken)) {
      throw new BadRequestError(
        'Invalid setup token. Copy it from the server log (docker logs spinmatch); restart the server to print a new one.',
      );
    }
    const cleanUsername = validateCredentials(username, password);
    const passwordHash = await hashPassword(password);
    if (!createAdmin(getDb(), cleanUsername, passwordHash)) {
      throw new BadRequestError('Admin account is already configured');
    }
    clearSetupToken();
    setSession(req, res, cleanUsername, getAdmin(getDb()).tokenEpoch);
    res.json({ ok: true, username: cleanUsername });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', rateLimitLogin, async (req, res, next) => {
  try {
    if (passwordLoginBlocked(getDb())) {
      throw new ForbiddenError('Password sign-in is turned off (OIDC_ONLY). Use single sign-on.');
    }
    const { username, password } = req.body || {};
    const admin = getAdmin(getDb());
    // Always hash (dummyHash on a miss) so timing doesn't reveal the username.
    const passwordOk = await verifyPassword(
      String(password ?? ''),
      admin ? admin.passwordHash : await dummyHash(),
    );
    // Loose match; the session still carries the stored spelling.
    const usernameOk = Boolean(admin)
      && foldUsername(username) === foldUsername(admin.username);
    // One generic error: never reveal which half was wrong.
    if (!usernameOk || !passwordOk) throw new BadRequestError('Invalid username or password');
    if (needsRehash(admin.passwordHash)) {
      rehashPassword(getDb(), admin.passwordHash, await hashPassword(password));
    }
    setSession(req, res, admin.username, admin.tokenEpoch);
    res.json({ ok: true, username: admin.username });
  } catch (err) {
    next(err);
  }
});

// Revokes all other sessions (token_epoch bump) and reissues this one. Requires the
// current password so a hijacked session can't lock the owner out.
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

// Tokens are stateless, so logout must revoke server-side; this signs out every device.
// With a linked IdP that advertises it, the client then ends the IdP session too.
authRouter.post('/logout', requireAuth, (req, res) => {
  const db = getDb();
  revokeSessions(db);
  clearSession(req, res);
  endSessionUrl(db)
    .catch((err) => console.warn(`OIDC end-session URL unavailable: ${describe(err)}`))
    .then((url) => res.json(url ? { ok: true, endSessionUrl: url } : { ok: true }));
});
