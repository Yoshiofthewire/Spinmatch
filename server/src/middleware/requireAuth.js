import { getDb } from '../lib/db.js';
import { adminExists, sessionFromToken } from '../services/auth.js';
import { parseCookies } from '../lib/cookies.js';
import { ForbiddenError } from '../lib/httpErrors.js';

export const SESSION_COOKIE = 'spinmatch_session';

export const READ_ONLY_MESSAGE = 'This token is read-only';

// Codes let the client pick setup (SETUP_REQUIRED) vs login (UNAUTHENTICATED).
// An API token (bearerAuth already verified it) passes on its scope instead.
export function requireAuth(req, res, next) {
  if (req.auth?.kind === 'token') {
    const safe = req.method === 'GET' || req.method === 'HEAD';
    return safe || req.auth.scope === 'full' ? next() : next(new ForbiddenError(READ_ONLY_MESSAGE));
  }
  const db = getDb();
  if (!adminExists(db)) {
    return res.status(401).json({ error: { code: 'SETUP_REQUIRED', message: 'Initial setup required' } });
  }
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = sessionFromToken(db, token);
  if (!session) {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
  }
  req.user = { username: session.username };
  next();
}

// Credentials and anything as sensitive: no API token reaches these, whatever its scope.
export function sessionOnly(req, res, next) {
  if (req.auth?.kind === 'token') {
    return next(new ForbiddenError('API tokens cannot be used here; sign in instead'));
  }
  next();
}
