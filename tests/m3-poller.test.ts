import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, schema } from './harness.js';
import { seed, type Db } from '../src/db/seed.js';
import { isAuthorized, runPoll } from '../src/db/poll.js';
import type { FailureKind, Quote, QuoteProvider } from '../src/providers/types.js';

const TUE_10_ET = new Date('2026-10-13T14:00:00Z'); // EDT
const SAT = new Date('2026-10-17T14:00:00Z');

/** A provider that records what it was asked and answers from a fixed table. */
function fake(quotes: Quote[], failures: [string, FailureKind][] = []) {
  const calls: string[][] = [];
  const provider: QuoteProvider = {
    name: 'fake',
    async getQuotes(tickers) { calls.push(tickers); return { quotes, failures: new Map(failures) }; },
  };
  return { provider, calls };
}
const q = (ticker: string, price: number, prevClose: number | null = 300, at: Date | null = null): Quote =>
  ({ ticker, price, prevClose, at, provider: 'fake' });

describe('M3 — runPoll', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => { ({ db, close } = await freshDb()); await seed(db); });
  afterEach(() => close());

  it('outside the session: no provider call, nothing written', async () => {
    const { provider, calls } = fake([q('AAPL', 150)]);
    expect(await runPoll(db, provider, SAT)).toEqual({ status: 'closed' });
    expect(calls).toEqual([]);
    expect(await db.select().from(schema.priceTicks)).toEqual([]);
  });

  it('asks for every active ticker and writes one tick per quote', async () => {
    const stamp = new Date('2026-10-13T13:45:00Z');
    const { provider, calls } = fake([q('AAPL', 342.123456, 340.5, stamp), q('MSFT', 539.44, null)], [['META', 'transient']]);
    const report = await runPoll(db, provider, TUE_10_ET);

    expect(calls[0]?.sort()).toEqual(['AAPL', 'AMZN', 'GOOGL', 'META', 'MSFT']);
    expect(report.status === 'polled' && report.failures).toEqual({ META: 'transient' });
    const ticks = await db.select().from(schema.priceTicks);
    expect(ticks.map((t) => [t.price, t.prevClose, t.quoteAt, t.capturedAt]).sort()).toEqual([
      [342.1235, 340.5, stamp, TUE_10_ET], // rounded to the column's 4 dp; prev_close persisted
      [539.44, null, null, TUE_10_ET],     // missing provider stamp stays null, never now()
    ]);
  });

  it('DEFECT-26: a price that rounds to zero is no_data, and the rest of the batch still lands', async () => {
    const { provider } = fake([q('AAPL', 0.00004), q('MSFT', 500, 0.00004)]);
    const report = await runPoll(db, provider, TUE_10_ET);
    expect(report.status === 'polled' && report.failures).toEqual({ AAPL: 'no_data' });
    const ticks = await db.select().from(schema.priceTicks);
    expect(ticks.map((t) => [t.price, t.prevClose])).toEqual([[500, null]]);
  });

  it('runs the evaluator on the ticks it just wrote', async () => {
    const { provider } = fake([q('AAPL', 150)]); // under AAPL safe 200, above buy 121.04
    const report = await runPoll(db, provider, TUE_10_ET);
    expect(report.status === 'polled' && report.evaluator.triggered.map((t) => [t.ticker, t.kind, t.threshold]))
      .toEqual([['AAPL', 'safe', 200]]);
  });
});

describe('M3 — isAuthorized', () => {
  it.each([
    ['Bearer s3cret', 's3cret', true],
    ['Bearer wrong', 's3cret', false],
    ['s3cret', 's3cret', false],
    [null, 's3cret', false],
    ['Bearer ', '', false],        // unset token fails closed
    ['Bearer x', undefined, false],
  ])('%s vs %s -> %s', (header, token, ok) => {
    expect(isAuthorized(header, token)).toBe(ok);
  });
});
