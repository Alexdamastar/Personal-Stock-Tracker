import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../src/db/schema.js';
import type { Db } from '../src/db/seed.js';

/**
 * In-process Postgres (PGlite, WASM) so the M1 acceptance criteria are actually
 * RUNNABLE with no server, no container, and no shared state between tests.
 *
 * This runs the SAME drizzle/0000_init.sql that ships to production, so a test
 * passing here means the real migration applies. It is not a mock.
 */
export async function freshDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return { db: db as unknown as Db, close: () => client.close() };
}

export { schema };
