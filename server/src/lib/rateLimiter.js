function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Minimum interval between starts of consecutive calls, FIFO.
export class RateLimiter {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.chain = Promise.resolve();
    this.lastRunAt = 0;
  }

  schedule(fn) {
    const run = this.chain.then(async () => {
      const wait = this.lastRunAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRunAt = Date.now();
      return fn();
    });
    // Keep the chain alive even if this call rejects, so later callers aren't blocked forever.
    this.chain = run.catch(() => {});
    return run;
  }
}
