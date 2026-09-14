import type { NextConfig } from 'next';

/**
 * Built with webpack, not Turbopack (Next 16's default): the package.json scripts pass
 * `--webpack`, so use `npm run build` / `npm run dev`, not a bare `next build`.
 *
 * Why: the library code imports TypeScript as ESM with `.js` specifiers
 * (`import * as schema from './schema.js'`), which tsc, tsx and vitest all resolve to
 * the `.ts` file. Turbopack 16.3 cannot: it has no extensionAlias (Next lists
 * `experimental.extensionAlias` as Turbopack-unsupported), and `turbopack.resolveAlias`
 * resolves a relative target against the project root rather than the importing
 * file, so `./*.js -> ./*.ts` points at the wrong directory. Rewriting every import
 * would break the tsx scripts' convention instead.
 */
const nextConfig: NextConfig = {
  // Loaded with Node's own require instead of being bundled into the server build.
  //  - @electric-sql/pglite ships a WASM Postgres plus data files it locates relative
  //    to its own module URL; bundling moves the JS away from those files and demo
  //    mode (DATABASE_URL unset) then fails at runtime, not at build time.
  //  - postgres (postgres.js) opens raw TCP sockets and gains nothing from bundling.
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],

  webpack: (config) => {
    config.resolve ??= {};
    // Try the TypeScript source first, then a real .js file (node_modules, if any
    // package is resolved through a relative .js path).
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
