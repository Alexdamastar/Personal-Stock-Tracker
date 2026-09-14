import type { Db } from './seed.js';

export type AppDbMode = 'database' | 'demo';

/**
 * The app's database handle. DATABASE_URL set -> the real database. Unset -> an
 * in-process PGlite demo database, migrated, seeded and filled with demo ticks, and
 * labelled DEMO in the UI (decision 2026-09-13).
 *
 * STUB — the M5 fan-out replaces this file. The signature is the contract.
 */
export async function getAppDb(): Promise<{ db: Db; mode: AppDbMode }> {
  throw new Error('not implemented: app database (M5 fan-out)');
}
