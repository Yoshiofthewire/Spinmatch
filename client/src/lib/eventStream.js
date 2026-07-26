// Reads a server-sent-events endpoint with `fetch` instead of `EventSource`.
//
// EventSource is the obvious tool and it hides the one thing you need when a
// stream won't start: it reports a failed handshake as a bare `error` event with
// no status, no body, and no way to ask. Every pre-stream failure therefore
// looked identical in the UI — a 400 from the CSRF guard, a 401 from an expired
// session, a 502 from a proxy — which is exactly how an install that answered
// 400 to every stream on a plain-HTTP LAN address stayed a mystery instead of
// reading "This endpoint requires a Sec-Fetch-Site, Origin, or Referer header".
//
// Two other EventSource behaviours are wrong for these streams and go away with
// it: a server-sent event *named* `error` arrives on the same listener as a
// transport error (so the two had to be told apart by whether `.data` existed),
// and a stream cut off mid-run is silently reconnected — restarting a
// multi-minute rate-limited run from the top rather than reporting it.
//
// Resolves when the server closes the stream. Rejects if it never opened, or if
// the connection drops, or on abort.

// One SSE frame -> one handler call. Comment lines (the server's `: keep-alive`
// heartbeat) carry no fields and fall out here.
function dispatch(frame, handlers) {
  let event = 'message';
  const data = [];
  for (const raw of frame.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the framing, not the value.
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  const handler = handlers[event];
  if (!handler) return;
  handler(data.length ? JSON.parse(data.join('\n')) : undefined);
}

// The reason a stream never started, in words a user can act on. The server's
// own JSON error message is preferred over anything invented here; the status is
// kept because "which 400" is the operator's next question.
async function openFailed(res) {
  let message;
  let code;
  try {
    ({ message, code } = (await res.json()).error ?? {});
  } catch {
    // Not JSON: an empty body, or a proxy's own HTML error page.
  }
  if (res.ok) {
    return Object.assign(new Error(
      `The server answered ${res.headers.get('content-type') || 'no content type'} instead of an `
      + 'event stream — something between this page and the app is rewriting the response.'
    ), { status: res.status });
  }
  if (res.status === 401) {
    return Object.assign(new Error(message || 'Your session has expired — sign in again.'),
      { code: code || 'UNAUTHENTICATED', status: 401 });
  }
  return Object.assign(new Error(
    message ? `${message} (HTTP ${res.status})` : `The server answered HTTP ${res.status}.`
  ), { code, status: res.status });
}

export async function streamEvents(url, handlers, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    // A bare "Failed to fetch" (or "NetworkError…", depending on the browser) in
    // a banner tells a user nothing, so say which half of it failed.
    throw Object.assign(
      new Error(`Couldn't reach the server to start the stream (${err.message}).`), { cause: err }
    );
  }
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    throw await openFailed(res);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    let chunk;
    try {
      // eslint-disable-next-line no-await-in-loop -- reading a stream is sequential
      chunk = await reader.read();
    } catch (err) {
      if (signal?.aborted) throw err;
      // Mid-run: the server went away or something between dropped the
      // connection. Whatever the handlers have already been given still stands.
      throw Object.assign(
        new Error(`The connection dropped part-way through the stream (${err.message}).`),
        { cause: err }
      );
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      dispatch(frame, handlers);
    }
  }
}
