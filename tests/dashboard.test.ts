import { describe, expect, it } from 'vitest';
import { buildDashboardRows } from '../src/lib/dashboard.js';
import type {
  DashboardData, DashboardDeps, DashboardRow, RuleData, SecurityData, TickData,
} from '../src/lib/dashboard-types.js';
import { AMZN_FIXTURE_INPUT, SEED_AS_OF, SEED_ROWS, resolvedSticker } from '../src/db/seed-data.js';

const NOW = new Date('2026-09-11T15:00:00Z');
const NEVER_STALE: DashboardDeps = { isStale: () => false };

/**
 * The §4 seed as the loader would read it: one PBT valuation per security, a
 * follow-the-valuation buy rule (value NULL), a safe rule only where one is set, no
 * ticks. Mirrors src/db/seed.ts, including AMZN's inputs and the others' `note`.
 */
function seeded(): DashboardData {
  return {
    securities: SEED_ROWS.map((row, i): SecurityData => {
      const rules: RuleData[] = [
        { ruleId: 100 + i, kind: 'buy', threshold: row.buy, pinned: false, openAlert: null },
      ];
      if (row.safe !== null) {
        rules.push({ ruleId: 200 + i, kind: 'safe', threshold: row.safe, pinned: true, openAlert: null });
      }
      return {
        securityId: i + 1,
        ticker: row.ticker,
        name: row.name,
        latestTick: null,
        rules,
        valuations: {
          pbt: {
            buyPrice: row.buy,
            stickerPrice: resolvedSticker(row),
            asOf: SEED_AS_OF,
            source: 'manual',
            inputs: row.ticker === 'AMZN'
              ? { provenance: 'rule1-toolbox-panel', ...AMZN_FIXTURE_INPUT }
              : { provenance: 'rule1-toolbox-panel', note: 'full input panel not captured (§9)' },
          },
        },
        judgment: { fcfPerShare: null, growthRate: null },
        avgCost: row.avgCost,
        bars: [],
      };
    }),
  };
}

const tick = (price: number, extra: Partial<TickData> = {}): TickData => ({
  price,
  prevClose: null,
  capturedAt: new Date('2026-09-11T14:55:00Z'),
  quoteAt: null,
  provider: 'finnhub',
  ...extra,
});

function sec(data: DashboardData, ticker: string): SecurityData {
  const s = data.securities.find((x) => x.ticker === ticker);
  if (!s) throw new Error(`no ${ticker} in fixture`);
  return s;
}

function row(rows: DashboardRow[], ticker: string): DashboardRow {
  const r = rows.find((x) => x.ticker === ticker);
  if (!r) throw new Error(`no ${ticker} row`);
  return r;
}

/** Seeded data with a price set on each ticker given. */
function withPrices(prices: Record<string, number>): DashboardData {
  const data = seeded();
  for (const [ticker, price] of Object.entries(prices)) sec(data, ticker).latestTick = tick(price);
  return data;
}

const build = (data: DashboardData, deps: DashboardDeps = NEVER_STALE) =>
  buildDashboardRows(data, NOW, deps);

const chipAt = (ticker: string, price: number) => row(build(withPrices({ [ticker]: price })), ticker).chip;

describe('M5 acceptance — view model', () => {
  it('seeded data + an AAPL tick at 195.00 -> AAPL is at_safe and sorts first', () => {
    const rows = build(withPrices({ AAPL: 195.0 }));
    expect(rows[0]?.ticker).toBe('AAPL');
    expect(rows[0]?.chip).toBe('at_safe');
    expect(rows[0]?.sortKey).toBe(-0.025);
  });

  it('still first when every other ticker has a price too', () => {
    const rows = build(withPrices({ AAPL: 195, META: 900, GOOGL: 450, MSFT: 410, AMZN: 266.03 }));
    expect(rows.map((r) => r.ticker)).toEqual(['AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN']);
    expect(rows.map((r) => r.chip)).toEqual(['at_safe', 'approaching', 'approaching', 'approaching', 'watching']);
  });
});

describe('M5 — chip', () => {
  it('no price -> watching', () => {
    expect(row(build(seeded()), 'AAPL').chip).toBe('watching');
  });

  it('far above every line -> watching', () => {
    expect(chipAt('AAPL', 300)).toBe('watching');
  });

  it('price exactly at the safe line is at_safe', () => {
    expect(chipAt('MSFT', 400)).toBe('at_safe');
  });

  it('price exactly at the buy line is at_buy', () => {
    expect(chipAt('META', 841.77)).toBe('at_buy');
  });

  it('one ten-thousandth above a line is not at it', () => {
    expect(chipAt('META', 841.7701)).toBe('approaching');
  });

  it('below both lines -> at_buy wins over at_safe', () => {
    // AMZN buy 209.29 < safe 220; 200 is under both.
    expect(chipAt('AMZN', 200)).toBe('at_buy');
    // Between the lines is only at_safe.
    expect(chipAt('AMZN', 215)).toBe('at_safe');
  });

  it('DEFECT-21: the line comparison is exact at 4dp, not floating point', () => {
    // 400 * 1.005 === 401.99999999999994; a safe line stored as that float is 402.0000.
    const data = withPrices({ MSFT: 402 });
    sec(data, 'MSFT').rules = sec(data, 'MSFT').rules.map((r) =>
      r.kind === 'safe' ? { ...r, threshold: 400 * 1.005 } : r);
    expect(row(build(data), 'MSFT').chip).toBe('at_safe');
  });

  describe('approaching boundary: (price - t) / t <= 0.10', () => {
    it('exactly 10% above the safe line is approaching', () => {
      expect(chipAt('AAPL', 220)).toBe('approaching');
    });
    it('just over 10% is watching', () => {
      expect(chipAt('AAPL', 220.0001)).toBe('watching');
    });
    it('exactly 10% above META buy 841.77 (925.947), where the float ratio is over 0.10', () => {
      // The trap the integer maths avoids: the naive ratio misses the boundary.
      expect((925.947 - 841.77) / 841.77).toBe(0.10000000000000003);
      expect(chipAt('META', 925.947)).toBe('approaching');
      expect(chipAt('META', 925.9471)).toBe('watching');
    });
    it('the buy line alone can make a row approaching', () => {
      // AMZN at 225 is +2.3% over safe 220 and +7.5% over buy 209.29. Drop the safe
      // rule so only the buy line is left to be near.
      const data = withPrices({ AMZN: 225 });
      sec(data, 'AMZN').rules = sec(data, 'AMZN').rules.filter((r) => r.kind === 'buy');
      expect(row(build(data), 'AMZN').chip).toBe('approaching');
    });
  });
});

describe('M5 — an unresolved buy rule is never zero (D1)', () => {
  /** GOOGL with no PBT valuation yet: buy rule present, threshold null. */
  function unresolvedGoogl(price: number | null): DashboardRow {
    const data = seeded();
    const g = sec(data, 'GOOGL');
    g.rules = [{ ruleId: 1, kind: 'buy', threshold: null, pinned: false, openAlert: null }];
    g.valuations = {};
    if (price !== null) g.latestTick = tick(price);
    return row(build(data), 'GOOGL');
  }

  it('renders the rule with a null threshold and no distance', () => {
    expect(unresolvedGoogl(100).buy).toEqual({ threshold: null, pinned: false, distance: null });
  });

  it('does not drive the chip: a price near zero is not at_buy or approaching', () => {
    // Treated as 0, any price would be "above the line" and 0.0001 would be at it.
    expect(unresolvedGoogl(0.0001).chip).toBe('watching');
    expect(unresolvedGoogl(100).chip).toBe('watching');
  });

  it('has no sortKey and no sparkline line', () => {
    const r = unresolvedGoogl(100);
    expect(r.sortKey).toBeNull();
    expect(r.sparkline.buy).toBeNull();
  });

  it('sorts after a resolved row, even one far from its line', () => {
    const data = withPrices({ META: 5000, GOOGL: 100 });
    sec(data, 'GOOGL').rules = [{ ruleId: 1, kind: 'buy', threshold: null, pinned: false, openAlert: null }];
    const tickers = build(data).map((r) => r.ticker);
    expect(tickers.indexOf('META')).toBeLessThan(tickers.indexOf('GOOGL'));
  });

  it('a safe rule still works alongside an unresolved buy rule', () => {
    const data = withPrices({ MSFT: 390 });
    sec(data, 'MSFT').rules = sec(data, 'MSFT').rules.map((r) =>
      r.kind === 'buy' ? { ...r, threshold: null } : r);
    const r = row(build(data), 'MSFT');
    expect(r.chip).toBe('at_safe');
    expect(r.sortKey).toBe(-0.025);
    expect(r.sparkline).toEqual({ points: [], safe: 400, buy: null });
  });

  it('a pinned zero is not a line either (watch_rules.value has no > 0 CHECK)', () => {
    const data = withPrices({ META: 900 });
    sec(data, 'META').rules = [{ ruleId: 1, kind: 'buy', threshold: 0, pinned: true, openAlert: null }];
    const r = row(build(data), 'META');
    expect(r.chip).toBe('watching');
    expect(r.sortKey).toBeNull();
    expect(r.buy).toEqual({ threshold: null, pinned: true, distance: null });
  });
});

describe('M5 — distances and sortKey (DEFECT-10)', () => {
  it('distance to each line, in dollars and as a fraction', () => {
    const r = row(build(withPrices({ MSFT: 410 })), 'MSFT');
    expect(r.safe).toEqual({ threshold: 400, distance: { dollars: 10, pct: 0.025 } });
    expect(r.buy?.threshold).toBe(270.87);
    expect(r.buy?.pinned).toBe(false);
    expect(r.buy?.distance?.dollars).toBe(139.13);
    expect(r.buy?.distance?.pct).toBeCloseTo(139.13 / 270.87, 12);
    expect(r.sortKey).toBe(0.025); // min of the two
  });

  it('no safe rule -> safe is null; no price -> distances are null', () => {
    const r = row(build(seeded()), 'META');
    expect(r.safe).toBeNull();
    expect(r.buy).toEqual({ threshold: 841.77, pinned: false, distance: null });
    expect(r.sortKey).toBeNull();
    expect(row(build(seeded()), 'AAPL').safe).toEqual({ threshold: 200, distance: null });
  });

  it('no enabled buy rule -> buy is null', () => {
    const data = seeded();
    sec(data, 'AAPL').rules = sec(data, 'AAPL').rules.filter((r) => r.kind === 'safe');
    expect(row(build(data), 'AAPL').buy).toBeNull();
  });

  it('sorts ascending, null last, ties by ticker', () => {
    // MSFT and AAPL both exactly 2.5% below safe; ties must fall to the ticker, and
    // the integer distance maths makes 390/400 and 195/200 the identical double.
    const rows = build(withPrices({ MSFT: 390, AAPL: 195, AMZN: 230 }));
    expect(rows.map((r) => r.ticker)).toEqual(['AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META']);
    expect(rows.slice(3).map((r) => r.sortKey)).toEqual([null, null]);
  });

  it('null rows are ordered by ticker regardless of input order', () => {
    const data = seeded();
    data.securities.reverse();
    expect(build(data).map((r) => r.ticker)).toEqual(['AAPL', 'AMZN', 'GOOGL', 'META', 'MSFT']);
  });

  it('a null row placed first in the input still sorts after a keyed row', () => {
    const data = withPrices({ MSFT: 1000 });
    expect(build(data).map((r) => r.ticker)).toEqual(['MSFT', 'AAPL', 'AMZN', 'GOOGL', 'META']);
  });
});

describe('M5 — pbtYearsAtPrice', () => {
  it('AMZN reads its PBT valuation inputs and matches the §3.4 golden value at 266.03', () => {
    const r = row(build(withPrices({ AMZN: AMZN_FIXTURE_INPUT.lastPrice })), 'AMZN');
    // tests/valuation.test.ts pbtYearsAtLastPrice: 9.26 +/- 0.02
    expect(Math.abs((r.pbtYearsAtPrice ?? 0) - 9.26)).toBeLessThanOrEqual(0.02);
  });

  it('valuation inputs win over judgment inputs', () => {
    const data = withPrices({ AMZN: 266.03 });
    sec(data, 'AMZN').judgment = { fcfPerShare: 1, growthRate: 0 };
    expect(row(build(data), 'AMZN').pbtYearsAtPrice).toBeCloseTo(9.26, 1);
  });

  it('falls back to judgment inputs when the valuation carries none (seeded META note)', () => {
    const data = withPrices({ META: 300 });
    sec(data, 'META').judgment = { fcfPerShare: 100, growthRate: 0 };
    // FCF 100/yr flat: 300 is recouped in exactly 3 years.
    expect(row(build(data), 'META').pbtYearsAtPrice).toBe(3);
  });

  it('does not mix sources: a valuation with fcfPerShare but no g uses judgment entirely', () => {
    const data = withPrices({ META: 300 });
    const m = sec(data, 'META');
    m.valuations = { pbt: { ...m.valuations.pbt!, inputs: { fcfPerShare: 1 } } };
    m.judgment = { fcfPerShare: 100, growthRate: 0 };
    expect(row(build(data), 'META').pbtYearsAtPrice).toBe(3);
  });

  it.each([
    ['null', null],
    ['an array', [14.2956, 0.1334]],
    ['a string', '{"fcfPerShare":14.2956,"g":0.1334}'],
    ['string-typed numbers', { fcfPerShare: '14.2956', g: '0.1334' }],
    ['a NaN', { fcfPerShare: Number.NaN, g: 0.1 }],
  ])('rejects valuation inputs that are %s', (_, inputs) => {
    const data = withPrices({ AMZN: 266.03 });
    const a = sec(data, 'AMZN');
    a.valuations = { pbt: { ...a.valuations.pbt!, inputs } };
    expect(row(build(data), 'AMZN').pbtYearsAtPrice).toBeNull();
  });

  it('neither source -> null; only one judgment input -> null', () => {
    expect(row(build(withPrices({ META: 900 })), 'META').pbtYearsAtPrice).toBeNull();
    const data = withPrices({ META: 900 });
    sec(data, 'META').judgment = { fcfPerShare: 20, growthRate: null };
    expect(row(build(data), 'META').pbtYearsAtPrice).toBeNull();
  });

  it('no price -> null, even with inputs', () => {
    expect(row(build(seeded()), 'AMZN').pbtYearsAtPrice).toBeNull();
  });

  it('Infinity passes through (FCF <= 0)', () => {
    const data = withPrices({ META: 900 });
    sec(data, 'META').judgment = { fcfPerShare: -5, growthRate: 0.1 };
    expect(row(build(data), 'META').pbtYearsAtPrice).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('M5 — tick-derived fields', () => {
  it('changePct from the provider previous close', () => {
    const data = seeded();
    sec(data, 'MSFT').latestTick = tick(420, { prevClose: 400 });
    expect(row(build(data), 'MSFT').changePct).toBe(0.05);
  });

  it.each([
    ['no tick', null],
    ['no prevClose', tick(420, { prevClose: null })],
    ['a zero prevClose', tick(420, { prevClose: 0 })],
    ['a negative prevClose', tick(420, { prevClose: -1 })],
  ])('changePct is null with %s', (_, t) => {
    const data = seeded();
    sec(data, 'MSFT').latestTick = t;
    expect(row(build(data), 'MSFT').changePct).toBeNull();
  });

  it('stale is whatever isStale says, given capturedAt (never quoteAt) and now', () => {
    const capturedAt = new Date('2026-09-11T14:00:00Z');
    const quoteAt = new Date('2026-09-11T14:59:00Z');
    const data = seeded();
    sec(data, 'MSFT').latestTick = tick(420, { capturedAt, quoteAt });
    const calls: [Date | null, Date][] = [];
    const rows = buildDashboardRows(data, NOW, {
      isStale: (c, n) => { calls.push([c, n]); return c !== null; },
    });
    expect(row(rows, 'MSFT').stale).toBe(true);
    expect(row(rows, 'AAPL').stale).toBe(false);
    expect(calls).toContainEqual([capturedAt, NOW]);
    expect(calls).toContainEqual([null, NOW]);
    expect(calls).toHaveLength(5);
  });

  it('quoteAgeMs = now - quoteAt, or null', () => {
    const data = seeded();
    sec(data, 'MSFT').latestTick = tick(420, { quoteAt: new Date(NOW.getTime() - 20 * 60_000) });
    sec(data, 'AAPL').latestTick = tick(210);
    const rows = build(data);
    expect(row(rows, 'MSFT').quoteAgeMs).toBe(1_200_000);
    expect(row(rows, 'AAPL').quoteAgeMs).toBeNull();
    expect(row(rows, 'META').quoteAgeMs).toBeNull();
  });

  it('a NaN price (Postgres numeric accepts NaN, and NaN > 0 there) is shown as no price', () => {
    const r = row(build(withPrices({ MSFT: Number.NaN })), 'MSFT');
    expect(r.price).toBeNull();
    expect(r.chip).toBe('watching');
    expect(r.sortKey).toBeNull();
  });
});

describe('M5 — passthrough fields', () => {
  it('open alerts use the stored threshold, apart from the chip', () => {
    const triggeredAt = new Date('2026-09-10T15:00:00Z');
    const data = withPrices({ MSFT: 450 });
    sec(data, 'MSFT').rules = sec(data, 'MSFT').rules.map((r) => r.kind === 'safe'
      ? { ...r, openAlert: { eventId: 7, price: 399, threshold: 405, triggeredAt } }
      : r);
    const r = row(build(data), 'MSFT');
    expect(r.openAlerts).toEqual([{ kind: 'safe', threshold: 405, triggeredAt }]);
    expect(r.chip).toBe('watching'); // price-driven: 450 is 12.5% above safe 400
    expect(row(build(data), 'AAPL').openAlerts).toEqual([]);
  });

  it('secondary lists all three methods, null where absent', () => {
    const data = seeded();
    sec(data, 'AMZN').valuations.ten_cap = {
      buyPrice: 62.23, stickerPrice: 124.46, asOf: SEED_AS_OF, source: 'manual', inputs: {},
    };
    const rows = build(data);
    expect(row(rows, 'AMZN').secondary).toEqual({
      pbt: { price: 209.29, sticker: 418.58 },
      mos: null,
      ten_cap: { price: 62.23, sticker: 124.46 },
    });
    expect(row(rows, 'META').secondary.pbt).toEqual({ price: 841.77, sticker: 1683.54 });
  });

  it('sparkline carries the bars and both resolved lines', () => {
    const data = seeded();
    const bars = [{ date: '2026-09-09', close: 262 }, { date: '2026-09-10', close: 266.03 }];
    sec(data, 'AMZN').bars = bars;
    expect(row(build(data), 'AMZN').sparkline).toEqual({ points: bars, safe: 220, buy: 209.29 });
  });

  it('identity and avgCost pass through', () => {
    const r = row(build(seeded()), 'AAPL');
    expect(r).toMatchObject({ securityId: 1, ticker: 'AAPL', name: 'Apple Inc.', avgCost: 228.21, price: null });
    expect(row(build(seeded()), 'AMZN').avgCost).toBeNull();
  });
});

describe('M5 — purity', () => {
  it('does not mutate its input, and rows do not alias it', () => {
    const data = withPrices({ AAPL: 195, MSFT: 410 });
    sec(data, 'AMZN').bars = [{ date: '2026-09-10', close: 266.03 }];
    data.securities.reverse();
    const before = structuredClone(data);

    const rows = build(data);
    expect(data).toEqual(before);

    row(rows, 'AMZN').sparkline.points[0]!.close = -1;
    row(rows, 'AMZN').sparkline.points.push({ date: 'x', close: 0 });
    expect(data).toEqual(before);
  });

  it('is deterministic for the same input and now', () => {
    const data = withPrices({ AAPL: 195, META: 900 });
    expect(build(data)).toEqual(build(data));
  });
});
