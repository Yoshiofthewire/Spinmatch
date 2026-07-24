import { config, libraryEnabled } from './config.js';
import { createApp } from './app.js';
import { startLibrarySync } from './services/librarySync.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`Spinmatch server listening on port ${config.port}`);
  if (libraryEnabled()) {
    startLibrarySync();
    console.log('Library sync started');
  }
});
