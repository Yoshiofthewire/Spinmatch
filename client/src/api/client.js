// The only module allowed to make network requests in the client. Always
// targets same-origin /api/* — MusicBrainz/YouTube are never called directly.
async function request(path, options) {
  const response = await fetch(`/api${path}`, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Request failed: ${response.status}`);
    error.code = body?.error?.code || 'UNKNOWN';
    error.status = response.status;
    throw error;
  }
  return body;
}

export function get(path) {
  return request(path);
}

export function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
