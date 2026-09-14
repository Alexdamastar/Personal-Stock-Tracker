import { and, eq, isNull, sql } from 'drizzle-orm';
import { evaluate, type Decision } from '../lib/evaluate.js';
import { latestPbtBuyJoin } from './queries.js';
import { rowsOf } from './rows.js';
import { alertEvents } from './schema.js';
import type { Db } from './seed.js';

/**
 * §5 M4 — applies the pure `evaluate()` to the database. M3 calls `runEvaluator`
 * right after it writes a poll's ticks.
 *
 * Invariants this relies on rather than re-implements:
 *   - at most one open event per rule is a DATABASE guarantee (DEFECT-02), so two
 *     overlapping runs cannot double-trigger even if both read "no open event";
 *   - every write is conditional, so re-running on the same tick is a no-op.
 */

/**
 * A tick older than this is not evaluated. Same cutoff as M5's stale badge: if the
 * dashboard would call the price stale, it is too stale to open or close an alert
 * on. Without it, editing a safe price after the poller died would fire an alert
 * off whatever price happened to be left in the table.
 */
export const MAX_TICK_AGE_MS = 15 * 60 * 1000;

/** Everything one rule's decision depends on, read in a single query. */
export interface RuleState {
  ruleId: number;
  ticker: string;
  kind: string;
  /** Resolved via D1: pinned value, else latest PBT buy price, else null. */
  threshold: number | null;
  price: number | null;
  /** When the tick was polled. Alert timestamps use this, not the wall clock. */
  capturedAt: Date | null;
  openEventId: number | null;
}

export type SkipReason =
  | 'no_threshold'    // buy rule with no PBT valuation yet — never a threshold of zero
  | 'no_tick'         // nothing has been polled for this security
  | 'stale_tick'      // newest tick is older than maxTickAgeMs
  | 'already_applied'; // another run made the same change between our read and write

export interface RuleOutcome {
  ruleId: number;
  ticker: string;
  kind: string;
  price: number;
  threshold: number;
  eventId: number;
}

export interface EvaluatorReport {
  triggered: RuleOutcome[];
  cleared: RuleOutcome[];
  skipped: { ruleId: number; ticker: string; kind: string; reason: SkipReason }[];
  /** Evaluated, and the decision was `none`. */
  unchanged: number;
}

export async function loadRuleStates(db: Db): Promise<RuleState[]> {
  // Timestamps come back as epoch milliseconds because raw `execute()` bypasses
  // Drizzle's column mapping, and postgres.js and PGlite do not agree on whether a
  // timestamptz is a Date or a string (the DEFECT-13 class). A number is the same
  // on every driver.
  const result = await db.execute(sql`
    select r.id                                      as rule_id,
           s.ticker,
           r.kind,
           coalesce(r.value, lv.buy_price)           as threshold,
           lt.price,
           extract(epoch from lt.captured_at) * 1000 as captured_ms,
           oe.id                                     as open_event_id
      from watch_rules r
      join securities s on s.id = r.security_id
      ${latestPbtBuyJoin}
      left join lateral (
            select t.price, t.captured_at
              from price_ticks t
             where t.security_id = r.security_id
             order by t.captured_at desc
             limit 1
      ) lt on true
      left join alert_events oe on oe.rule_id = r.id and oe.cleared_at is null
     where r.enabled
     order by s.ticker, r.kind
  `);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return rowsOf<Record<string, unknown>>(result).map((row) => {
    const capturedMs = num(row['captured_ms']);
    return {
      ruleId: Number(row['rule_id']),
      ticker: String(row['ticker']),
      kind: String(row['kind']),
      threshold: num(row['threshold']),
      price: num(row['price']),
      capturedAt: capturedMs === null ? null : new Date(capturedMs),
      openEventId: num(row['open_event_id']),
    };
  });
}

/**
 * Writes one decision. Returns the affected event id, or null when the write was a
 * no-op because another run got there first.
 *
 * The event threshold is the rule's CURRENT threshold (decided 2026-09-13): when a
 * new valuation or an M6 edit moves the line, an open event is judged against where
 * the line is now. The threshold stored at trigger time is history, for the alert
 * log — it does not govern clearing.
 */
export async function applyDecision(
  db: Db,
  state: RuleState & { threshold: number; price: number; capturedAt: Date },
  decision: Exclude<Decision, 'none'>,
): Promise<number | null> {
  if (decision === 'trigger') {
    // ON CONFLICT with no target covers the partial unique index
    // alert_events_one_open_per_rule: a concurrent run that already opened an event
    // turns this insert into a no-op instead of an exception that kills the poll.
    const [row] = await db.insert(alertEvents)
      .values({
        ruleId: state.ruleId,
        price: state.price,
        threshold: state.threshold,
        triggeredAt: state.capturedAt,
      })
      .onConflictDoNothing()
      .returning({ id: alertEvents.id });
    return row?.id ?? null;
  }

  if (state.openEventId === null) return null;
  // greatest(): alert_events_order_ck requires cleared_at >= triggered_at. Ticks
  // written out of order must not turn a legitimate clear into a constraint error.
  const [row] = await db.update(alertEvents)
    .set({ clearedAt: sql`greatest(${state.capturedAt.toISOString()}::timestamptz, ${alertEvents.triggeredAt})` })
    .where(and(eq(alertEvents.id, state.openEventId), isNull(alertEvents.clearedAt)))
    .returning({ id: alertEvents.id });
  return row?.id ?? null;
}

export async function runEvaluator(
  db: Db,
  opts: { now?: Date; maxTickAgeMs?: number } = {},
): Promise<EvaluatorReport> {
  const now = opts.now ?? new Date();
  const maxAge = opts.maxTickAgeMs ?? MAX_TICK_AGE_MS;
  const report: EvaluatorReport = { triggered: [], cleared: [], skipped: [], unchanged: 0 };

  for (const state of await loadRuleStates(db)) {
    const { ruleId, ticker, kind, threshold, price, capturedAt } = state;
    const skip = (reason: SkipReason) => report.skipped.push({ ruleId, ticker, kind, reason });

    if (threshold === null) { skip('no_threshold'); continue; }
    if (price === null || capturedAt === null) { skip('no_tick'); continue; }
    if (now.getTime() - capturedAt.getTime() > maxAge) { skip('stale_tick'); continue; }

    const decision = evaluate(
      { threshold },
      price,
      state.openEventId === null ? null : { id: state.openEventId },
    );
    if (decision === 'none') { report.unchanged++; continue; }

    const eventId = await applyDecision(db, { ...state, threshold, price, capturedAt }, decision);
    if (eventId === null) { skip('already_applied'); continue; }

    const outcome = { ruleId, ticker, kind, price, threshold, eventId };
    (decision === 'trigger' ? report.triggered : report.cleared).push(outcome);
  }
  return report;
}
