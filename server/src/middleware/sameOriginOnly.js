import { BadRequestError } from '../lib/httpErrors.js';

// CSRF guard for state-changing routes. The app is cookie-authenticated and
// same-origin only, so we reject anything a browser marks as cross-site.
// `Sec-Fetch-Site` is set by the browser on every request (including
// EventSource, which can't send custom headers); `Origin` is a fallback.
// Requests with neither header (older browsers, curl, our own tests) are
// allowed — this defends against the drive-by <img>/fetch CSRF vector, and is
// layered behind the session check, not a replacement for it.
export function sameOriginOnly(req, res, next) {
  const site = req.get('Sec-Fetch-Site');
  if (site) {
    if (site !== 'same-origin' && site !== 'none') {
      return next(new BadRequestError('Cross-site requests are not allowed for this endpoint'));
    }
    return next();
  }
  const origin = req.get('Origin');
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return next(new BadRequestError('Invalid Origin header'));
    }
    if (originHost !== req.get('Host')) {
      return next(new BadRequestError('Cross-origin requests are not allowed for this endpoint'));
    }
  }
  next();
}
