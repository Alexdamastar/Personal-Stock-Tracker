import { createHash, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isMarketOpen } from '../lib/market-hours.js';
import type { FailureKind, QuoteProvider } from '../providers/types.js';
import { runEvaluator, type EvaluatorReport } from './alerts.js';
import { priceTicks, securities } from './schema.js';
import type { Db } from './seed.js';

/**
 * §5 M3 — one poll: gate on the NYSE session, fetch, write price_ticks, evaluate.
 *
 * The ET gate is the authority on when to poll. The scheduler fires on a wider UTC
 * window (DEFECT-03), so most of its calls end here as `closed` without spending a
 * single provider call.
 */
export type PollReport =
  | { status: 'closed' }
  | {
      status: 'polled';
      written: { ticker: string; price: number; provider: string }[];
      failures: Record<string, FailureKind>;
      evaluator: EvaluatorReport;
    };

/** numeric(18,4): round as the column will, so validation sees the stored value. */
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

export async function runPoll(db: Db, quotes: QuoteProvider, now = new Date()): Promise<PollReport> {
  if (!isMarketOpen(now)) return { status: 'closed' };

  const active = await db.select({ id: securities.id, ticker: securities.ticker })
    .from(securities).where(eq(securities.active, true));
  const idOf = new Map(active.map((s) => [s.ticker, s.id]));
  const result = await quotes.getQuotes(active.map((s) => s.ticker));

  const failures = Object.fromEntries(result.failures);
  const rows: (typeof priceTicks.$inferInsert)[] = [];
  const written: { ticker: string; price: number; provider: string }[] = [];
  for (const q of result.quotes) {
    const securityId = idOf.get(q.ticker);
    const price = round4(q.price);
    // DEFECT-26: 0.00004 passes `> 0` but stores as 0.0000 and fails the CHECK,
    // which would throw away the whole batch. It is no data, not a crash.
    if (securityId === undefined || !(price > 0)) { failures[q.ticker] = 'no_data'; continue; }
    const prevClose = q.prevClose === null ? null : round4(q.prevClose);
    rows.push({
      securityId,
      price,
      prevClose: prevClose !== null && prevClose > 0 ? prevClose : null, // DEFECT-23
      provider: q.provider,
      capturedAt: now,  // poll wall clock, one per batch: the PK and the stale badge
      quoteAt: q.at,    // provider stamp or null, never now() (DEFECT-01)
    });
    written.push({ ticker: q.ticker, price, provider: q.provider });
  }
  if (rows.length) await db.insert(priceTicks).values(rows).onConflictDoNothing();

  return { status: 'polled', written, failures, evaluator: await runEvaluator(db, { now }) };
}

/**
 * Bearer check for /api/poll. Fails closed when the token is unset. Both sides are
 * hashed first so the comparison is constant-time without leaking the length.
 */
export function isAuthorized(header: string | null, token: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(header.slice(7)), h(token));
}
