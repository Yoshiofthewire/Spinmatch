// Per-key, in-process serialization. Overlapping tag writes on one file destroy it.
// Key on the realpath the write will use (two names = two locks), or a namespaced
// non-path key like `dup:...` (can't collide: realpaths start with `/`).
const chains = new Map();

export function withFileLock(filePath, fn) {
  const previous = chains.get(filePath) ?? Promise.resolve();
  // Run even if the predecessor rejected, or one failed write wedges the key.
  const result = previous.then(fn, fn);
  // Swallow so the stored link isn't an unhandled rejection; delete only if still the tail.
  const link = result.catch(() => {}).finally(() => {
    if (chains.get(filePath) === link) chains.delete(filePath);
  });
  chains.set(filePath, link);
  return result;
}

// Test seam: how many paths currently have work queued or in flight.
export function pendingLockCount() {
  return chains.size;
}
