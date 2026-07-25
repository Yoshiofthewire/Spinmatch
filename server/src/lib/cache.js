// Time-bounded *and* size-bounded. The TTL alone was not enough: expired entries
// were only ever reclaimed if the same key happened to be read again, so nothing
// swept them, and the two instances that cache HTTP response bodies grew without
// limit until the process was restarted. `maxEntries` makes the worst case
// bounded and knowable; insertion order makes eviction FIFO, which for these
// caches (a query is either asked repeatedly right now or never again) behaves
// close enough to LRU to not be worth a heavier structure.
export class TTLCache {
  constructor({ maxEntries = 1000 } = {}) {
    this.store = new Map();
    this.maxEntries = maxEntries;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    // Re-inserting moves the key to the end of the iteration order, so a
    // refreshed entry isn't the next one evicted.
    this.store.delete(key);
    if (this.store.size >= this.maxEntries) this.prune();
    while (this.store.size >= this.maxEntries) {
      this.store.delete(this.store.keys().next().value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  // Drops everything already expired. Cheaper than evicting live entries, so it
  // runs first when the cache is full.
  prune(now = Date.now()) {
    for (const [key, entry] of this.store) {
      if (entry.expiresAt < now) this.store.delete(key);
    }
  }

  get size() {
    return this.store.size;
  }

  has(key) {
    return this.get(key) !== undefined;
  }
}
