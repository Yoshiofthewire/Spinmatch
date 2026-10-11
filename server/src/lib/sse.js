// Shared SSE lifecycle: the handler only emits events; this owns headers, heartbeat,
// abort-on-close, the terminal event, and ending the response exactly once.

// Return this when the handler already sent its own terminal event.
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
    // Events are paced at ~1/s; heartbeat beats reverse-proxy idle timeouts.
    const heartbeat = setInterval(() => { if (alive()) res.write(': keep-alive\n\n'); }, HEARTBEAT_MS);
    heartbeat.unref?.();
    // res, not req: a POST's req has already closed once its body was read.
    res.on('close', () => ac.abort());

    try {
      // The handler's return value is the `done` payload.
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
