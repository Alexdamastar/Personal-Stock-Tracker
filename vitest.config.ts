import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // PGlite boots a WASM Postgres per suite; give it room on a cold start.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
