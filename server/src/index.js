import { config, libraryEnabled, assertRequiredConfig } from './config.js';
import { createApp } from './app.js';
import { startLibrarySync } from './services/librarySync.js';
import { stopScan } from './services/libraryScanner.js';

assertRequiredConfig();

// Last line of defence, not a licence to skip error handling anywhere else. A
// stray error from a filesystem read must not take a self-hosted server down and
// strand an in-flight ingest — log it loudly and keep serving. Anything that
// leaves the process genuinely unable to continue will fail its next request and
// be caught by the container's healthcheck.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (continuing):', err);
});
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
// may be blocked in a filesystem call, and drain in-flight HTTP so a
// `docker stop` doesn't sever a request mid-file-move.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down…`);
  sync?.stop();
  // Don't hang forever if a connection won't drain or the worker won't stop.
  setTimeout(() => process.exit(0), 10_000).unref();
  await stopScan().catch(() => {});
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
