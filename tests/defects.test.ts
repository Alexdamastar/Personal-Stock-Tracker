import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { freshDb, schema } from './harness.js';
import { seed } from '../src/db/seed.js';
import { rollupDailyBars } from '../src/db/rollup.js';
import type { Db } from '../src/db/seed.js';

let db: Db;
let close: () => Promise<void>;
let amznId: number;

beforeEach(async () => {
  ({ db, close } = await freshDb());
  await seed(db);
  const [amzn] = await db.select().from(schema.securities).where(eq(schema.securities.ticker, 'AMZN'));
  amznId = amzn!.id;
});
afterEach(async () => { await close(); });

const tick = (capturedAt: string, price: number, quoteAt?: string) =>
  db.insert(schema.priceTicks).values({
    securityId: amznId, price, provider: 'finnhub',
    capturedAt: new Date(capturedAt),
    quoteAt: quoteAt ? new Date(quoteAt) : null,
  });

const ruleFor = async (kind: 'safe' | 'buy') => {
  const [r] = await db.select().from(schema.watchRules)
    .where(and(eq(schema.watchRules.securityId, amznId), eq(schema.watchRules.kind, kind)));
  return r!.id;
};

describe('DEFECT-01 - delayed quotes must not collide on the price_ticks PK', () => {
  it('accepts consecutive polls that return the SAME provider timestamp', async () => {
    // 15-20 min delay (D6) + 5-min polling => the same quote stamp repeats ~3-4x.
    const stale = '2026-08-28T13:20:00Z';
    await tick('2026-08-28T13:35:00Z', 266.03, stale);
    await tick('2026-08-28T13:40:00Z', 266.03, stale);
    await tick('2026-08-28T13:45:00Z', 266.03, stale);
    const rows = await db.select().from(schema.priceTicks);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.quoteAt!.toISOString())).size).toBe(1);
  });

  it('still rejects a genuine duplicate poll at the same captured_at', async () => {
    await tick('2026-08-28T13:35:00Z', 266.03);
    await expect(tick('2026-08-28T13:35:00Z', 266.03)).rejects.toThrow();
  });

  it('keeps quote_at available for the M5 stale badge', async () => {
    await tick('2026-08-28T13:35:00Z', 266.03, '2026-08-28T13:14:00Z');
    const [row] = await db.select().from(schema.priceTicks);
    const staleness = row!.capturedAt.getTime() - row!.quoteAt!.getTime();
    // captured_at alone proves only that the poller ran, not that the data is fresh.
    expect(staleness / 60_000).toBe(21);
  });
});

describe('DEFECT-02 - at most one open alert event per rule', () => {
  it('the database rejects a second open event, even from a concurrent retry', async () => {
    const ruleId = await ruleFor('safe');
    await db.insert(schema.alertEvents)
      .values({ ruleId, price: 219, triggeredAt: new Date('2026-08-28T14:00:00Z') });
    await expect(
      db.insert(schema.alertEvents)
        .values({ ruleId, price: 218, triggeredAt: new Date('2026-08-28T14:05:00Z') }),
    ).rejects.toThrow();
    expect(await db.select().from(schema.alertEvents)).toHaveLength(1);
  });

  it('allows a new event once the previous one is cleared', async () => {
    const ruleId = await ruleFor('safe');
    const [first] = await db.insert(schema.alertEvents)
      .values({ ruleId, price: 219, triggeredAt: new Date('2026-08-28T14:00:00Z') }).returning();
    await db.update(schema.alertEvents)
      .set({ clearedAt: new Date('2026-08-28T15:00:00Z') })
      .where(eq(schema.alertEvents.id, first!.id));
    await db.insert(schema.alertEvents)
      .values({ ruleId, price: 217, triggeredAt: new Date('2026-08-29T14:00:00Z') });
    expect(await db.select().from(schema.alertEvents)).toHaveLength(2);
  });

  it('two different rules may each hold an open event', async () => {
    await db.insert(schema.alertEvents).values([
      { ruleId: await ruleFor('safe'), price: 219, triggeredAt: new Date('2026-08-28T14:00:00Z') },
      { ruleId: await ruleFor('buy'), price: 208, triggeredAt: new Date('2026-08-28T14:00:00Z') },
    ]);
    expect(await db.select().from(schema.alertEvents)).toHaveLength(2);
  });

  it('rejects a cleared_at that precedes triggered_at', async () => {
    const ruleId = await ruleFor('safe');
    await expect(db.insert(schema.alertEvents).values({
      ruleId, price: 219,
      triggeredAt: new Date('2026-08-28T15:00:00Z'),
      clearedAt: new Date('2026-08-28T14:00:00Z'),
    })).rejects.toThrow();
  });
});

describe('DEFECT-04 - numeric columns arrive as numbers, not strings', () => {
  it('arithmetic on a price behaves as arithmetic', async () => {
    const [v] = await db.select().from(schema.valuations)
      .where(eq(schema.valuations.securityId, amznId));
    expect(typeof v!.buyPrice).toBe('number');
    // The bug this guards: "209.29" + 1 === "209.291"
    expect(v!.buyPrice + 1).toBe(210.29);
    expect(typeof v!.mosPct).toBe('number');
    const [p] = await db.select().from(schema.positions);
    expect(typeof p!.avgCost).toBe('number');
  });

  it('round-trips at the declared scale without drift', async () => {
    await tick('2026-08-28T13:35:00Z', 266.0349);
    const [row] = await db.select().from(schema.priceTicks);
    expect(row!.price).toBe(266.0349);
  });
});

describe('DEFECT-05 - daily_bars has a writer, bucketed in America/New_York', () => {
  it('rolls ticks into a bar and excludes out-of-session ticks', async () => {
    await tick('2026-08-28T11:00:00Z', 260.0); // 07:00 EDT - pre-market, excluded
    await tick('2026-08-28T13:35:00Z', 266.0); // 09:35 EDT - open
    await tick('2026-08-28T16:00:00Z', 270.5); // 12:00 EDT - high
    await tick('2026-08-28T17:00:00Z', 261.5); // 13:00 EDT - low
    await tick('2026-08-28T19:55:00Z', 268.0); // 15:55 EDT - close
    await tick('2026-08-28T21:00:00Z', 999.0); // 17:00 EDT - after hours, excluded

    await rollupDailyBars(db);
    const [bar] = await db.select().from(schema.dailyBars);
    expect(bar).toMatchObject({
      date: '2026-08-28', open: 266.0, high: 270.5, low: 261.5, close: 268.0, tickCount: 4,
    });
  });

  it('handles DST: the same UTC hour is in-session in August and out in December', async () => {
    await tick('2026-08-28T13:35:00Z', 266.0); // 09:35 EDT (UTC-4) - in session
    await tick('2026-12-15T13:35:00Z', 300.0); // 08:35 EST (UTC-5) - pre-market
    await tick('2026-12-15T14:35:00Z', 301.0); // 09:35 EST - in session
    await rollupDailyBars(db);
    const bars = await db.select().from(schema.dailyBars).orderBy(asc(schema.dailyBars.date));
    expect(bars.map((b) => [b.date, b.tickCount, b.open])).toEqual([
      ['2026-08-28', 1, 266.0],
      ['2026-12-15', 1, 301.0], // the 08:35 EST tick is correctly excluded
    ]);
  });

  it('is idempotent - re-running updates rather than duplicating', async () => {
    await tick('2026-08-28T13:35:00Z', 266.0);
    await rollupDailyBars(db);
    await tick('2026-08-28T19:55:00Z', 268.0);
    await rollupDailyBars(db);
    const bars = await db.select().from(schema.dailyBars);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ open: 266.0, close: 268.0, tickCount: 2 });
  });
});

describe('DEFECT-12 - per-security judgment inputs have a home', () => {
  it('stores manual g and fcfPerShare alongside maintPct', async () => {
    await db.update(schema.securities)
      .set({ growthRate: 0.1334, fcfPerShare: 14.2956 })
      .where(eq(schema.securities.id, amznId));
    const [s] = await db.select().from(schema.securities).where(eq(schema.securities.id, amznId));
    expect(s).toMatchObject({
      maintPct: 0.7, growthRate: 0.1334, fcfPerShare: 14.2956, marr: 0.15, pbtYears: 8,
    });
  });
});

describe('data integrity - CHECK constraints reject nonsense at the boundary', () => {
  it('rejects an unknown valuation method', async () => {
    await expect(db.insert(schema.valuations).values({
      securityId: amznId, method: 'dcf', buyPrice: 1, stickerPrice: 2,
      source: 'manual', asOf: '2026-08-28',
    })).rejects.toThrow();
  });

  it('rejects an unknown valuation source', async () => {
    await expect(db.insert(schema.valuations).values({
      securityId: amznId, method: 'pbt', buyPrice: 1, stickerPrice: 2,
      source: 'guess', asOf: '2026-08-28',
    })).rejects.toThrow();
  });

  it('rejects a safe rule with no value (D3: safe prices are explicit numbers)', async () => {
    await expect(db.insert(schema.watchRules)
      .values({ securityId: amznId, kind: 'safe', value: null })).rejects.toThrow();
  });

  it('rejects a non-positive price tick', async () => {
    await expect(tick('2026-08-28T13:35:00Z', 0)).rejects.toThrow();
  });

  it('rejects a duplicate rule of the same kind for one security', async () => {
    await expect(db.insert(schema.watchRules)
      .values({ securityId: amznId, kind: 'safe', value: 210 })).rejects.toThrow();
  });
});
