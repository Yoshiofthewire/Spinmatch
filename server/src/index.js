import { config, libraryEnabled, assertRequiredConfig } from './config.js';
import { createApp } from './app.js';
import { startLibrarySync } from './services/librarySync.js';
import { stopScan } from './services/libraryScanner.js';
import { ingestInProgress } from './services/ingest.js';
import { assertDbWritable } from './lib/dbPreflight.js';

assertRequiredConfig();
// Before anything opens a connection. getDb() is lazy, so without this a volume
// the process cannot write turns into a 500 on every request instead of a
// message saying which directory is wrong and who owns it.
assertDbWritable(config.library.dbPath);

// Log and exit, not log and continue.
//
// This used to swallow uncaught exceptions on the reasoning that a self-hosted
// server shouldn't die over a stray filesystem error. The problem is what
// "continuing" means: an uncaught exception is a function that stopped
// mid-execution, which for this app is a half-written tag, a transaction that
// never committed, or a scan that will markRemoved half the library. Carrying on
// from there does more damage than stopping.
//
// It was also actively hiding a bug. An FSWatcher emitting 'error' with no
// listener throws, so inotify exhaustion on a large library landed here, printed
// one line, and left the watcher permanently dead with the app reporting itself
// healthy. That watcher now handles its own errors (librarySync.js) — but the
// general lesson is that a global swallow turns every unhandled failure into a
// silent one.
//
// Exiting non-zero is the correct signal: the container's HEALTHCHECK and its
// restart policy exist precisely to bring the process back cleanly.
function fatal(label, err) {
  console.error(`${label}:`, err);
  // Give the log a tick to flush, then go. Not a graceful shutdown — the process
  // state is by definition untrustworthy at this point.
  setTimeout(() => process.exit(1), 100).unref();
}

process.on('uncaughtException', (err) => fatal('Uncaught exception', err));
// A rejection with no handler is the same class of bug, but it has not
// necessarily corrupted anything — the promise simply had no catch. Logged
// loudly and survived, so a missing `.catch()` in one route doesn't take down a
// server that is otherwise fine.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (continuing):', reason);
});

const app = createApp();

let sync = null;
const server = app.listen(config.port, () => {
  console.log(`Spinmatch server listening on port ${config.port}`);
  if (libraryEnabled()) {
    sync = startLibrarySync();
    console.log('Library sync started');
  }
});

// Graceful shutdown: stop the scan timer/watcher, terminate a scan worker that
// may be blocked in a filesystem call, and drain in-flight HTTP.
//
// The grace period is not a promise that nothing is ever cut off. An ingest run
// is minutes of rate-limited lookups and file moves, and no shutdown budget
// covers that — the previous comment here claimed `docker stop` wouldn't "sever
// a request mid-file-move" while the code exited after ten seconds flat, which
// is a claim the code never kept.
//
// What it does instead: give an ingest a longer (still bounded) window to reach
// a file boundary, say plainly in the log when it is being cut short, and leave
// the rest at the short budget. Ingest is restartable — an interrupted run
// leaves tagged-but-unmoved files that the next run picks up — so the honest
// answer is to bound the wait and report it, not to pretend it can't happen.
const DRAIN_TIMEOUT_MS = 10_000;
const INGEST_DRAIN_TIMEOUT_MS = 60_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const ingesting = ingestInProgress();
  const budget = ingesting ? INGEST_DRAIN_TIMEOUT_MS : DRAIN_TIMEOUT_MS;
  console.log(`Received ${signal}, shutting down…`);
  if (ingesting) {
    console.log(`An ingest run is in progress; waiting up to ${budget / 1000}s for it to reach a file boundary.`);
  }
  sync?.stop();
  // Don't hang forever if a connection won't drain or the worker won't stop.
  setTimeout(() => {
    console.warn(`Shutdown timed out after ${budget / 1000}s — exiting with work still in flight.`);
    process.exit(0);
  }, budget).unref();
  await stopScan().catch(() => {});
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
