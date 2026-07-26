// Minimal cookie parse/serialize so we don't pull in cookie-parser for the one
// session cookie this app sets. Only handles what we actually use.

// decodeURIComponent throws URIError on a malformed escape ('%', '%zz'), and a
// cookie value is attacker-controlled: any page on a sibling subdomain can set
// one scoped to the parent domain. Unguarded, that URIError propagated out of
// requireAuth — which runs on every protected route — and out of /api/auth/status,
// which is how the client decides whether to show login. One junk cookie turned
// the whole app into a 500 wall with no in-app way back.
//
// A value that isn't valid percent-encoding is returned raw rather than dropped:
// it can't be our own token (which is base64url and never needs escaping), so it
// fails the signature check a moment later, which is the correct outcome.
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = safeDecode(part.slice(eq + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly, sameSite, secure, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (maxAge != null) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (httpOnly) parts.push('HttpOnly');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
