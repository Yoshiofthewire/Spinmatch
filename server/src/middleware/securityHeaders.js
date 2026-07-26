// Baseline response headers. Hand-rolled rather than pulling in helmet, because
// this app serves exactly two things — a self-contained SPA and its own JSON API
// — and needs four headers, not thirteen.
//
// The CSP is the one that earns its keep: album art is read out of files the user
// downloaded from wherever, and a crafted tag can name any Content-Type it likes.
// `default-src 'self'` means that even if something does get served as HTML, it
// can't load or exfiltrate anything.
const CSP = [
  "default-src 'self'",
  // Vite's production build inlines a style block, and the app sets element
  // styles for progress bars and grid sizing.
  "style-src 'self' 'unsafe-inline'",
  // Cover art is served by this origin's own /api/library/cover endpoint, and
  // /api/cover/release-group redirects to the Cover Art Archive.
  "img-src 'self' data: https://coverartarchive.org https://*.coverartarchive.org https://archive.org https://*.archive.org",
  "media-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function securityHeaders(req, res, next) {
  // Without nosniff a browser will sniff a response body as HTML regardless of
  // the declared type, which turns any bytes the user can get served into a
  // potential script host.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // 'same-origin', not 'no-referrer': the CSRF guard's last-resort signal is
  // Referer, and it is the only one a browser still sends on an insecure origin
  // (no Fetch Metadata headers there, and no Origin on a same-origin GET) — see
  // sameOriginOnly. This policy sends a referrer only to this origin and none to
  // any other, so nothing leaves the app that didn't before. Outbound links to
  // YouTube carry rel="noreferrer" in the client and are unaffected either way.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  next();
}
