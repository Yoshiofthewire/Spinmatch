import { get, post } from './client.js';

export function getAuthStatus() {
  return get('/auth/status');
}

export function setupAdmin({ username, password, setupToken }) {
  return post('/auth/setup', { username, password, setupToken });
}

export function login({ username, password }) {
  return post('/auth/login', { username, password });
}

export function logout() {
  return post('/auth/logout', {});
}

// Also signs out every other session (server token_epoch).
export function changePassword({ currentPassword, newPassword }) {
  return post('/auth/password', { currentPassword, newPassword });
}
