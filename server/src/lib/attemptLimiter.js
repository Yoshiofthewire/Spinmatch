// Fixed-window, per-key limiter for auth routes (password guessing, hash CPU).
// In-memory: single instance. Expired entries pruned opportunistically.
export function createAttemptLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();

  function prune(t) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= t) hits.delete(key);
    }
  }

  return function limit(key) {
    const t = now();
    if (hits.size > 1000) prune(t);
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      hits.set(key, { count: 1, resetAt: t + windowMs });
      return { allowed: true };
    }
    entry.count += 1;
    if (entry.count > max) return { allowed: false, retryAfterMs: entry.resetAt - t };
    return { allowed: true };
  };
}
