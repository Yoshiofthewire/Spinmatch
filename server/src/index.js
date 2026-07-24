import { config, libraryEnabled, assertRequiredConfig } from './config.js';
import { createApp } from './app.js';
import { startLibrarySync } from './services/librarySync.js';

assertRequiredConfig();

const app = createApp();

let sync = null;
const server = app.listen(config.port, () => {
  console.log(`Spinmatch server listening on port ${config.port}`);
  if (libraryEnabled()) {
    sync = startLibrarySync();
    console.log('Library sync started');
  }
});

// Graceful shutdown: stop the scan timer/watcher and drain in-flight HTTP so a
// `docker stop` doesn't sever a request mid-file-move.
function shutdown(signal) {
  console.log(`Received ${signal}, shutting down…`);
  sync?.stop();
  server.close(() => process.exit(0));
  // Don't hang forever if a connection won't drain.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
