// Time-bounded *and* size-bounded. The TTL alone was not enough: expired entries
// were only ever reclaimed if the same key happened to be read again, so nothing
// swept them, and the two instances that cache HTTP response bodies grew without
// limit until the process was restarted. `maxEntries` makes the worst case
// bounded and knowable; insertion order makes eviction FIFO, which for these
// caches (a query is either asked repeatedly right now or never again) behaves
// close enough to LRU to not be worth a heavier structure.
// `maxBytes` is the second bound, for the caches whose values are Buffers. An
// entry count is a proxy for memory only when entries are a similar size, and
// for cover art they are not: 24 entries of up to 8 MB each is 192 MB, which is
// not the small number "24" reads as. Pass `sizeOf` to weigh entries by their
// real cost and evict on whichever bound is hit first.
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
    // Re-inserting moves the key to the end of the iteration order, so a
    // refreshed entry isn't the next one evicted.
    this.#drop(key);
    const size = this.sizeOf ? this.sizeOf(value) : 0;
    if (this.#full(size)) this.prune();
    // Evict oldest-first until the new entry fits under both bounds. Guarded on
    // store.size so a single value larger than maxBytes empties the cache and
    // is then stored rather than looping forever on an empty map.
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

  // Drops everything already expired. Cheaper than evicting live entries, so it
  // runs first when the cache is full.
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
