// TTL cache bounded by entry count and, with `sizeOf`, by bytes. Eviction is FIFO
// (insertion order), close enough to LRU for these access patterns.
export class TTLCache {
  constructor({ maxEntries = 1000, maxBytes = Infinity, sizeOf = null } = {}) {
    this.store = new Map();
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
    this.bytes = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.#drop(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    // Re-insert so a refreshed entry moves to the back of the eviction queue.
    this.#drop(key);
    const size = this.sizeOf ? this.sizeOf(value) : 0;
    if (this.#full(size)) this.prune();
    // A value over maxBytes empties the cache and is stored anyway.
    while (this.store.size > 0 && this.#full(size)) {
      this.#drop(this.store.keys().next().value);
    }
    this.store.set(key, { value, size, expiresAt: Date.now() + ttlMs });
    this.bytes += size;
  }

  #full(incomingSize) {
    return this.store.size >= this.maxEntries || this.bytes + incomingSize > this.maxBytes;
  }

  #drop(key) {
    const entry = this.store.get(key);
    if (!entry) return;
    this.bytes -= entry.size;
    this.store.delete(key);
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.store) {
      if (entry.expiresAt < now) this.#drop(key);
    }
  }

  get size() {
    return this.store.size;
  }

  has(key) {
    return this.get(key) !== undefined;
  }
}
