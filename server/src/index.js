import { config, libraryEnabled, assertRequiredConfig } from './config.js';
import { createApp } from './app.js';
import { startLibrarySync } from './services/librarySync.js';
import { stopScan } from './services/libraryScanner.js';
import { ingestInProgress } from './services/ingest.js';
import { assertDbWritable } from './lib/dbPreflight.js';
import { getDb } from './lib/db.js';
import { adminExists, issueSetupToken } from './services/auth.js';
import { rebaseTrackPaths } from './services/libraryRepo.js';
import path from 'node:path';

assertRequiredConfig();
// Fail at boot with a clear message, not a 500 per request from the lazy getDb().
assertDbWritable(config.library.dbPath);

// Migrate on the main thread before the scan worker opens its own connection.
const db = getDb();
if (config.ingest.musicDir) {
  const moved = rebaseTrackPaths(db, path.join(process.env.MUSIC_DIR), config.ingest.musicDir);
  if (moved) console.log(`Moved ${moved} track paths to the resolved music folder ${config.ingest.musicDir}`);
}
if (!adminExists(db)) {
  console.log(`First-run setup token: ${issueSetupToken()}`);
}

// Uncaught exception: state may be half-written, so exit non-zero and let the
// container restart policy recover. No graceful shutdown; just let the log flush.
function fatal(label, err) {
  console.error(`${label}:`, err);
  setTimeout(() => process.exit(1), 100).unref();
}

process.on('uncaughtException', (err) => fatal('Uncaught exception', err));
// A missing .catch() hasn't necessarily corrupted anything: log and survive.
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

// Graceful shutdown: stop sync, terminate the scan worker, drain HTTP. Bounded:
// an in-flight ingest gets longer but may still be cut off (the next run resumes it).
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
