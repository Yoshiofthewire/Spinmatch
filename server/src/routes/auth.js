import { Router } from 'express';
import { getDb } from '../lib/db.js';
import {
  hashPassword, verifyPassword, issueToken, verifyToken, getSigningSecret,
  adminExists, getAdmin, createAdmin, MIN_PASSWORD_LENGTH,
} from '../services/auth.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { SESSION_COOKIE, requireAuth } from '../middleware/requireAuth.js';
import { serializeCookie, parseCookies } from '../lib/cookies.js';
import { createAttemptLimiter } from '../lib/attemptLimiter.js';
import { BadRequestError, RateLimitedError } from '../lib/httpErrors.js';

export const authRouter = Router();

const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

// Throttle the unauthenticated credential endpoints per client IP.
const authLimiter = createAttemptLimiter({ max: 10, windowMs: 5 * 60 * 1000 });
function rateLimitAuth(req, res, next) {
  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  const { allowed, retryAfterMs } = authLimiter(key);
  if (!allowed) {
    res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return next(new RateLimitedError('Too many attempts — try again in a few minutes.'));
  }
  next();
}

function isHttps(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https';
}

function setSession(req, res, username) {
  const token = issueToken(getSigningSecret(getDb()), username);
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, {
    maxAge: SESSION_MAX_AGE_S,
    httpOnly: true,
    sameSite: 'Strict',
    secure: isHttps(req),
  }));
}

function clearSession(req, res) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    sameSite: 'Strict',
    secure: isHttps(req),
  }));
}

function sessionFor(db, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return token ? verifyToken(getSigningSecret(db), token) : null;
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
authRouter.post('/setup', sameOriginOnly, rateLimitAuth, async (req, res, next) => {
  try {
    if (adminExists(getDb())) {
      throw new BadRequestError('Admin account is already configured');
    }
    const { username, password } = req.body || {};
    const cleanUsername = validateCredentials(username, password);
    createAdmin(getDb(), cleanUsername, await hashPassword(password));
    setSession(req, res, cleanUsername);
    res.json({ ok: true, username: cleanUsername });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', sameOriginOnly, rateLimitAuth, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const admin = getAdmin(getDb());
    // Single generic error for any failure so we never reveal which half
    // (username vs. password) was wrong.
    const ok = Boolean(admin)
      && String(username ?? '').trim() === admin.username
      && (await verifyPassword(String(password ?? ''), admin.passwordHash));
    if (!ok) throw new BadRequestError('Invalid username or password');
    setSession(req, res, admin.username);
    res.json({ ok: true, username: admin.username });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', sameOriginOnly, requireAuth, (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});
