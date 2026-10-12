import { getDb } from '../lib/db.js';
import { adminExists, sessionFromToken } from '../services/auth.js';
import { parseCookies } from '../lib/cookies.js';

export const SESSION_COOKIE = 'spinmatch_session';

// Codes let the client pick setup (SETUP_REQUIRED) vs login (UNAUTHENTICATED).
export function requireAuth(req, res, next) {
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
