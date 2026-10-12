import { BadRequestError } from '../lib/httpErrors.js';

// CSRF guard. Fails closed: Sec-Fetch-Site, else Origin, else Referer must prove same-origin.
// Referer is needed: plain-HTTP LAN installs get no Sec-Fetch-Site, and same-origin GETs
// (EventSource) send no Origin.
export function sameOriginOnly(req, res, next) {
  const site = req.get('Sec-Fetch-Site');
  if (site) {
    // 'none' = user navigation. 'same-site' rejected: a sibling subdomain isn't us.
    if (site !== 'same-origin' && site !== 'none') {
      return next(new BadRequestError('Cross-site requests are not allowed for this endpoint'));
    }
    return next();
  }

  const origin = req.get('Origin');
  if (origin) return checkHost(req, next, origin, 'Origin');

  const referer = req.get('Referer');
  if (referer) return checkHost(req, next, referer, 'Referer');

  return next(new BadRequestError(
    'This endpoint requires a Sec-Fetch-Site, Origin, or Referer header identifying the caller'
  ));
}

function checkHost(req, next, value, label) {
  let host;
  try {
    host = new URL(value).host;
  } catch {
    return next(new BadRequestError(`Invalid ${label} header`));
  }
  if (host !== req.get('Host')) {
    return next(new BadRequestError('Cross-origin requests are not allowed for this endpoint'));
  }
  next();
}
