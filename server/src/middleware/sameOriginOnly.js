import { BadRequestError } from '../lib/httpErrors.js';

// CSRF guard for state-changing routes. The app is cookie-authenticated and
// same-origin only, so we reject anything a browser doesn't affirmatively mark
// as same-site. `Sec-Fetch-Site` is set by the browser on every request
// (including EventSource, which can't send custom headers); `Origin` is the
// fallback for the handful of clients that don't send it.
//
// Fails closed. It used to allow a request carrying neither header on the
// grounds that "older browsers, curl, our own tests" send neither — which is a
// control that permits the request whenever the evidence is missing, weakened so
// the test suite wouldn't have to set a header. Every browser released in the
// last five years sends Sec-Fetch-Site, so the only thing that leniency bought
// was a guard that an attacker could disarm by omitting a field. The tests now
// send the header a real browser would.
export function sameOriginOnly(req, res, next) {
  const site = req.get('Sec-Fetch-Site');
  if (site) {
    // 'none' is a user-initiated navigation (typed URL, bookmark); 'same-origin'
    // is our own page. Both are ours. 'same-site' is deliberately not accepted:
    // a sibling subdomain is not this app.
    if (site !== 'same-origin' && site !== 'none') {
      return next(new BadRequestError('Cross-site requests are not allowed for this endpoint'));
    }
    return next();
  }

  const origin = req.get('Origin');
  if (!origin) {
    return next(new BadRequestError(
      'This endpoint requires a Sec-Fetch-Site or Origin header identifying the caller'
    ));
  }

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return next(new BadRequestError('Invalid Origin header'));
  }
  if (originHost !== req.get('Host')) {
    return next(new BadRequestError('Cross-origin requests are not allowed for this endpoint'));
  }
  next();
}
