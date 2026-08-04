// `defineConfig` comes from vitest/config rather than plain vite: it re-exports
// vite's own defineConfig, so `vite build`/`vite dev` read this file exactly as
// before, but it also types (and lets us add) the `test` block below. One file
// stays the single source of truth instead of a vite.config.js plus a
// vitest.config.js that can drift out of sync with it.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    // No global test/expect injection: tests import them from 'vitest'
    // explicitly, the same way the rest of this codebase avoids ambient
    // globals (see the server suite's plain node:test imports).
    globals: false,
  },
});
