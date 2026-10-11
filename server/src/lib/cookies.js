// Cookies are attacker-controlled (sibling subdomains can set them); a malformed
// escape must not throw. Returned raw: it can't be our base64url token, so it fails signature checks.
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
