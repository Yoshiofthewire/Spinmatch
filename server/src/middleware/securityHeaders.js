// CSP matters: embedded art from untrusted files can claim any Content-Type.
const CSP = [
  "default-src 'self'",
  // Vite inlines a style block; the app sets inline element styles.
  "style-src 'self' 'unsafe-inline'",
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Not 'no-referrer': sameOriginOnly needs Referer on plain-HTTP installs.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  next();
}
