import { vi } from 'vitest';

// api/client.js is the only module allowed to call fetch (see its own
// comment), so stubbing global fetch exercises the real request/response
// shaping in client.js and lib/eventStream.js — the 409-to-`err.details`
// translation the drop-off Replace gate depends on — rather than a fake that
// assumes that shaping already happened. That is the "more honest test" the
// task calls for: a route table of fetch mocks over mocking the api/ modules
// themselves.
//
// `routes` is matched in order against every fetch call; the first route
// whose `method`/`test` both match wins. A route is consumed and removed
// once used unless `once: false` is set, so a component that calls the same
// endpoint twice (e.g. GET /playlists/:id on mount and again after a write)
// needs either two queued routes or one `{ once: false }` route.
export function installFetchMock(routes) {
  const calls = [];
  const queue = routes.map((r) => ({ once: true, ...r }));

  global.fetch = vi.fn(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });

    const index = queue.findIndex(
      (r) => (!r.method || r.method === method) && r.test(url),
    );
    if (index === -1) {
      throw new Error(`fetchMock: no route matches ${method} ${url}`);
    }
    const route = queue[index];
    if (route.once) queue.splice(index, 1);
    return route.respond();
  });

  return calls;
}

export function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// The dropoff export's pre-check 409 (and the m3u export's) is answered as
// plain JSON, not a stream — lib/eventStream.js's openFailed() reads
// `res.json()` before ever touching `res.body`, so this is just jsonResponse
// under a name that matches what it represents in a test.
export const errorResponse = jsonResponse;

// A minimal but real SSE body: `event`/`data` framing, one blank line between
// frames, closed after the last one — the same shape lib/eventStream.js's
// `dispatch()` parses. Response wraps a string body in a ReadableStream on
// its own, so this doesn't need to hand-build one.
export function sseResponse(events) {
  const body = events.map(({ event, data }) => (
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  )).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}
