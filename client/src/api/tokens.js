import { get, post, del } from './client.js';

export function listTokens() {
  return get('/tokens');
}

// The response carries the token itself; it is never retrievable again.
export function createToken(name, scope) {
  return post('/tokens', { name, scope });
}

export function revokeToken(id) {
  return del(`/tokens/${id}`);
}

export function revokeAllTokens() {
  return del('/tokens');
}
