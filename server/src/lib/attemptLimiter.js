// Fixed-window, per-key attempt limiter for unauthenticated auth routes, so a
// bad actor can't hammer /auth/login as a password-guessing (and scrypt-CPU)
// oracle. In-memory is fine for a single-instance self-hosted app; expired
// entries are pruned opportunistically so the map can't grow unbounded.
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
