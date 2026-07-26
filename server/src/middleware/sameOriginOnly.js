import { BadRequestError } from '../lib/httpErrors.js';

// CSRF guard for state-changing routes. The app is cookie-authenticated and
// same-origin only, so we reject anything a browser doesn't affirmatively mark
// as same-site. Three signals, in descending order of how much they tell us:
// `Sec-Fetch-Site`, then `Origin`, then `Referer`.
//
// Fails closed. It used to allow a request carrying none of them on the grounds
// that "older browsers, curl, our own tests" send none — which is a control that
// permits the request whenever the evidence is missing, weakened so the test
// suite wouldn't have to set a header. The tests now send the headers a real
// browser would.
//
// Why Referer is here, and it is not belt-and-braces. This used to claim
// Sec-Fetch-Site arrives "on every request (including EventSource)". It does
// not: browsers attach Fetch Metadata headers only to a *potentially
// trustworthy* URL, so on plain HTTP to anything but localhost — which is the
// deployment this project documents, port 3000 on a LAN address — there is no
// Sec-Fetch-Site at all. And no browser sends Origin on a same-origin GET. An
// EventSource therefore arrived carrying neither and was refused, which took out
// every SSE stream in the app (album verify, library gap sweeps) on every
// non-localhost HTTP install, while POSTs kept working because a POST always
// sends Origin. Referer is the one signal left there, a browser won't let a page
// forge it, and a cross-origin request can't produce one that matches this host.
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

  // Origin, then Referer. Named separately in the errors because which one was
  // consulted is the difference between a misconfigured proxy and a cross-site
  // request, and an operator reading a 400 needs to be able to tell.
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
