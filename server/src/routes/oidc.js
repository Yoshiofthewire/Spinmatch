import express, { Router } from 'express';
import { getDb } from '../lib/db.js';
import { getAdmin } from '../services/auth.js';
import {
  oidcEnabled, startFlow, takePending, finishFlow, isLinked, getLink, setLink, SsoError, describe,
  verifyLogoutToken, applyLogout, logoutMatchesLink, PENDING_TTL_MS, adminBinding, recordSid,
} from '../services/oidc.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { serializeCookie, parseCookies } from '../lib/cookies.js';
import { createAttemptLimiter } from '../lib/attemptLimiter.js';
import { NotFoundError, UpstreamUnavailableError } from '../lib/httpErrors.js';
import { config } from '../config.js';
import { setSession, rateLimitBy } from './auth.js';

export const oidcRouter = Router();

export const BACKCHANNEL_PATH = '/api/auth/oidc/backchannel-logout';
const PENDING_COOKIE = 'spinmatch_oidc';
// Bounds pending rows per IP; generous, since a refused start strands the user.
const rateLimitStart = rateLimitBy(createAttemptLimiter({ max: 60, windowMs: 5 * 60 * 1000 }));

oidcRouter.use((req, res, next) => (oidcEnabled() ? next() : next(new NotFoundError('Single sign-on is not configured'))));

// Lax, not Strict: it must ride the IdP's cross-site redirect back to the callback.
function pendingCookie(req, res, value, maxAgeMs) {
  res.append('Set-Cookie', serializeCookie(PENDING_COOKIE, value, {
    maxAge: maxAgeMs / 1000, httpOnly: true, sameSite: 'Lax', secure: req.secure, path: '/api/auth/oidc',
  }));
}

function ssoFailed(res, where, err) {
  const code = err instanceof SsoError ? err.code : 'failed';
  console.warn(`OIDC ${where} failed (${code}): ${describe(err)}`);
  res.redirect(`${where === 'link' ? '/account' : '/'}?sso_error=${code}`);
}

// A top-level navigation from the login page.
oidcRouter.get('/start', rateLimitStart, async (req, res) => {
  try {
    const { pendingId, url } = await startFlow(getDb(), 'login');
    pendingCookie(req, res, pendingId, PENDING_TTL_MS);
    res.redirect(url);
  } catch (err) {
    ssoFailed(res, 'login', err);
  }
});

// The callback carries no session (SameSite=Strict), so linking is authorised here.
oidcRouter.post('/link', requireAuth, async (req, res, next) => {
  try {
    const { pendingId, url } = await startFlow(getDb(), 'link');
    pendingCookie(req, res, pendingId, PENDING_TTL_MS);
    res.json({ url });
  } catch (err) {
    console.warn(`OIDC link start failed: ${describe(err)}`);
    next(new UpstreamUnavailableError('Could not reach the identity provider'));
  }
});

oidcRouter.get('/link', requireAuth, (req, res) => {
  res.json({ link: getLink(getDb()), only: config.oidc.only });
});

oidcRouter.delete('/link', requireAuth, (req, res) => {
  setLink(getDb(), null);
  res.json({ ok: true });
});

// A cross-site GET from the IdP; its only state change is through the single-use row.
oidcRouter.get('/callback', async (req, res) => {
  pendingCookie(req, res, '', 0);
  const db = getDb();
  const pending = takePending(db, parseCookies(req.headers.cookie)[PENDING_COOKIE]);
  if (!pending) return ssoFailed(res, 'login', new SsoError('expired', 'no live pending login'));
  try {
    const search = new URL(req.originalUrl, 'http://unused').search;
    const identity = await finishFlow(pending, search);
    if (pending.purpose === 'link') {
      // The session that started this link may have been revoked since (logout, password).
      if (!pending.bound_to || pending.bound_to !== adminBinding(db)) {
        throw new SsoError('expired', 'the session that started this link was revoked');
      }
      setLink(db, identity);
      return res.redirect('/account?sso_linked=1');
    }
    if (!isLinked(db, identity)) throw new SsoError('unlinked', 'identity is not the linked one');
    const admin = getAdmin(db);
    recordSid(db, identity.sid);
    setSession(req, res, admin.username, admin.tokenEpoch);
    res.redirect('/');
  } catch (err) {
    ssoFailed(res, pending.purpose, err);
  }
});

// The IdP posts this server to server; the token's signature is the only credential.
oidcRouter.post(
  '/backchannel-logout',
  express.urlencoded({ extended: false, limit: '16kb' }),
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const reject = (reason) => {
      console.warn(`OIDC back-channel logout rejected: ${reason}`);
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid logout token' } });
    };
    const token = req.body?.logout_token;
    if (typeof token !== 'string' || !token) return reject('one logout_token required');
    try {
      const claims = await verifyLogoutToken(token);
      const db = getDb();
      if (!logoutMatchesLink(db, claims)) return reject('not the linked identity');
      if (!applyLogout(db, claims)) return reject(`replayed jti ${claims.jti}`);
      res.json({ ok: true });
    } catch (err) {
      reject(describe(err));
    }
  },
);
