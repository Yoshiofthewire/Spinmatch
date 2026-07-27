// Serializes work on a given file path, process-wide.
//
// node-taglib-sharp reads a file, mutates an in-memory tag, and writes the whole
// thing back. Two of those overlapping on one path is not a lost update, it is a
// destroyed audio file — ingest.js says exactly this in the comment above its
// own `inFlight` guard, and then libraryFix.js and libraryBulkFix.js wrote tags
// with no guard at all. A double-clicked Apply button was enough: two applyFix
// calls both await a MusicBrainz lookup, both come back, both call file.save().
//
// Keyed on the resolved path rather than a single global lock, so repairing one
// album doesn't serialize behind an unrelated one. Callers must pass the same
// realpath-resolved string the write will use — two names for one file are two
// locks and no protection, which is why every call site locks *after*
// assertReadableInsideMusicDir has resolved the path.
//
// The key doesn't have to be a path. duplicateTrash.js locks a whole group of
// duplicate copies against each other by passing a namespaced key built from
// dup_key instead — otherwise two requests trashing two *different* copies of
// the same track could both read "2 live copies" before either write lands,
// and both proceed. A namespaced key (`dup:...`) can't collide with a
// realpath: a resolved path is always absolute and so always starts with
// `/`, which `dup:` does not.
//
// Not a filesystem lock: it holds within this process only. That covers every
// writer the app has (the scan worker only reads), and a second process pointed
// at the same library was never coordinated anyway.
const chains = new Map();

export function withFileLock(filePath, fn) {
  const previous = chains.get(filePath) ?? Promise.resolve();
  // `previous.then(fn, fn)` rather than `.then(fn)`: a rejected predecessor must
  // still let the next caller run, or one failed write wedges that path until
  // restart.
  const result = previous.then(fn, fn);
  // The chain link is the *settled* result with the rejection swallowed —
  // otherwise the stored promise is an unhandled rejection the moment fn throws.
  // The map entry is cleared only if nothing else has queued behind us since,
  // so the map doesn't grow with every file the app has ever touched.
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
