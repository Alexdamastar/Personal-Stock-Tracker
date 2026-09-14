import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { freshDb, schema } from './harness.js';
import { seed } from '../src/db/seed.js';
import { SEED_ROWS } from '../src/db/seed-data.js';
import { latestValuations, resolvedThresholds } from '../src/db/queries.js';
import type { Db } from '../src/db/seed.js';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => { ({ db, close } = await freshDb()); await seed(db); });
afterEach(async () => { await close(); });

describe('M1 acceptance — SELECT reproduces the §4 seed table exactly', () => {
  it('reproduces every row, column for column', async () => {
    const rows = await db.select({
      ticker: schema.securities.ticker,
      name: schema.securities.name,
      buy: schema.valuations.buyPrice,
      sticker: schema.valuations.stickerPrice,
      method: schema.valuations.method,
      source: schema.valuations.source,
    })
      .from(schema.securities)
      .innerJoin(schema.valuations, eq(schema.valuations.securityId, schema.securities.id))
      .orderBy(asc(schema.securities.id));

    expect(rows).toEqual([
      { ticker: 'AAPL',  name: 'Apple Inc.',      buy: 121.04, sticker: 242.08,  method: 'pbt', source: 'manual' },
      { ticker: 'META',  name: 'Meta Platforms',  buy: 841.77, sticker: 1683.54, method: 'pbt', source: 'manual' },
      { ticker: 'GOOGL', name: 'Alphabet Inc.',   buy: 421.50, sticker: 843.00,  method: 'pbt', source: 'manual' },
      { ticker: 'MSFT',  name: 'Microsoft Corp.', buy: 270.87, sticker: 541.74,  method: 'pbt', source: 'manual' },
      { ticker: 'AMZN',  name: 'Amazon.com Inc.', buy: 209.29, sticker: 418.58,  method: 'pbt', source: 'manual' },
    ]);
  });

  it("derives META's missing sticker as buy/(1-mosPct) = 1683.54, not by hardcoding 2x", async () => {
    const [meta] = await db.select({ sticker: schema.valuations.stickerPrice })
      .from(schema.valuations)
      .innerJoin(schema.securities, eq(schema.securities.id, schema.valuations.securityId))
      .where(eq(schema.securities.ticker, 'META'));
    expect(meta?.sticker).toBe(1683.54);
  });

  it('creates safe rules only where §4 gives one (D3: optional)', async () => {
    const rules = await db.select({ ticker: schema.securities.ticker, value: schema.watchRules.value })
      .from(schema.watchRules)
      .innerJoin(schema.securities, eq(schema.securities.id, schema.watchRules.securityId))
      .where(eq(schema.watchRules.kind, 'safe'))
      .orderBy(asc(schema.securities.ticker));
    expect(rules).toEqual([
      { ticker: 'AAPL', value: 200 }, { ticker: 'AMZN', value: 220 }, { ticker: 'MSFT', value: 400 },
    ]);
  });

  it('records avg_cost for the four §4 rows that have one, and none for AMZN', async () => {
    const rows = await db.select({ ticker: schema.securities.ticker, avgCost: schema.positions.avgCost })
      .from(schema.positions)
      .innerJoin(schema.securities, eq(schema.securities.id, schema.positions.securityId))
      .orderBy(asc(schema.securities.ticker));
    expect(rows).toEqual([
      { ticker: 'AAPL', avgCost: 228.21 }, { ticker: 'GOOGL', avgCost: 239.89 },
      { ticker: 'META', avgCost: 632.78 }, { ticker: 'MSFT', avgCost: 455.69 },
    ]);
    expect(rows.map((r) => r.ticker)).not.toContain('AMZN');
  });

  it('seeds exactly the five §4 securities', async () => {
    const all = await db.select().from(schema.securities);
    expect(all).toHaveLength(SEED_ROWS.length);
    expect(all.every((s) => s.active)).toBe(true);
    expect(all.every((s) => s.maintPct === 0.7)).toBe(true);
  });
});

describe('D1 — a buy rule with value NULL follows the latest PBT valuation', () => {
  it('resolves every buy rule to the seeded PBT price, unpinned', async () => {
    const rows = (await resolvedThresholds(db)).filter((r) => r.kind === 'buy');
    expect(rows.map((r) => [r.ticker, Number(r.threshold), r.pinned])).toEqual([
      ['AAPL', 121.04, false], ['AMZN', 209.29, false], ['GOOGL', 421.5, false],
      ['META', 841.77, false], ['MSFT', 270.87, false],
    ]);
  });

  it('follows a newly APPENDED valuation without any UPDATE to watch_rules', async () => {
    const [aapl] = await db.select().from(schema.securities).where(eq(schema.securities.ticker, 'AAPL'));
    await db.insert(schema.valuations).values({
      securityId: aapl!.id, method: 'pbt', buyPrice: 130.5, stickerPrice: 261,
      source: 'engine', asOf: '2026-11-01',
    });
    const row = (await resolvedThresholds(db)).find((r) => r.ticker === 'AAPL' && r.kind === 'buy');
    expect(Number(row?.threshold)).toBe(130.5);

    // ...and the original row is still there: history of the thesis is preserved (§4).
    const history = await db.select().from(schema.valuations)
      .where(eq(schema.valuations.securityId, aapl!.id));
    expect(history).toHaveLength(2);
  });

  it('a pinned (non-null) buy rule ignores the latest valuation', async () => {
    const [aapl] = await db.select().from(schema.securities).where(eq(schema.securities.ticker, 'AAPL'));
    await db.update(schema.watchRules).set({ value: 99 })
      .where(eq(schema.watchRules.securityId, aapl!.id));
    const row = (await resolvedThresholds(db)).find((r) => r.ticker === 'AAPL' && r.kind === 'buy');
    expect(Number(row?.threshold)).toBe(99);
    expect(row?.pinned).toBe(true);
  });
});

describe('append-only reads', () => {
  it('latestValuations breaks an as_of tie by id, not arbitrarily', async () => {
    const [amzn] = await db.select().from(schema.securities).where(eq(schema.securities.ticker, 'AMZN'));
    // Same as_of as the seed: a restatement ingested the same day (§7.5).
    await db.insert(schema.valuations).values({
      securityId: amzn!.id, method: 'pbt', buyPrice: 211.11, stickerPrice: 422.22,
      source: 'engine', asOf: '2026-08-28',
    });
    const row = (await latestValuations(db)).find((r) => r.ticker === 'AMZN' && r.method === 'pbt');
    expect(Number(row?.buy_price)).toBe(211.11);
  });
});

describe('seed is idempotent and never rewrites history', () => {
  it('a second run inserts no duplicate valuations', async () => {
    const second = await seed(db);
    expect(second.inserted).toEqual([]);
    expect(second.skipped).toEqual(['AAPL', 'META', 'GOOGL', 'MSFT', 'AMZN']);
    expect(await db.select().from(schema.valuations)).toHaveLength(5);
    expect(await db.select().from(schema.securities)).toHaveLength(5);
    expect(await db.select().from(schema.watchRules)).toHaveLength(8); // 5 buy + 3 safe
  });
});
