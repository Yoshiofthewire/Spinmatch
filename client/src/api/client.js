// The only module allowed to make network requests in the client. Always
// targets same-origin /api/* — MusicBrainz/YouTube are never called directly.
async function request(path, options) {
  const response = await fetch(`/api${path}`, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Request failed: ${response.status}`);
    error.code = body?.error?.code || 'UNKNOWN';
    error.status = response.status;
    // Whatever else the error object carries beyond message/code — e.g. the m3u
    // export's `existing: { path, bytes, writtenAt }` on a 409 — under the same
    // name lib/eventStream.js puts it, so a caller handling both looks in one
    // place.
    const { message: _m, code: _c, ...details } = body?.error ?? {};
    error.details = details;
    // A 401 means the session lapsed or first-run setup is pending. Broadcast
    // it so the auth gate can re-render setup/login without every caller
    // having to handle it. Guard against SSR/non-browser environments.
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('spinmatch:auth-required', { detail: { code: error.code } }));
    }
    throw error;
  }
  return body;
}

export function get(path) {
  return request(path);
}

export function del(path) {
  return request(path, { method: 'DELETE' });
}

export function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// For partial updates, where the fields the body omits are the ones the server
// must leave alone — see editTrackTags in api/library.js.
export function patch(path, body) {
  return request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
