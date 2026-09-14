import { defineConfig } from 'vitest/config';

// jsdom 30 reaches an ES-module-only dependency through require(), which Node only
// allows unflagged from 22.12 (jsdom itself declares ^22.22.2). On an older Node 22
// the DOM suite dies before collecting a test, so turn the feature on for the test
// workers there. On a new enough Node this is a no-op and no flag is passed.
const workerExecArgv = process.features.require_module ? [] : ['--experimental-require-module', '--disable-warning=ExperimentalWarning'];

export default defineConfig({
  // tsconfig's JSX setting is for tsc and Next; vitest transforms with esbuild, so
  // state the automatic runtime here rather than depend on how tsconfig is read.
  esbuild: { jsx: 'automatic' },
  test: {
    globals: true,
    // Node stays the default. A DOM suite opts in per file with
    // `// @vitest-environment jsdom`, so the PGlite suites never boot a DOM.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    poolOptions: {
      forks: { execArgv: workerExecArgv },
      threads: { execArgv: workerExecArgv },
    },
    // PGlite boots a WASM Postgres per suite; give it room on a cold start.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
