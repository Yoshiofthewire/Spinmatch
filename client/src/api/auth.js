import { get, post, del } from './client.js';

export function getAuthStatus() {
  return get('/auth/status');
}

export function setupAdmin({ username, password, setupToken }) {
  return post('/auth/setup', { username, password, setupToken });
}

export function login({ username, password }) {
  return post('/auth/login', { username, password });
}

// May return { endSessionUrl } to sign out at the identity provider too.
export function logout() {
  return post('/auth/logout', {});
}

// Returns { url } to navigate to; the IdP sends the browser back to the account page.
export function startSsoLink() {
  return post('/auth/oidc/link', {});
}

export function getSsoLink() {
  return get('/auth/oidc/link');
}

export function unlinkSso() {
  return del('/auth/oidc/link');
}

// Also signs out every other session (server token_epoch).
export function changePassword({ currentPassword, newPassword }) {
  return post('/auth/password', { currentPassword, newPassword });
}
