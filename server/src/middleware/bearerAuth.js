import { getDb } from '../lib/db.js';
import { getAdmin } from '../services/auth.js';
import { tokenFromBearer } from '../services/apiTokens.js';
import { createAttemptLimiter } from '../lib/attemptLimiter.js';
import { RateLimitedError } from '../lib/httpErrors.js';

const failures = createAttemptLimiter({ max: 20, windowMs: 5 * 60 * 1000 });

// A Bearer header decides the request: a bad token is a 401, never a fall back to the
// cookie, and a good one wins over any cookie sent beside it. Other schemes (a proxy's
// Basic auth) are ignored.
export function bearerAuth(req, res, next) {
  const header = req.get('Authorization');
  if (!header || !/^bearer\b/i.test(header)) return next();

  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const blockedMs = failures.blockedFor(ip);
  if (blockedMs) {
    res.setHeader('Retry-After', String(Math.ceil(blockedMs / 1000)));
    return next(new RateLimitedError('Too many bad API tokens — try again in a few minutes.'));
  }

  const db = getDb();
  const admin = getAdmin(db);
  const token = admin && tokenFromBearer(db, header.slice(6).trim());
  if (!token) {
    failures(ip);
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or revoked API token' } });
  }
  // CSRF-exempt (see sameOriginOnly): a browser never attaches this header on its own.
  req.auth = { kind: 'token', tokenId: token.id, scope: token.scope };
  req.user = { username: admin.username };
  next();
}
