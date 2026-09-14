import { and, eq, inArray, lt } from 'drizzle-orm';
import { runEvaluator } from './alerts.js';
import * as schema from './schema.js';
import type { Db } from './seed.js';

/**
 * DEMO DATA — for the in-process PGlite demo database ONLY (decision 2026-09-13).
 *
 * `getAppDb()` calls this when DATABASE_URL is unset, after `seed()`, so the
 * dashboard has something to show before M3 polls anything real. It is never run
 * against a real database: these ticks and bars are invented, and a real database
 * that contained them would show made-up prices as if a provider had quoted them.
 * Every tick is written with `provider: 'demo'` so it can never be mistaken for one.
 *
 * Prices are chosen against the §4 seed thresholds so the dashboard shows every chip
 * state (precedence at_buy > at_safe > approaching > watching):
 *
 *   AMZN   204.10   below buy 209.29 (and safe 220)   -> at_buy
 *   AAPL   194.80   below safe 200, above buy 121.04   -> at_safe
 *   MSFT   418.50   4.6% above safe 400                -> approaching
 *   GOOGL  468.20   11.1% above buy 421.50             -> watching, just outside
 *   META  1160.40   37.9% above buy 841.77             -> watching, far from any line
 */
export const DEMO_PROVIDER = 'demo';

export const DEMO_QUOTES: readonly { ticker: string; price: number; prevClose: number }[] = [
  { ticker: 'AAPL',  price: 194.80,  prevClose: 197.35 },
  { ticker: 'META',  price: 1160.40, prevClose: 1148.95 },
  { ticker: 'GOOGL', price: 468.20,  prevClose: 471.02 },
  { ticker: 'MSFT',  price: 418.50,  prevClose: 412.66 },
  { ticker: 'AMZN',  price: 204.10,  prevClose: 208.73 },
];

/** Daily bars written per ticker — the sparkline's full 30-bar window. */
export const DEMO_BAR_COUNT = 30;

/** The poll happened just before `now`, so the stale badge and the evaluator's 15-minute cutoff both see it as fresh. */
const CAPTURED_BEFORE_NOW_MS = 60 * 1000;
/** D6: quotes are delayed 15-20 minutes. quote_at is the provider's stamp, never the poll time (DEFECT-01). */
const QUOTE_DELAY_MS = 20 * 60 * 1000;

/**
 * mulberry32: a tiny deterministic PRNG. `Math.random()` would make every demo boot
 * draw different sparklines, which makes a screenshot or a bug report unreproducible.
 */
function mulberry32(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, so each ticker gets its own stable stream. */
function hashTicker(ticker: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < ticker.length; i++) {
    h ^= ticker.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** YYYY-MM-DD of `at` in America/New_York — never the host's zone (the developer is in Phoenix). */
function nyDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

/**
 * The `count` weekdays strictly before `now`'s New York date, oldest first. Exchange
 * holidays are ignored: this is demo data, and a missing holiday bar is invisible
 * on a 30-point sparkline.
 */
export function demoBarDates(now: Date, count = DEMO_BAR_COUNT): string[] {
  // Calendar arithmetic on a UTC-midnight Date is zone-free, so DST cannot shift a day.
  const cursor = new Date(`${nyDate(now)}T00:00:00Z`);
  const dates: string[] = [];
  while (dates.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates.reverse();
}

/**
 * A random walk that ENDS at `lastClose`, generated backwards so the sparkline meets
 * the current price instead of drifting somewhere unrelated to it. Daily moves are
 * within +/-2%, roughly a large-cap's ordinary day.
 */
function demoBars(ticker: string, lastClose: number, dates: string[]) {
  const rand = mulberry32(hashTicker(ticker));
  const closes: number[] = new Array(dates.length);
  closes[dates.length - 1] = lastClose;
  for (let i = dates.length - 1; i > 0; i--) {
    const move = (rand() - 0.5) * 0.04;
    closes[i - 1] = closes[i]! / (1 + move);
  }
  return dates.map((date, i) => {
    const close = closes[i]!;
    const open = i === 0 ? close * (1 + (rand() - 0.5) * 0.01) : closes[i - 1]!;
    const high = Math.max(open, close) * (1 + rand() * 0.008);
    const low = Math.min(open, close) * (1 - rand() * 0.008);
    return { date, open: round2(open), high: round2(high), low: round2(low), close: round2(close) };
  });
}

/**
 * Fills the IN-PROCESS DEMO database with ticks, 30 daily bars per ticker and the
 * alerts those ticks produce, all relative to `now`. Requires `seed()` first.
 *
 * Idempotent: it does nothing when any demo tick already exists, so a second boot or
 * a hot reload that reaches it again does not duplicate history.
 *
 * Must not be pointed at a real database — see the module comment.
 */
export async function seedDemo(db: Db, now: Date = new Date()): Promise<{ seeded: boolean }> {
  const [existing] = await db.select({ provider: schema.priceTicks.provider })
    .from(schema.priceTicks)
    .where(eq(schema.priceTicks.provider, DEMO_PROVIDER))
    .limit(1);
  if (existing) return { seeded: false };

  const rows = await db.select({ id: schema.securities.id, ticker: schema.securities.ticker })
    .from(schema.securities)
    .where(and(
      inArray(schema.securities.ticker, DEMO_QUOTES.map((q) => q.ticker)),
      eq(schema.securities.active, true),
    ));
  const idByTicker = new Map(rows.map((r) => [r.ticker, r.id]));

  const capturedAt = new Date(now.getTime() - CAPTURED_BEFORE_NOW_MS);
  const quoteAt = new Date(capturedAt.getTime() - QUOTE_DELAY_MS);
  const dates = demoBarDates(now);

  for (const quote of DEMO_QUOTES) {
    const securityId = idByTicker.get(quote.ticker);
    if (securityId === undefined) continue; // seed() not run, or the ticker was removed

    // The last bar is the previous session, so its close IS the tick's prev_close:
    // the sparkline and the % change agree about yesterday.
    // tick_count 0 is the honest value: no ticks were rolled up into these bars.
    const bars = demoBars(quote.ticker, quote.prevClose, dates);
    await db.insert(schema.dailyBars)
      .values(bars.map((b) => ({ securityId, ...b, tickCount: 0 })))
      .onConflictDoNothing();

    await db.insert(schema.priceTicks).values({
      securityId,
      price: quote.price,
      prevClose: quote.prevClose,
      provider: DEMO_PROVIDER,
      capturedAt,
      quoteAt,
    });
  }

  // Alerts come from the real evaluator, not hand-written rows, so the demo can only
  // show alert states the production code would actually produce.
  await runEvaluator(db, { now });
  return { seeded: true };
}

/**
 * Re-stamps the demo ticks to `now` on every page load (user decision 2026-09-13).
 *
 * seedDemo writes once, so without this a demo left open during market hours shows
 * the stale badge after 15 minutes and looks broken. Refreshing costs nothing: demo
 * prices are invented here and never come from Finnhub or Twelve Data. Prices stay
 * fixed, so every chip state stays on screen.
 *
 * The ticks are UPDATED in place, not appended, so a tab auto-refreshing every minute
 * does not grow the in-memory database without bound. `captured_at < new` keeps the
 * stamp monotonic when two requests race with slightly different clocks.
 *
 * Must not be pointed at a real database — see the module comment.
 */
export async function refreshDemo(db: Db, now: Date = new Date()): Promise<void> {
  const capturedAt = new Date(now.getTime() - CAPTURED_BEFORE_NOW_MS);
  const quoteAt = new Date(capturedAt.getTime() - QUOTE_DELAY_MS);
  await db.update(schema.priceTicks)
    .set({ capturedAt, quoteAt })
    .where(and(
      eq(schema.priceTicks.provider, DEMO_PROVIDER),
      lt(schema.priceTicks.capturedAt, capturedAt),
    ));
  // Keeps the evaluator's 15-minute gate satisfied and the open alerts consistent.
  await runEvaluator(db, { now });
}
