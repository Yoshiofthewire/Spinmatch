// Fixed text per ?sso_error= code; the query string itself is never rendered.
const MESSAGES = {
  unlinked: "This identity isn't linked to Spinmatch. Sign in with your password and link it from the Account page.",
  expired: 'That sign-in expired or was already used. Try again.',
  denied: 'Sign-in was cancelled at the identity provider.',
  failed: 'Single sign-on failed. Try again; the server log has the details.',
};

export function ssoErrorMessage(search) {
  const code = new URLSearchParams(search).get('sso_error');
  if (code === null) return null;
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : MESSAGES.failed;
}
