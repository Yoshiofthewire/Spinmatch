// The client's only network module: same-origin /api/* only, never upstreams directly.
async function request(path, options) {
  const response = await fetch(`/api${path}`, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Request failed: ${response.status}`);
    error.code = body?.error?.code || 'UNKNOWN';
    error.status = response.status;
    // Extra error fields (e.g. a 409's `existing`), named as in lib/eventStream.js.
    const { message: _m, code: _c, ...details } = body?.error ?? {};
    error.details = details;
    // 401: session lapsed or setup pending. Broadcast so the auth gate re-renders.
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

// Partial updates: omitted fields are left alone server-side.
export function patch(path, body) {
  return request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
