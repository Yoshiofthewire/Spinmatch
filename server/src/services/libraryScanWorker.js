import { parentPort } from 'node:worker_threads';
import { runScanOnce } from './libraryScanner.js';

// One scan off the main loop, on its own DB connection (WAL allows it). One worker per scan.
runScanOnce({ onProgress: (scanned) => parentPort.postMessage({ progress: scanned }) })
  .then((summary) => parentPort.postMessage({ ok: true, summary }))
  .catch((err) => parentPort.postMessage({ ok: false, error: err.message }));
