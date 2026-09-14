import { createDb } from './client.js';
import { seedDemo } from './demo.js';
import * as schema from './schema.js';
import { seed, type Db } from './seed.js';

export type AppDbMode = 'database' | 'demo';

interface AppDbHandle {
  db: Db;
  mode: AppDbMode;
  close: () => Promise<void>;
}

interface AppDbCache {
  /** DATABASE_URL the handle was built for; '' for demo. A changed URL builds a new handle. */
  key: string;
  promise: Promise<AppDbHandle>;
}

/**
 * On globalThis, not in a module-level variable: Next.js dev re-evaluates modules on
 * every hot reload, and a module-level cache would boot a fresh WASM Postgres (demo)
 * or open a fresh 5-connection pool (database) each time, leaking the old one.
 * A registered Symbol so every re-evaluated copy of this module finds the same slot.
 */
const CACHE = Symbol.for('rule1-watchlist.app-db');
type GlobalWithCache = typeof globalThis & { [CACHE]?: AppDbCache };

/**
 * The app's database handle. DATABASE_URL set -> the real database. Unset -> an
 * in-process PGlite demo database, migrated, seeded and filled with demo ticks, and
 * labelled DEMO in the UI (decision 2026-09-13).
 *
 * The in-flight PROMISE is cached, not the resolved handle, so concurrent first
 * requests share one initialization instead of each migrating its own database.
 */
export async function getAppDb(): Promise<{ db: Db; mode: AppDbMode }> {
  const g = globalThis as GlobalWithCache;
  const key = process.env.DATABASE_URL ?? '';
  const cached = g[CACHE];
  if (cached && cached.key === key) {
    const { db, mode } = await cached.promise;
    return { db, mode };
  }

  const promise = key ? openDatabase(key) : openDemo();
  g[CACHE] = { key, promise };
  // A failed init must not be cached forever: drop it so the next request retries
  // (e.g. a database that was briefly unreachable at boot).
  promise.catch(() => {
    if (g[CACHE]?.promise === promise) delete g[CACHE];
  });
  const { db, mode } = await promise;
  return { db, mode };
}

/**
 * Closes and forgets the cached handle. For tests and scripts; the app itself holds
 * the handle for the life of the process.
 */
export async function closeAppDb(): Promise<void> {
  const g = globalThis as GlobalWithCache;
  const cached = g[CACHE];
  delete g[CACHE];
  if (!cached) return;
  const handle = await cached.promise.catch(() => null);
  await handle?.close();
}

/**
 * A real database is NEVER migrated or seeded from here. Schema changes go through
 * `npm run db:migrate` deliberately; doing it implicitly on the first page request
 * would apply migrations to production from whichever deploy happened to boot first.
 */
async function openDatabase(url: string): Promise<AppDbHandle> {
  const { db, sql } = createDb(url);
  return { db: db as unknown as Db, mode: 'database', close: () => sql.end() };
}

async function openDemo(): Promise<AppDbHandle> {
  // Imported lazily so database mode never loads the PGlite WASM bundle.
  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
    import('drizzle-orm/pglite/migrator'),
  ]);
  const client = new PGlite();
  try {
    const pglite = drizzle(client, { schema });
    // Relative to process.cwd(): the project root under `next dev` and vitest.
    await migrate(pglite, { migrationsFolder: './drizzle' });
    const db = pglite as unknown as Db;
    await seed(db);
    await seedDemo(db);
    return { db, mode: 'demo', close: () => client.close() };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}
