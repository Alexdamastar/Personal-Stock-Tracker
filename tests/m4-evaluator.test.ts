import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { freshDb, schema } from './harness.js';
import { seed } from '../src/db/seed.js';
import { resolvedThresholds } from '../src/db/queries.js';
import { applyDecision, loadRuleStates, runEvaluator } from '../src/db/alerts.js';
import { evaluate, type Decision, type OpenEvent } from '../src/lib/evaluate.js';
import type { Db } from '../src/db/seed.js';

/** Runs a price series through the pure evaluator, carrying open-event state forward. */
function replay(threshold: number, series: number[]): Decision[] {
  let open: OpenEvent = null;
  return series.map((price, i) => {
    const d = evaluate({ threshold }, price, open);
    if (d === 'trigger') open = { id: i };
    if (d === 'clear') open = null;
    return d;
  });
}

describe('M4 acceptance — pure evaluator', () => {
  it('replays [410, 401, 399, 399.5, 398, 405, 402] against 400 -> exactly one trigger and one clear', () => {
    const decisions = replay(400, [410, 401, 399, 399.5, 398, 405, 402]);
    expect(decisions.filter((d) => d === 'trigger')).toHaveLength(1);
    expect(decisions.filter((d) => d === 'clear')).toHaveLength(1);
    // And at the right moments: 399 opens it, 405 is the first price above 402.
    expect(decisions).toEqual(['none', 'none', 'trigger', 'none', 'none', 'clear', 'none']);
  });
});

describe('M4 — evaluate()', () => {
  it('triggers at exact equality (price <= threshold)', () => {
    expect(evaluate({ threshold: 400 }, 400, null)).toBe('trigger');
  });

  it('does not re-trigger while an event is already open', () => {
    expect(evaluate({ threshold: 400 }, 390, { id: 1 })).toBe('none');
  });

  it('does not clear inside the 0.5% band', () => {
    expect(evaluate({ threshold: 400 }, 401, { id: 1 })).toBe('none');
  });

  it('does not chatter: a price hovering around the line opens one event and never closes it', () => {
    const decisions = replay(400, [399.9, 401, 399.9, 401.5, 400, 401.99]);
    expect(decisions.filter((d) => d !== 'none')).toEqual(['trigger']);
  });

  describe('DEFECT-21 — the hysteresis boundary is exact, not floating point', () => {
    it('documents the bug: in IEEE-754, 402 > 400 * 1.005', () => {
      // If this ever fails, the platform changed — not the evaluator.
      expect(400 * 1.005).toBe(401.99999999999994);
      expect(402 > 400 * 1.005).toBe(true);
    });

    it.each([
      ['MSFT safe', 400, 402],
      ['AAPL safe', 200, 201],
      ['AMZN safe', 220, 221.1],
    ])('%s: a price of exactly threshold x 1.005 does NOT clear (%d -> %d)', (_, threshold, boundary) => {
      expect(evaluate({ threshold }, boundary, { id: 1 })).toBe('none');
    });

    it('one ten-thousandth above the boundary does clear', () => {
      expect(evaluate({ threshold: 400 }, 402.0001, { id: 1 })).toBe('clear');
      expect(evaluate({ threshold: 220 }, 221.1001, { id: 1 })).toBe('clear');
    });
  });

  it('a null threshold never triggers and never clears — it is not zero', () => {
    // A buy rule with no PBT valuation yet (D1). Treated as 0 it would clear every
    // open event and could never fire, silently disabling the rule.
    expect(evaluate({ threshold: null }, 100, null)).toBe('none');
    expect(evaluate({ threshold: null }, 100, { id: 1 })).toBe('none');
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('ignores an unusable price or threshold (%s)', (bad) => {
    expect(evaluate({ threshold: 400 }, bad, null)).toBe('none');
    expect(evaluate({ threshold: 400 }, bad, { id: 1 })).toBe('none');
    expect(evaluate({ threshold: bad }, 100, null)).toBe('none');
  });
});

// ---------------------------------------------------------------------------------
// runEvaluator against the real migration (PGlite)
// ---------------------------------------------------------------------------------

describe('M4 — runEvaluator', () => {
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
  const tick = async (ticker: string, at: string, price: number) =>
    db.insert(schema.priceTicks).values({
      securityId: await securityId(ticker), price, provider: 'test', capturedAt: new Date(at), quoteAt: null,
    });
  const eventsFor = async (ticker: string, kind: 'safe' | 'buy') =>
    db.select().from(schema.alertEvents).where(eq(schema.alertEvents.ruleId, await ruleId(ticker, kind)));

  /** 5-minute polls from 14:00Z, like M3 will write them. */
  const pollAt = (i: number) => new Date(Date.UTC(2026, 8, 15, 14, 5 * i)).toISOString();

  it('M4 acceptance through the database: the replay series yields one event, opened and closed', async () => {
    const series = [410, 401, 399, 399.5, 398, 405, 402];
    for (const [i, price] of series.entries()) {
      await tick('MSFT', pollAt(i), price);
      await runEvaluator(db, { now: new Date(pollAt(i)) });
    }

    const events = await eventsFor('MSFT', 'safe');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ price: 399, threshold: 400 });
    // Timestamps are the tick's, not the wall clock's — replay is deterministic.
    expect(events[0]!.triggeredAt.toISOString()).toBe(pollAt(2));
    expect(events[0]!.clearedAt!.toISOString()).toBe(pollAt(5));
  });

  it('records the threshold crossed, and judges an open event by where the line is NOW', async () => {
    // AMZN buy follows the latest PBT valuation: 209.29 (D1).
    await tick('AMZN', pollAt(0), 209);
    const first = await runEvaluator(db, { now: new Date(pollAt(0)) });
    expect(first.triggered.find((t) => t.kind === 'buy')).toMatchObject({ threshold: 209.29, price: 209 });

    // A new valuation moves the buy line down to 180. Price has not moved.
    await db.insert(schema.valuations).values({
      securityId: await securityId('AMZN'), method: 'pbt', buyPrice: 180, stickerPrice: 360,
      source: 'manual', asOf: '2026-09-15',
    });
    await tick('AMZN', pollAt(1), 209);
    const second = await runEvaluator(db, { now: new Date(pollAt(1)) });

    // Decision 2026-09-13: 209 > 180 x 1.005, so it clears against the current line...
    expect(second.cleared.map((c) => c.kind)).toEqual(['buy']);
    // ...and the log still says what it originally fired against.
    const [event] = await eventsFor('AMZN', 'buy');
    expect(event).toMatchObject({ threshold: 209.29, price: 209 });
    expect(event!.clearedAt).not.toBeNull();
  });

  it('is idempotent: re-running on the same tick changes nothing', async () => {
    await tick('MSFT', pollAt(0), 399);
    const now = new Date(pollAt(0));
    await runEvaluator(db, { now });
    const again = await runEvaluator(db, { now });

    expect(again.triggered).toHaveLength(0);
    expect(again.cleared).toHaveLength(0);
    expect(await eventsFor('MSFT', 'safe')).toHaveLength(1);
  });

  it('a run that lost a race is absorbed by the partial unique index, not thrown', async () => {
    // Two overlapping runs both read "no open event" (DEFECT-02).
    await tick('MSFT', pollAt(0), 399);
    const staleRead = (await loadRuleStates(db)).find((s) => s.ticker === 'MSFT' && s.kind === 'safe')!;
    await runEvaluator(db, { now: new Date(pollAt(0)) }); // the other run wins

    const losing = await applyDecision(db, {
      ...staleRead, threshold: staleRead.threshold!, price: staleRead.price!, capturedAt: staleRead.capturedAt!,
    }, 'trigger');
    expect(losing).toBeNull();
    expect(await eventsFor('MSFT', 'safe')).toHaveLength(1);
  });

  it('a clear that lost a race is a no-op too', async () => {
    await tick('MSFT', pollAt(0), 399);
    await runEvaluator(db, { now: new Date(pollAt(0)) });
    await tick('MSFT', pollAt(1), 410);
    const staleRead = (await loadRuleStates(db)).find((s) => s.ticker === 'MSFT' && s.kind === 'safe')!;
    await runEvaluator(db, { now: new Date(pollAt(1)) });

    const losing = await applyDecision(db, {
      ...staleRead, threshold: staleRead.threshold!, price: staleRead.price!, capturedAt: staleRead.capturedAt!,
    }, 'clear');
    expect(losing).toBeNull();
  });

  describe('stale ticks (decision 2026-09-13: same 15-minute cutoff as the stale badge)', () => {
    it('skips a tick older than 15 minutes and opens nothing', async () => {
      await tick('MSFT', '2026-09-15T14:00:00Z', 350);
      const report = await runEvaluator(db, { now: new Date('2026-09-15T14:16:00Z') });

      expect(report.skipped).toContainEqual(
        expect.objectContaining({ ticker: 'MSFT', kind: 'safe', reason: 'stale_tick' }),
      );
      expect(await eventsFor('MSFT', 'safe')).toHaveLength(0);
    });

    it('still evaluates a tick exactly 15 minutes old', async () => {
      await tick('MSFT', '2026-09-15T14:00:00Z', 350);
      const report = await runEvaluator(db, { now: new Date('2026-09-15T14:15:00Z') });
      expect(report.triggered.map((t) => `${t.ticker}/${t.kind}`)).toContain('MSFT/safe');
    });
  });

  it('skips a buy rule with no PBT valuation rather than treating the threshold as zero', async () => {
    const [nvda] = await db.insert(schema.securities).values({ ticker: 'NVDA', name: 'NVIDIA' }).returning();
    await db.insert(schema.watchRules).values({ securityId: nvda!.id, kind: 'buy', value: null });
    await tick('NVDA', pollAt(0), 120);

    const report = await runEvaluator(db, { now: new Date(pollAt(0)) });
    expect(report.skipped).toContainEqual(
      expect.objectContaining({ ticker: 'NVDA', kind: 'buy', reason: 'no_threshold' }),
    );
    expect(await db.select().from(schema.alertEvents)).toHaveLength(0);
  });

  it('reports a rule whose security has never been polled', async () => {
    const report = await runEvaluator(db, { now: new Date(pollAt(0)) });
    expect(report.skipped.filter((s) => s.reason === 'no_tick')).toHaveLength(8); // 5 buy + 3 safe rules
  });

  it('does not evaluate a disabled rule', async () => {
    await db.update(schema.watchRules).set({ enabled: false })
      .where(eq(schema.watchRules.id, await ruleId('AAPL', 'safe')));
    await tick('AAPL', pollAt(0), 150);

    const report = await runEvaluator(db, { now: new Date(pollAt(0)) });
    expect(report.triggered).toHaveLength(0);
    expect(await eventsFor('AAPL', 'safe')).toHaveLength(0);
  });

  it('a gap down through both lines opens one event per rule', async () => {
    await tick('AAPL', pollAt(0), 120); // below safe 200 and buy 121.04
    const report = await runEvaluator(db, { now: new Date(pollAt(0)) });

    expect(report.triggered.map((t) => [t.kind, t.threshold]).sort()).toEqual([['buy', 121.04], ['safe', 200]]);
  });

  it('closes out-of-order ticks at triggered_at instead of violating alert_events_order_ck', async () => {
    // An event opened at 14:10, but the newest tick on record was captured at 14:05.
    await tick('MSFT', '2026-09-15T14:05:00Z', 410);
    await db.insert(schema.alertEvents).values({
      ruleId: await ruleId('MSFT', 'safe'), price: 399, threshold: 400,
      triggeredAt: new Date('2026-09-15T14:10:00Z'),
    });

    const report = await runEvaluator(db, { now: new Date('2026-09-15T14:10:00Z') });
    expect(report.cleared.map((c) => c.kind)).toEqual(['safe']);
    const [event] = await eventsFor('MSFT', 'safe');
    expect(event!.clearedAt!.toISOString()).toBe('2026-09-15T14:10:00.000Z');
  });

  it('resolves thresholds exactly as resolvedThresholds() does — one definition of D1', async () => {
    await db.insert(schema.valuations).values({
      securityId: await securityId('GOOGL'), method: 'pbt', buyPrice: 399.99, stickerPrice: 799.98,
      source: 'manual', asOf: '2026-09-15',
    });
    const fromEvaluator = (await loadRuleStates(db))
      .map((s) => [s.ruleId, s.threshold]).sort();
    const fromDashboard = (await resolvedThresholds(db))
      .map((r) => [Number(r.rule_id), r.threshold === null ? null : Number(r.threshold)]).sort();
    expect(fromEvaluator).toEqual(fromDashboard);
  });

  it('the schema rejects an event with no usable threshold (DEFECT-20)', async () => {
    await expect(db.insert(schema.alertEvents).values({
      ruleId: await ruleId('MSFT', 'safe'), price: 399, threshold: 0, triggeredAt: new Date(),
    })).rejects.toThrow();
  });
});
