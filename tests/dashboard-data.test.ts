import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { freshDb, schema } from './harness.js';
import { seed, type Db } from '../src/db/seed.js';
import { resolvedThresholds } from '../src/db/queries.js';
import { loadDashboardData } from '../src/db/dashboard-data.js';
import { DEMO_BAR_COUNT, demoBarDates, refreshDemo, seedDemo } from '../src/db/demo.js';
import type { SecurityData } from '../src/lib/dashboard-types.js';
import { isStale } from '../src/lib/market-hours.js';

// ---------------------------------------------------------------------------------
// loadDashboardData against the real migration (PGlite)
// ---------------------------------------------------------------------------------

describe('M5 — loadDashboardData', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => { ({ db, close } = await freshDb()); await seed(db); });
  afterEach(async () => { await close(); });

  const securityId = async (ticker: string) => {
    const [s] = await db.select().from(schema.securities).where(eq(schema.securities.ticker, ticker));
    return s!.id;
  };
  const ruleId = async (ticker: string, kind: 'safe' | 'buy') => {
    const [r] = await db.select().from(schema.watchRules)
      .where(and(eq(schema.watchRules.securityId, await securityId(ticker)), eq(schema.watchRules.kind, kind)));
    return r!.id;
  };
  const load = async (ticker: string): Promise<SecurityData | undefined> =>
    (await loadDashboardData(db)).securities.find((s) => s.ticker === ticker);
  const rule = (s: SecurityData | undefined, kind: 'safe' | 'buy') => s?.rules.find((r) => r.kind === kind);

  it('returns the 5 seeded securities with D1-resolved thresholds matching the §4 seed', async () => {
    const data = await loadDashboardData(db);
    const summary = data.securities
      .map((s) => ({
        ticker: s.ticker,
        buy: rule(s, 'buy')?.threshold,
        buyPinned: rule(s, 'buy')?.pinned,
        safe: rule(s, 'safe')?.threshold ?? null,
      }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));

    expect(summary).toEqual([
      { ticker: 'AAPL',  buy: 121.04, buyPinned: false, safe: 200 },
      { ticker: 'AMZN',  buy: 209.29, buyPinned: false, safe: 220 },
      { ticker: 'GOOGL', buy: 421.5,  buyPinned: false, safe: null },
      { ticker: 'META',  buy: 841.77, buyPinned: false, safe: null },
      { ticker: 'MSFT',  buy: 270.87, buyPinned: false, safe: 400 },
    ]);
    // A safe rule always carries its own value (D3), so it reports pinned.
    expect(rule(data.securities.find((s) => s.ticker === 'MSFT'), 'safe')?.pinned).toBe(true);
  });

  it('agrees with resolvedThresholds() rule for rule — one definition of D1', async () => {
    const fromLoader = (await loadDashboardData(db)).securities
      .flatMap((s) => s.rules.map((r) => [r.ruleId, r.threshold]))
      .sort();
    const fromQuery = (await resolvedThresholds(db))
      .map((r) => [Number(r.rule_id), r.threshold === null ? null : Number(r.threshold)])
      .sort();
    expect(fromLoader).toEqual(fromQuery);
  });

  it('an appended PBT valuation moves an unpinned buy threshold', async () => {
    await db.insert(schema.valuations).values({
      securityId: await securityId('GOOGL'), method: 'pbt', buyPrice: 399.99, stickerPrice: 799.98,
      source: 'engine', asOf: '2026-09-15',
    });
    expect(rule(await load('GOOGL'), 'buy')).toMatchObject({ threshold: 399.99, pinned: false });
  });

  it('a pinned buy rule keeps its value when a new PBT valuation is appended', async () => {
    await db.update(schema.watchRules).set({ value: 150 }).where(eq(schema.watchRules.id, await ruleId('AAPL', 'buy')));
    await db.insert(schema.valuations).values({
      securityId: await securityId('AAPL'), method: 'pbt', buyPrice: 99, stickerPrice: 198,
      source: 'engine', asOf: '2026-09-15',
    });
    expect(rule(await load('AAPL'), 'buy')).toMatchObject({ threshold: 150, pinned: true });
  });

  it('a buy rule with no PBT valuation has a NULL threshold, not zero', async () => {
    const [nvda] = await db.insert(schema.securities).values({ ticker: 'NVDA', name: 'NVIDIA' }).returning();
    await db.insert(schema.watchRules).values({ securityId: nvda!.id, kind: 'buy', value: null });
    const s = await load('NVDA');
    expect(rule(s, 'buy')).toMatchObject({ threshold: null, pinned: false, openAlert: null });
    expect(s).toMatchObject({ latestTick: null, valuations: {}, bars: [], avgCost: null });
  });

  it('picks the latest tick among several, with numbers and Dates', async () => {
    const id = await securityId('MSFT');
    await db.insert(schema.priceTicks).values([
      { securityId: id, price: 401, provider: 'finnhub', capturedAt: new Date('2026-09-15T14:05:00Z'),
        quoteAt: new Date('2026-09-15T13:45:00Z'), prevClose: 399.5 },
      // Inserted out of order: the newest row is not the last one written.
      { securityId: id, price: 405.25, provider: 'twelvedata', capturedAt: new Date('2026-09-15T14:15:00Z'),
        quoteAt: new Date('2026-09-15T13:56:00Z'), prevClose: 400.1 },
      { securityId: id, price: 403, provider: 'finnhub', capturedAt: new Date('2026-09-15T14:10:00Z'),
        quoteAt: null, prevClose: null },
    ]);

    const tick = (await load('MSFT'))!.latestTick!;
    expect(tick).toEqual({
      price: 405.25,
      prevClose: 400.1,
      capturedAt: new Date('2026-09-15T14:15:00Z'),
      quoteAt: new Date('2026-09-15T13:56:00Z'),
      provider: 'twelvedata',
    });
    // DEFECT-04/13: numerics must not arrive as strings.
    expect(typeof tick.price).toBe('number');
    expect(typeof tick.prevClose).toBe('number');
    expect(tick.capturedAt).toBeInstanceOf(Date);
    expect(tick.quoteAt).toBeInstanceOf(Date);
  });

  it('keeps a NULL quote_at and prev_close null on the latest tick (DEFECT-01, pre-0002 ticks)', async () => {
    await db.insert(schema.priceTicks).values({
      securityId: await securityId('AAPL'), price: 190, provider: 'finnhub',
      capturedAt: new Date('2026-09-15T14:05:00Z'), quoteAt: null,
    });
    expect((await load('AAPL'))!.latestTick).toMatchObject({ quoteAt: null, prevClose: null });
  });

  it('returns the latest valuation per method (as_of desc, id desc)', async () => {
    const id = await securityId('AMZN');
    await db.insert(schema.valuations).values([
      { securityId: id, method: 'mos', buyPrice: 150, stickerPrice: 300, source: 'manual', asOf: '2026-09-01' },
      // Same as_of, written later: the restatement wins on id.
      { securityId: id, method: 'mos', buyPrice: 155, stickerPrice: 310, source: 'engine', asOf: '2026-09-01' },
      // Written last but OLDER as_of: must lose to 2026-09-01.
      { securityId: id, method: 'mos', buyPrice: 140, stickerPrice: 280, source: 'manual', asOf: '2026-08-01' },
      { securityId: id, method: 'ten_cap', buyPrice: 130, stickerPrice: 260, source: 'manual', asOf: '2026-07-01' },
    ]);

    const { valuations } = (await load('AMZN'))!;
    expect(valuations.mos).toEqual({
      buyPrice: 155, stickerPrice: 310, asOf: '2026-09-01', source: 'engine', inputs: null,
    });
    expect(valuations.ten_cap).toMatchObject({ buyPrice: 130, stickerPrice: 260, asOf: '2026-07-01' });
    expect(valuations.pbt).toMatchObject({ buyPrice: 209.29, stickerPrice: 418.58, asOf: '2026-08-28', source: 'manual' });
    // The stored jsonb comes back as an object, not a JSON string.
    expect(valuations.pbt?.inputs).toMatchObject({ fcfPerShare: 14.2956, g: 0.1334 });
    // A method with no valuation is absent, not null.
    expect(Object.keys((await load('MSFT'))!.valuations)).toEqual(['pbt']);
  });

  it('excludes an inactive security', async () => {
    await db.update(schema.securities).set({ active: false }).where(eq(schema.securities.ticker, 'META'));
    const id = await securityId('META');
    await db.insert(schema.priceTicks).values({
      securityId: id, price: 900, provider: 'test', capturedAt: new Date('2026-09-15T14:05:00Z'), quoteAt: null,
    });
    const metaBuy = await ruleId('META', 'buy');
    const data = await loadDashboardData(db);
    expect(data.securities.map((s) => s.ticker).sort()).toEqual(['AAPL', 'AMZN', 'GOOGL', 'MSFT']);
    // Nor do its rules, tick or valuation attach to anything else.
    expect(data.securities.flatMap((s) => s.rules).map((r) => r.ruleId)).not.toContain(metaBuy);
    expect(data.securities.map((s) => s.latestTick)).toEqual([null, null, null, null]);
  });

  it('excludes a disabled rule', async () => {
    await db.update(schema.watchRules).set({ enabled: false })
      .where(eq(schema.watchRules.id, await ruleId('AAPL', 'safe')));
    const aapl = await load('AAPL');
    expect(aapl!.rules.map((r) => r.kind)).toEqual(['buy']);
  });

  it('includes an open alert with the threshold it crossed, and omits a cleared one', async () => {
    // AMZN buy opened at 209.29; since then a new valuation moved the line to 180.
    await db.insert(schema.alertEvents).values({
      ruleId: await ruleId('AMZN', 'buy'), price: 205.5, threshold: 209.29,
      triggeredAt: new Date('2026-09-15T14:10:00Z'),
    });
    await db.insert(schema.valuations).values({
      securityId: await securityId('AMZN'), method: 'pbt', buyPrice: 180, stickerPrice: 360,
      source: 'manual', asOf: '2026-09-15',
    });
    await db.insert(schema.alertEvents).values({
      ruleId: await ruleId('MSFT', 'safe'), price: 399, threshold: 400,
      triggeredAt: new Date('2026-09-15T14:10:00Z'), clearedAt: new Date('2026-09-15T14:25:00Z'),
    });

    const amznBuy = rule(await load('AMZN'), 'buy')!;
    expect(amznBuy.threshold).toBe(180);
    // DEFECT-20: the stored threshold, not the rule's current one.
    expect(amznBuy.openAlert).toEqual({
      eventId: expect.any(Number),
      price: 205.5,
      threshold: 209.29,
      triggeredAt: new Date('2026-09-15T14:10:00Z'),
    });
    expect(rule(await load('AMZN'), 'safe')!.openAlert).toBeNull();
    expect(rule(await load('MSFT'), 'safe')!.openAlert).toBeNull();
  });

  it('caps bars at the 30 most recent and returns them OLDEST first', async () => {
    const id = await securityId('AAPL');
    // 35 consecutive days, inserted newest-first so insertion order cannot pass the test.
    const days = Array.from({ length: 35 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 1 + i));
      return { date: d.toISOString().slice(0, 10), close: 180 + i };
    });
    await db.insert(schema.dailyBars).values(
      [...days].reverse().map((d) => ({ securityId: id, date: d.date, close: d.close, tickCount: 1 })),
    );

    const { bars } = (await load('AAPL'))!;
    expect(bars).toHaveLength(30);
    expect(bars[0]).toEqual({ date: '2026-08-06', close: 185 });
    expect(bars[29]).toEqual({ date: '2026-09-04', close: 214 });
    expect(bars.map((b) => b.date)).toEqual([...bars.map((b) => b.date)].sort());
    expect(typeof bars[0]!.close).toBe('number');
    // Another security's bars never leak in.
    expect((await load('MSFT'))!.bars).toEqual([]);
  });

  it('passes avgCost and the judgment inputs through, null where absent', async () => {
    await db.update(schema.securities).set({ fcfPerShare: 14.2956, growthRate: 0.1334 })
      .where(eq(schema.securities.ticker, 'AMZN'));
    const data = await loadDashboardData(db);
    const by = (t: string) => data.securities.find((s) => s.ticker === t)!;

    expect(by('AMZN').avgCost).toBeNull();
    expect(by('AAPL').avgCost).toBe(228.21);
    expect(by('AMZN').judgment).toEqual({ fcfPerShare: 14.2956, growthRate: 0.1334 });
    expect(by('MSFT').judgment).toEqual({ fcfPerShare: null, growthRate: null });
  });
});

describe('M5 — loadDashboardData query count (no N+1, D4)', () => {
  it('runs the same 5 queries for 5 securities as for 25', async () => {
    const client = new PGlite();
    let queries = 0;
    const counted = drizzle(client, { schema, logger: { logQuery: () => { queries++; } } });
    await migrate(counted, { migrationsFolder: './drizzle' });
    const db = counted as unknown as Db;
    await seed(db);

    try {
      queries = 0;
      await loadDashboardData(db);
      expect(queries).toBe(5);

      for (let i = 0; i < 20; i++) {
        const [s] = await db.insert(schema.securities).values({ ticker: `T${i}`, name: `Ticker ${i}` }).returning();
        await db.insert(schema.watchRules).values({ securityId: s!.id, kind: 'safe', value: 50 });
        await db.insert(schema.priceTicks).values({
          securityId: s!.id, price: 60, provider: 'test', capturedAt: new Date('2026-09-15T14:05:00Z'), quoteAt: null,
        });
        await db.insert(schema.dailyBars).values({ securityId: s!.id, date: '2026-09-14', close: 59 });
      }
      queries = 0;
      const data = await loadDashboardData(db);
      expect(data.securities).toHaveLength(25);
      expect(queries).toBe(5);
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------------
// seedDemo — asserted on RAW rows, not through the view model
// ---------------------------------------------------------------------------------

describe('M5 — seedDemo', () => {
  // A Tuesday, mid-session in New York.
  const NOW = new Date('2026-09-15T15:00:00Z');
  /** First AAPL bar of the demo walk for NOW (2026-08-04). */
  const DEMO_FIRST_AAPL_CLOSE = 213.47;
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await freshDb());
    await seed(db);
    expect(await seedDemo(db, NOW)).toEqual({ seeded: true });
  });
  afterAll(async () => { await close(); });

  const snapshot = async () => {
    const securities = await db.select().from(schema.securities);
    const tickerOf = new Map(securities.map((s) => [s.id, s.ticker]));
    const ticks = await db.select().from(schema.priceTicks);
    const bars = await db.select().from(schema.dailyBars).orderBy(asc(schema.dailyBars.date));
    const thresholds = await resolvedThresholds(db);
    const line = (ticker: string, kind: string) => {
      const t = thresholds.find((r) => r.ticker === ticker && r.kind === kind)?.threshold;
      return t === null || t === undefined ? null : Number(t);
    };
    const priceOf = (ticker: string) => ticks.find((t) => tickerOf.get(t.securityId) === ticker)!.price;
    return { tickerOf, ticks, bars, line, priceOf };
  };

  it('writes one fresh demo tick per ticker: provider demo, polled just before now, quote ~20 minutes older', async () => {
    const { ticks } = await snapshot();
    expect(ticks).toHaveLength(5);
    for (const t of ticks) {
      expect(t.provider).toBe('demo');
      expect(t.capturedAt.toISOString()).toBe('2026-09-15T14:59:00.000Z');
      expect(t.quoteAt!.toISOString()).toBe('2026-09-15T14:39:00.000Z');
      expect(t.prevClose).not.toBeNull();
      // A realistic day: within 5% of the previous close.
      expect(Math.abs(t.price / t.prevClose! - 1)).toBeLessThan(0.05);
    }
  });

  it('puts the tickers in every chip state against the §4 thresholds', async () => {
    const { tickerOf, ticks, line, priceOf } = await snapshot();

    // at_buy: at least one ticker below its buy price.
    expect(ticks.some((t) => t.price < line(tickerOf.get(t.securityId)!, 'buy')!)).toBe(true);
    // at_safe: AAPL below safe 200, above buy 121.04.
    expect(priceOf('AAPL')).toBeLessThan(200);
    expect(priceOf('AAPL')).toBeGreaterThan(121.04);
    // approaching: MSFT within 10% above safe 400.
    expect(priceOf('MSFT')).toBeGreaterThan(400);
    expect((priceOf('MSFT') - 400) / 400).toBeLessThanOrEqual(0.10);
    // watching, far from any line: some ticker more than 25% above every line it has.
    expect(ticks.some((t) => {
      const ticker = tickerOf.get(t.securityId)!;
      return [line(ticker, 'buy'), line(ticker, 'safe')]
        .every((l) => l === null || (t.price - l) / l > 0.25);
    })).toBe(true);
  });

  it('opens alerts through the real evaluator', async () => {
    const open = await db.select({ ticker: schema.securities.ticker, kind: schema.watchRules.kind })
      .from(schema.alertEvents)
      .innerJoin(schema.watchRules, eq(schema.watchRules.id, schema.alertEvents.ruleId))
      .innerJoin(schema.securities, eq(schema.securities.id, schema.watchRules.securityId))
      .where(isNull(schema.alertEvents.clearedAt));
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open).toContainEqual({ ticker: 'AAPL', kind: 'safe' });
  });

  it('writes 30 weekday bars per ticker, ending the session before now at the tick\'s prev_close', async () => {
    const { tickerOf, ticks, bars } = await snapshot();
    const dates = demoBarDates(NOW);
    expect(dates).toHaveLength(DEMO_BAR_COUNT);
    expect(dates[0]).toBe('2026-08-04');
    expect(dates[29]).toBe('2026-09-14');
    expect(dates.every((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))).toBe(true);

    for (const t of ticks) {
      const own = bars.filter((b) => b.securityId === t.securityId);
      expect(own, tickerOf.get(t.securityId)).toHaveLength(30);
      expect(own.map((b) => b.date)).toEqual(dates);
      expect(own[29]!.close).toBe(t.prevClose);
      // A plausible walk: no bar more than 60% away from today's price, high >= low.
      for (const b of own) {
        expect(Math.abs(b.close! / t.price - 1)).toBeLessThan(0.6);
        expect(b.high!).toBeGreaterThanOrEqual(b.low!);
      }
    }
  });

  it('is deterministic: the seeded PRNG draws the same walk on every boot', async () => {
    const { tickerOf, bars } = await snapshot();
    const aapl = bars.filter((b) => tickerOf.get(b.securityId) === 'AAPL');
    // Literal, not recomputed: Math.random() in place of the PRNG fails this.
    expect(aapl[0]!.close).toBe(DEMO_FIRST_AAPL_CLOSE);
  });

  it('does not duplicate anything when run twice', async () => {
    const count = async () => ({
      ticks: (await db.select().from(schema.priceTicks)).length,
      bars: (await db.select().from(schema.dailyBars)).length,
      events: (await db.select().from(schema.alertEvents)).length,
    });
    const before = await count();
    expect(await seedDemo(db, new Date(NOW.getTime() + 5 * 60 * 1000))).toEqual({ seeded: false });
    expect(await count()).toEqual(before);
    expect(before).toMatchObject({ ticks: 5, bars: 150 });
  });
});

// ---------------------------------------------------------------------------------
// refreshDemo — page-load refresh (user decision 2026-09-13)
// ---------------------------------------------------------------------------------

describe('M5 — refreshDemo', () => {
  // Tuesday 11:00 ET; two hours later is still mid-session.
  const BOOT = new Date('2026-09-15T15:00:00Z');
  const LATER = new Date('2026-09-15T17:00:00Z');
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => { ({ db, close } = await freshDb()); await seed(db); await seedDemo(db, BOOT); });
  afterEach(async () => { await close(); });

  it('re-stamps every demo tick to just before the new now, so an open demo tab never goes stale', async () => {
    await refreshDemo(db, LATER);
    const ticks = await db.select().from(schema.priceTicks);
    expect(ticks).toHaveLength(5); // updated in place, not appended
    for (const t of ticks) {
      expect(t.capturedAt.toISOString()).toBe('2026-09-15T16:59:00.000Z');
      expect(t.quoteAt!.toISOString()).toBe('2026-09-15T16:39:00.000Z');
      expect(isStale(t.capturedAt, LATER)).toBe(false);
    }
  });

  it('keeps prices fixed, so every chip state stays on screen', async () => {
    const before = (await db.select().from(schema.priceTicks)).map((t) => [t.securityId, t.price]).sort();
    await refreshDemo(db, LATER);
    const after = (await db.select().from(schema.priceTicks)).map((t) => [t.securityId, t.price]).sort();
    expect(after).toEqual(before);
  });

  it('never moves a stamp backwards when requests race with older clocks', async () => {
    await refreshDemo(db, LATER);
    await refreshDemo(db, BOOT);
    const [t] = await db.select().from(schema.priceTicks);
    expect(t!.capturedAt.toISOString()).toBe('2026-09-15T16:59:00.000Z');
  });

  it('leaves a non-demo tick alone', async () => {
    const [aapl] = await db.select().from(schema.securities).where(eq(schema.securities.ticker, 'AAPL'));
    const real = new Date('2026-09-15T14:00:00Z');
    await db.insert(schema.priceTicks).values({
      securityId: aapl!.id, price: 190, provider: 'finnhub', capturedAt: real, quoteAt: null,
    });
    await refreshDemo(db, LATER);
    const [kept] = await db.select().from(schema.priceTicks)
      .where(eq(schema.priceTicks.provider, 'finnhub'));
    expect(kept!.capturedAt.toISOString()).toBe(real.toISOString());
  });
});

// ---------------------------------------------------------------------------------
// getAppDb — demo mode
// ---------------------------------------------------------------------------------

describe('M5 — getAppDb demo mode (DATABASE_URL unset)', () => {
  const saved = process.env.DATABASE_URL;
  beforeAll(() => { delete process.env.DATABASE_URL; });
  afterAll(async () => {
    const { closeAppDb } = await import('../src/db/app-db.js');
    await closeAppDb();
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  it('boots a migrated, seeded, demo-filled PGlite and shares it across calls', async () => {
    const { getAppDb } = await import('../src/db/app-db.js');
    // Concurrent first calls must share ONE initialization.
    const [a, b] = await Promise.all([getAppDb(), getAppDb()]);
    expect(a.mode).toBe('demo');
    // Identity compared as a boolean: on failure, toBe() would pretty-print two whole
    // drizzle instances and run the worker out of heap instead of reporting a failure.
    expect(b.db === a.db).toBe(true);
    expect((await getAppDb()).db === a.db).toBe(true);

    const data = await loadDashboardData(a.db);
    expect(data.securities).toHaveLength(5);
    expect(data.securities.every((s) => s.latestTick?.provider === 'demo')).toBe(true);
    expect(data.securities.every((s) => s.bars.length === 30)).toBe(true);
  });

  it('survives a module re-evaluation (Next.js hot reload) — the cache lives on globalThis', async () => {
    const first = await (await import('../src/db/app-db.js')).getAppDb();
    vi.resetModules();
    const reloaded = await import('../src/db/app-db.js');
    const second = await reloaded.getAppDb();
    expect(second.db === first.db).toBe(true);
  });
});
