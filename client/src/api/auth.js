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
