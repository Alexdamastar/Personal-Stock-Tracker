import {
  boolean, check, date, index, integer, jsonb, numeric, pgTable,
  primaryKey, serial, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Money / ratio column helpers.
 *
 * DEFECT-04: bare `numeric` is returned as a JS *string* by the pg driver, so
 * `price + 1` silently yields "266.031". Every numeric column in this schema is
 * declared `mode: 'number'` so Drizzle parses it at the boundary. Precision is
 * explicit rather than unbounded so rounding is deterministic across engines.
 *
 * Values stay far below 2^53, so float64 round-tripping is exact at these scales.
 */
const money = (name: string) => numeric(name, { precision: 18, scale: 4, mode: 'number' });
const ratio = (name: string) => numeric(name, { precision: 9, scale: 6, mode: 'number' });
const shareCount = (name: string) => numeric(name, { precision: 20, scale: 6, mode: 'number' });

export const securities = pgTable('securities', {
  id: serial('id').primaryKey(),
  ticker: text('ticker').notNull().unique(),
  name: text('name').notNull(),
  cik: text('cik'), // 10-digit zero-padded, Phase 2
  active: boolean('active').notNull().default(true),

  // ---- judgment inputs (§7.3). Not filed facts. Per-security, visible, editable.
  // DEFECT-12: the spec gave maint_pct a home but left manual `g` and
  // `fcfPerShare` homeless even though §6.2/§6.3 require both to be manual.
  maintPct: ratio('maint_pct').notNull().default(0.7),
  growthRate: ratio('growth_rate'),      // §6.2 `g`; null => must be supplied per-valuation
  fcfPerShare: money('fcf_per_share'),   // §6.3 unresolved; manual until then
  marr: ratio('marr').notNull().default(0.15),
  mosPct: ratio('mos_pct').notNull().default(0.5),
  pbtYears: integer('pbt_years').notNull().default(8),
});

/** APPEND-ONLY. New filing => new row. Never UPDATE. */
export const valuations = pgTable('valuations', {
  id: serial('id').primaryKey(),
  securityId: integer('security_id').notNull().references(() => securities.id),
  method: text('method').notNull(),        // 'pbt' | 'mos' | 'ten_cap'
  buyPrice: money('buy_price').notNull(),
  stickerPrice: money('sticker_price').notNull(),
  growthRate: ratio('growth_rate'),
  marr: ratio('marr'),
  mosPct: ratio('mos_pct'),
  inputs: jsonb('inputs'),                 // full input object, for reproducibility
  source: text('source').notNull(),        // 'manual' | 'engine'
  asOf: date('as_of').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('valuations_latest_idx').on(t.securityId, t.method, t.asOf.desc(), t.id.desc()),
  check('valuations_method_ck', sql`${t.method} in ('pbt','mos','ten_cap')`),
  check('valuations_source_ck', sql`${t.source} in ('manual','engine')`),
  check('valuations_positive_ck', sql`${t.buyPrice} > 0 and ${t.stickerPrice} > 0`),
]);

export const watchRules = pgTable('watch_rules', {
  id: serial('id').primaryKey(),
  securityId: integer('security_id').notNull().references(() => securities.id),
  kind: text('kind').notNull(),            // 'safe' | 'buy'
  value: money('value'),                   // NULL + kind='buy' => follows latest pbt valuation
  enabled: boolean('enabled').notNull().default(true),
}, (t) => [
  uniqueIndex('watch_rules_security_kind_uq').on(t.securityId, t.kind),
  check('watch_rules_kind_ck', sql`${t.kind} in ('safe','buy')`),
  // D3: a 'safe' rule is a number the user sets by feel; it has no valuation to
  // fall back on, so NULL is only meaningful for kind='buy' (follows latest PBT).
  check('watch_rules_safe_needs_value_ck', sql`${t.kind} <> 'safe' or ${t.value} is not null`),
]);

/**
 * DEFECT-01: PK was (security_id, captured_at) with captured_at sourced from the
 * provider's quote timestamp. Quotes are 15-20 min delayed (D6) and we poll every
 * 5 min, so the same provider stamp returns 3-4 consecutive times and every poll
 * after the first threw a duplicate-key error.
 *
 * captured_at = poll wall-clock (unique per poll, so the PK holds).
 * quote_at    = provider's stamp. This is the column the M5 stale badge must read;
 *               captured_at only proves the poller ran, not that the data is fresh.
 */
export const priceTicks = pgTable('price_ticks', {
  securityId: integer('security_id').notNull().references(() => securities.id),
  price: money('price').notNull(),
  provider: text('provider').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  quoteAt: timestamp('quote_at', { withTimezone: true }),
  /**
   * DEFECT-23: M5 shows % change, which needs the prior session's close, and nothing
   * stored it. Both providers return it (Finnhub `pc`, Twelve Data `previous_close`),
   * so it is captured per tick rather than approximated from daily_bars, which are
   * tick-derived and empty until a full day has been polled. Nullable: a provider
   * may omit it, and ticks written before migration 0002 have none.
   */
  prevClose: money('prev_close'),
}, (t) => [
  primaryKey({ columns: [t.securityId, t.capturedAt] }),
  index('price_ticks_recent_idx').on(t.securityId, t.capturedAt.desc()),
  check('price_ticks_positive_ck', sql`${t.price} > 0`),
  check('price_ticks_prev_close_positive_ck', sql`${t.prevClose} is null or ${t.prevClose} > 0`),
]);

/**
 * DEFECT-05: nothing in the plan wrote this table, yet M5 needs 30 days of history.
 * Resolved by giving M1 the rollup (scripts/rollup.ts) rather than deleting the table:
 * it lets price_ticks be pruned without losing history.
 *
 * NOTE: these bars are derived from delayed intraday ticks, not official OHLC.
 * open = first tick at/after 09:30 ET, close = last tick at/before 16:00 ET.
 * They will not match an exchange feed exactly and must not be presented as if they do.
 */
export const dailyBars = pgTable('daily_bars', {
  securityId: integer('security_id').notNull().references(() => securities.id),
  date: date('date').notNull(),
  open: money('open'), high: money('high'), low: money('low'), close: money('close'),
  tickCount: integer('tick_count').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.securityId, t.date] })]);

/**
 * DEFECT-02: M4 branches on "no open event", but nothing stopped two open rows per
 * rule when a poll overlapped a retry. The partial unique index below makes the
 * evaluator's core invariant a database guarantee instead of a convention.
 */
export const alertEvents = pgTable('alert_events', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => watchRules.id),
  price: money('price').notNull(),
  /**
   * DEFECT-20: the threshold this event crossed, captured at trigger time. A buy
   * rule's threshold moves with every appended valuation (D1) and M6 edits safe
   * prices, so the rule's CURRENT value cannot tell the alert log what fired.
   */
  threshold: money('threshold').notNull(),
  triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull(),
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('alert_events_one_open_per_rule')
    .on(t.ruleId)
    .where(sql`${t.clearedAt} is null`),
  check('alert_events_order_ck', sql`${t.clearedAt} is null or ${t.clearedAt} >= ${t.triggeredAt}`),
  check('alert_events_positive_ck', sql`${t.price} > 0 and ${t.threshold} > 0`),
]);

export const positions = pgTable('positions', {
  securityId: integer('security_id').primaryKey().references(() => securities.id),
  avgCost: money('avg_cost'),
  shares: shareCount('shares'),
});

export const VALUATION_METHODS = ['pbt', 'mos', 'ten_cap'] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];
export const RULE_KINDS = ['safe', 'buy'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
