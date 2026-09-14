import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

/**
 * Runtime client (Node / Next.js server components).
 *
 * NOTE for M3: Cloudflare Workers cannot open a raw TCP socket to Postgres, so the
 * Worker must either call /api/poll over HTTP or use Neon's HTTP driver. This
 * postgres.js client will not run inside a Worker.
 */
export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 5, prepare: false });
  return { db: drizzle(sql, { schema }), sql };
}
