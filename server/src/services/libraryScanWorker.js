import { parentPort } from 'node:worker_threads';
import { runScanOnce } from './libraryScanner.js';

// Runs one library scan off the main event loop. The worker inherits the
// parent's process.env, so config.js resolves MUSIC_DIR / LIBRARY_DB the same
// way; getDb() opens this thread's own connection to that DB file (WAL, so it
// coexists with the main thread's read connection). Reports the summary back
// and exits — scanLibrary() spawns a fresh worker per scan.
runScanOnce()
  .then((summary) => parentPort.postMessage({ ok: true, summary }))
  .catch((err) => parentPort.postMessage({ ok: false, error: err.message }));
