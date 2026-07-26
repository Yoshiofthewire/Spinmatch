// The one server-sent-events lifecycle, shared by every stream this app serves.
//
// There were three hand-rolled copies of this — in routes/library.js,
// routes/verify.js and routes/ingest.js. One of them got fixed and the other two
// kept every bug the fix was written for:
//
//   - `send` wrote to the response without checking whether it was still there.
//     The client hangs up, `req.on('close')` aborts, and if the in-flight work
//     then surfaces a non-abort error (a yt-dlp rate limit landing a second
//     later) the handler wrote an event to a destroyed socket.
//   - `return res.end()` inside the try, with a `finally` that also calls
//     `res.end()`, ended the response twice on every early return. Harmless on
//     today's Node, which no-ops a second end() with no callback, but it is
//     load-bearing on a detail of a stdlib internal.
//   - no heartbeat. Every one of these streams is paced by a global 1-req/s
//     queue, so the gap between events routinely exceeds a reverse proxy's idle
//     timeout — and the README tells people to run this behind a proxy. The
//     album verify stream would simply die mid-run.
//
// The handler now just does work and emits events; closing is not its problem.

// Returned by a handler that has already emitted its own terminal event (a
// validation error) and wants the wrapper to stop without adding `done` on top.
export const STREAM_HANDLED = Symbol('stream-handled');

const HEARTBEAT_MS = 15_000;

export function sseStream(handler) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Proxies that buffer a response defeat the point of streaming it.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const alive = () => !res.writableEnded && !res.destroyed;
    const send = (event, data) => {
      if (!alive()) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const ac = new AbortController();
    // A comment line keeps the connection warm between real events.
    const heartbeat = setInterval(() => { if (alive()) res.write(': keep-alive\n\n'); }, HEARTBEAT_MS);
    heartbeat.unref?.();
    req.on('close', () => ac.abort());

    try {
      // The handler's return value is the `done` payload: undefined for the
      // streams that just say "finished", a summary object for the ones that
      // have totals to report.
      const summary = await handler({ req, send, signal: ac.signal });
      if (!ac.signal.aborted && summary !== STREAM_HANDLED) send('done', summary ?? {});
    } catch (err) {
      if (!ac.signal.aborted) {
        if (err.code === 'RATE_LIMITED') send('rate_limited', { code: err.code, message: err.message });
        else send('error', { code: err.code || 'INTERNAL', message: err.message });
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  };
}
