import { get, post } from './client.js';

export function getAuthStatus() {
  return get('/auth/status');
}

export function setupAdmin({ username, password }) {
  return post('/auth/setup', { username, password });
}

export function login({ username, password }) {
  return post('/auth/login', { username, password });
}

export function logout() {
  return post('/auth/logout', {});
}

// Changing the password also signs out every other session — see the server's
// token_epoch handling. Requires the current password.
export function changePassword({ currentPassword, newPassword }) {
  return post('/auth/password', { currentPassword, newPassword });
}
