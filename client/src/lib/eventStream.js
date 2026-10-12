// Reads SSE with `fetch`, not `EventSource`: EventSource hides a failed handshake's
// status and body, conflates a server event named `error` with transport errors,
// and silently reconnects, restarting long rate-limited runs.
// Resolves on server close; rejects if never opened, on drop, or on abort.

// One SSE frame -> one handler call. `: keep-alive` comment lines fall out.
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

// Why a stream never started; prefers the server's message, keeps the status.
async function openFailed(res) {
  let message;
  let code;
  // Extra error fields (e.g. a 409's `existing`); the body is consumed here.
  let details;
  try {
    ({ message, code, ...details } = (await res.json()).error ?? {});
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
  ), { code, status: res.status, details });
}

// `body`, when given, is sent as a JSON POST; otherwise the stream is a GET.
export async function streamEvents(url, handlers, { signal, body } = {}) {
  let res;
  try {
    res = await fetch(url, body === undefined
      ? { headers: { Accept: 'text/event-stream' }, signal }
      : {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
  } catch (err) {
    if (signal?.aborted) throw err;
    // "Failed to fetch" says nothing; say which half failed.
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
      // Mid-run drop; events already handled still stand.
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
