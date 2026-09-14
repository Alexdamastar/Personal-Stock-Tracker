/**
 * M1 acceptance verifier against a REAL Postgres (Neon, Supabase, or local).
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/verify.ts
 *
 * The vitest suite proves the same properties against PGlite with no server.
 * This exists to confirm the identical migration applies on the actual engine
 * the project will deploy to.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import { seed, type Db } from '../src/db/seed.js';
import { latestValuations, resolvedThresholds } from '../src/db/queries.js';
import { rollupDailyBars } from '../src/db/rollup.js';
import { applyDecision, loadRuleStates, runEvaluator } from '../src/db/alerts.js';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

const EXPECTED = [
  { ticker: 'AAPL',  buy: 121.04, sticker: 242.08,  safe: 200,  avgCost: 228.21 },
  { ticker: 'META',  buy: 841.77, sticker: 1683.54, safe: null, avgCost: 632.78 },
  { ticker: 'GOOGL', buy: 421.50, sticker: 843.00,  safe: null, avgCost: 239.89 },
  { ticker: 'MSFT',  buy: 270.87, sticker: 541.74,  safe: 400,  avgCost: 455.69 },
  { ticker: 'AMZN',  buy: 209.29, sticker: 418.58,  safe: 220,  avgCost: null },
];

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// onnotice: drizzle's migrator issues CREATE SCHEMA / CREATE TABLE IF NOT EXISTS
// for its own journal, so a re-apply emits benign 42P06/42P07 NOTICEs. postgres.js
// prints those to stdout by default, which reads like a failure but is not one.
const sql = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(sql, { schema }) as unknown as Db;

await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
console.log('migration applied\n');
await seed(db);

// ---- M1 acceptance: SELECT reproduces the §4 seed table exactly
const rows = await db.select({
  ticker: schema.securities.ticker,
  buy: schema.valuations.buyPrice,
  sticker: schema.valuations.stickerPrice,
})
  .from(schema.securities)
  .innerJoin(schema.valuations, eq(schema.valuations.securityId, schema.securities.id))
  .orderBy(asc(schema.securities.id));

console.log('--- §4 seed table ---');
for (const want of EXPECTED) {
  const got = rows.find((r) => r.ticker === want.ticker);
  check(
    `${want.ticker.padEnd(5)} buy=${want.buy} sticker=${want.sticker}`,
    got?.buy === want.buy && got?.sticker === want.sticker,
    got ? `(got buy=${got.buy} sticker=${got.sticker})` : '(missing)',
  );
}
check('exactly 5 securities seeded', rows.length === 5, `(got ${rows.length})`);

// ---- DEFECT-04: numeric arrives as number, not string
const first = rows[0];
check('numeric columns are JS numbers, not strings',
  typeof first?.buy === 'number', `(typeof buy = ${typeof first?.buy})`);

// ---- D1: buy rules follow the latest PBT valuation
console.log('\n--- D1 threshold resolution ---');
const buys = (await resolvedThresholds(db)).filter((r) => r.kind === 'buy');
for (const want of EXPECTED) {
  const got = buys.find((b) => b.ticker === want.ticker);
  check(`${want.ticker.padEnd(5)} buy rule -> ${want.buy}`,
    Number(got?.threshold) === want.buy && got?.pinned === false);
}
const safes = (await resolvedThresholds(db)).filter((r) => r.kind === 'safe');
check('safe rules exist only where §4 gives one',
  safes.length === 3, `(got ${safes.length}, expected 3)`);

// ---- DEFECT-02: the partial unique index is really enforced
console.log('\n--- DEFECT-02 one open alert event per rule ---');
const ruleId = safes[0] ? Number(safes[0].rule_id) : 0;
const threshold = safes[0] ? Number(safes[0].threshold) : 1;
await sql`delete from alert_events where rule_id = ${ruleId}`;
await db.insert(schema.alertEvents)
  .values({ ruleId, price: 1, threshold, triggeredAt: new Date() });
let rejected = false;
try {
  await db.insert(schema.alertEvents).values({ ruleId, price: 2, threshold, triggeredAt: new Date() });
} catch { rejected = true; }
check('second open event on the same rule is rejected', rejected);
await sql`delete from alert_events where rule_id = ${ruleId}`;

// ---- append-only reads
console.log('\n--- append-only ---');
const latest = await latestValuations(db);
check('latestValuations returns one row per (security, method)',
  latest.length === 5, `(got ${latest.length})`);

const before = await db.select().from(schema.valuations);
const again = await seed(db);
const after = await db.select().from(schema.valuations);
check('re-seeding inserts nothing and UPDATEs nothing',
  again.inserted.length === 0 && again.skipped.length === 5 && before.length === after.length,
  `(inserted=${again.inserted.length} skipped=${again.skipped.length}, rows ${before.length} -> ${after.length})`);

// ---- DEFECT-13: rollup runs a raw db.execute(). postgres.js returns an array,
// PGlite returns { rows }. The vitest suite only ever exercises the PGlite side,
// so this is the check that the production driver path actually works.
console.log('\n--- DEFECT-13 rollup on the production driver ---');
const [amzn] = await db.select().from(schema.securities)
  .where(eq(schema.securities.ticker, 'AMZN'));
const amznId = amzn!.id;
const tick = (capturedAt: string, price: number) =>
  db.insert(schema.priceTicks).values({
    securityId: amznId, price, provider: 'verify',
    capturedAt: new Date(capturedAt), quoteAt: null,
  });

await sql`delete from daily_bars`;
await sql`delete from price_ticks`;
await tick('2026-08-28T11:00:00Z', 260.0); // 07:00 EDT  pre-market, excluded
await tick('2026-08-28T13:35:00Z', 266.0); // 09:35 EDT  open
await tick('2026-08-28T16:00:00Z', 270.5); // 12:00 EDT  high
await tick('2026-08-28T17:00:00Z', 261.5); // 13:00 EDT  low
await tick('2026-08-28T19:55:00Z', 268.0); // 15:55 EDT  close
await tick('2026-08-28T21:00:00Z', 999.0); // 17:00 EDT  after hours, excluded
await tick('2026-12-15T13:35:00Z', 300.0); // 08:35 EST  pre-market, excluded
await tick('2026-12-15T14:35:00Z', 301.0); // 09:35 EST  in session

await rollupDailyBars(db);
const bars = await db.select().from(schema.dailyBars).orderBy(asc(schema.dailyBars.date));
check('rollup wrote bars through postgres.js', bars.length === 2, `(got ${bars.length})`);
const [aug, dec] = bars;
check('session window excludes pre- and post-market ticks',
  aug?.date === '2026-08-28' && aug?.open === 266 && aug?.high === 270.5
    && aug?.low === 261.5 && aug?.close === 268 && aug?.tickCount === 4,
  `(${JSON.stringify(aug)})`);
// DEFECT-03: the same UTC hour falls inside the session in August and before it
// in December. This asserts the server's own tzdata agrees, not just PGlite's.
check('13:35Z is in-session in August and pre-market in December',
  dec?.date === '2026-12-15' && dec?.tickCount === 1 && dec?.open === 301,
  `(${JSON.stringify(dec)})`);
check('numeric survives the rollup as a number', typeof aug?.open === 'number',
  `(typeof open = ${typeof aug?.open})`);

await rollupDailyBars(db);
check('rollup is idempotent',
  (await db.select().from(schema.dailyBars)).length === 2);

await sql`delete from daily_bars`;
await sql`delete from price_ticks`;

// ---- M4: the evaluator's raw SQL on the production driver. loadRuleStates() reads
// numerics and an epoch through db.execute() — the DEFECT-13 class — and
// applyDecision() leans on ON CONFLICT against a partial unique index. PGlite
// passing proves neither on postgres.js.
console.log('\n--- M4 evaluator on the production driver ---');
const [col] = await sql`
  select is_nullable from information_schema.columns
   where table_name = 'alert_events' and column_name = 'threshold'`;
check('migration 0001 added alert_events.threshold NOT NULL', col?.is_nullable === 'NO');

const [msft] = await db.select().from(schema.securities)
  .where(eq(schema.securities.ticker, 'MSFT'));
await sql`delete from alert_events`;
const series = [410, 401, 399, 399.5, 398, 405, 402];
for (const [i, price] of series.entries()) {
  const at = new Date(Date.UTC(2026, 8, 15, 14, 5 * i));
  await db.insert(schema.priceTicks).values({
    securityId: msft!.id, price, provider: 'verify', capturedAt: at, quoteAt: null,
  });
  await runEvaluator(db, { now: at });
}
const msftEvents = await db.select().from(schema.alertEvents);
const [ev] = msftEvents;
check('acceptance series -> exactly one event, opened at 399 and cleared',
  msftEvents.length === 1 && ev?.price === 399 && ev?.threshold === 400 && ev?.clearedAt !== null,
  `(${JSON.stringify(msftEvents)})`);
// series[2] = 399 is polled at 14:10Z; series[5] = 405 at 14:25Z.
check('event timestamps are the ticks\' (14:10Z open, 14:25Z clear)',
  ev?.triggeredAt.toISOString() === '2026-09-15T14:10:00.000Z'
    && ev?.clearedAt?.toISOString() === '2026-09-15T14:25:00.000Z',
  `(${ev?.triggeredAt.toISOString()} -> ${ev?.clearedAt?.toISOString()})`);

const states = await loadRuleStates(db);
const msftSafe = states.find((s) => s.ticker === 'MSFT' && s.kind === 'safe');
check('loadRuleStates parses numerics and the epoch on postgres.js',
  typeof msftSafe?.threshold === 'number' && msftSafe.capturedAt instanceof Date
    && !Number.isNaN(msftSafe.capturedAt.getTime()),
  `(${JSON.stringify(msftSafe)})`);

await db.insert(schema.priceTicks).values({
  securityId: msft!.id, price: 350, provider: 'verify',
  capturedAt: new Date('2026-09-15T14:35:00Z'), quoteAt: null,
});
const [racer] = (await loadRuleStates(db)).filter((s) => s.ticker === 'MSFT' && s.kind === 'safe');
await runEvaluator(db, { now: new Date('2026-09-15T14:35:00Z') });
let lost: number | null = -1;
try {
  lost = await applyDecision(db, {
    ...racer!, threshold: racer!.threshold!, price: racer!.price!, capturedAt: racer!.capturedAt!,
  }, 'trigger');
} catch { /* a throw is the failure this check exists to catch */ }
check('a losing double-trigger is absorbed by ON CONFLICT, not thrown', lost === null);

await sql`delete from alert_events`;
await sql`delete from price_ticks`;

await sql.end();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
