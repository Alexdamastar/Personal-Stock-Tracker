/**
 * §5 M5 — the dashboard contract.
 *
 * Written BEFORE the M5 work was fanned out to parallel agents, so the loader, the
 * view model and the UI agree on one shape without seeing each other's code. Change
 * it deliberately, not in passing.
 *
 *   loadDashboardData(db)                 src/db/dashboard-data.ts   DB -> DashboardData
 *   buildDashboardRows(data, now, deps)   src/lib/dashboard.ts       DashboardData -> DashboardRow[]
 *   <DashboardTable rows={...} />         src/components/            DashboardRow[] -> HTML
 *
 * Decisions this encodes (asked, not assumed — 2026-09-13):
 *   - % change uses the PROVIDER's previous close, stored per tick (migration 0002).
 *   - The state chip is driven by PRICE; open alerts are a separate marker.
 *   - When price is below both lines, `at_buy` wins.
 *   - pbtYearsAtPrice reads the latest PBT valuation's inputs, then the security's.
 *   - The stale badge reads POLL age (captured_at); quote age is display text only.
 */

export type ValuationMethod = 'pbt' | 'mos' | 'ten_cap';
export type RuleKind = 'safe' | 'buy';

// ---------------------------------------------------------------------------------
// Input: what the loader reads. Raw facts, nothing derived.
// ---------------------------------------------------------------------------------

export interface TickData {
  price: number;
  /** Provider's previous close. Null when the provider omitted it, or for ticks older than migration 0002. */
  prevClose: number | null;
  /** Poll wall-clock. The stale badge reads THIS. */
  capturedAt: Date;
  /** Provider's own quote timestamp. Rendered as "quote 20m old" text; never drives the badge. */
  quoteAt: Date | null;
  provider: string;
}

export interface OpenAlertData {
  eventId: number;
  price: number;
  /** The threshold the alert crossed at trigger time (DEFECT-20). May differ from the rule's current one. */
  threshold: number;
  triggeredAt: Date;
}

export interface RuleData {
  ruleId: number;
  kind: RuleKind;
  /**
   * Resolved per D1: the pinned value, else the latest PBT buy price, else null.
   * Null means "no threshold yet" and must be skipped — never treated as zero.
   */
  threshold: number | null;
  /** True when watch_rules.value is non-null (a pinned buy rule, or any safe rule). */
  pinned: boolean;
  openAlert: OpenAlertData | null;
}

export interface ValuationData {
  buyPrice: number;
  stickerPrice: number;
  /** YYYY-MM-DD */
  asOf: string;
  source: 'manual' | 'engine';
  /** The stored `inputs` jsonb, unvalidated. */
  inputs: unknown;
}

export interface SecurityData {
  securityId: number;
  ticker: string;
  name: string;
  latestTick: TickData | null;
  /** ENABLED rules only, at most one per kind. */
  rules: RuleData[];
  /** Latest valuation per method (as_of desc, id desc). A method with no valuation is absent. */
  valuations: Partial<Record<ValuationMethod, ValuationData>>;
  /** securities.fcf_per_share / growth_rate — the manual judgment inputs (DEFECT-12). */
  judgment: { fcfPerShare: number | null; growthRate: number | null };
  /** positions.avg_cost. Manual only (§7.6). */
  avgCost: number | null;
  /** At most the 30 most recent daily bars, OLDEST FIRST. */
  bars: { date: string; close: number }[];
}

export interface DashboardData {
  /** Active securities only, in no particular order — the view model sorts. */
  securities: SecurityData[];
}

// ---------------------------------------------------------------------------------
// Output: one row per security, everything the UI renders, already derived.
// ---------------------------------------------------------------------------------

/**
 * Price-driven, highest precedence first:
 *   at_buy       price <= resolved buy threshold
 *   at_safe      price <= safe threshold
 *   approaching  price above a resolved line by at most 10%: (price - t) / t <= 0.10
 *   watching     everything else, including a security with no price
 *
 * Comparisons at the line are exact at 4 decimal places, the same as evaluate():
 * a price exactly AT a threshold is at that line.
 */
export type ChipState = 'watching' | 'approaching' | 'at_safe' | 'at_buy';

export interface Distance {
  /** price - threshold. Negative means price is below the line. */
  dollars: number;
  /** (price - threshold) / threshold as a fraction: 0.05 is 5%. */
  pct: number;
}

export interface PriceSticker { price: number; sticker: number }

export interface DashboardRow {
  securityId: number;
  ticker: string;
  name: string;

  price: number | null;
  /** (price - prevClose) / prevClose as a fraction. Null unless both exist. */
  changePct: number | null;

  /** Null when the security has no enabled safe rule (D3: optional). */
  safe: { threshold: number; distance: Distance | null } | null;
  /** Null when there is no enabled buy rule. `threshold` null = no PBT valuation yet. */
  buy: { threshold: number | null; pinned: boolean; distance: Distance | null } | null;

  /**
   * Years of FCF to recoup the current price (valuation.ts `pbtYearsAt`). Inputs from
   * the latest PBT valuation's `inputs` ({ fcfPerShare, g }), else the security's
   * judgment inputs, else null. May be Infinity (FCF <= 0, or beyond 100 years).
   */
  pbtYearsAtPrice: number | null;
  avgCost: number | null;

  chip: ChipState;
  /** Rules with an open alert — the hysteresis state, rendered apart from the chip. */
  openAlerts: { kind: RuleKind; threshold: number; triggeredAt: Date }[];

  /** Poll-age staleness, from the injected isStale(). */
  stale: boolean;
  /** now - quoteAt in ms, or null. Display text only. */
  quoteAgeMs: number | null;

  sparkline: {
    points: { date: string; close: number }[];
    /** Horizontal rules drawn across the sparkline. Null when absent/unresolved. */
    safe: number | null;
    buy: number | null;
  };

  /** D2 + §7.2: all three methods side by side, so the headline is never mistaken for consensus. */
  secondary: Record<ValuationMethod, PriceSticker | null>;

  /**
   * DEFECT-10: min over enabled, RESOLVED rules of (price - threshold) / threshold.
   * Null (no price, or no resolved rule) sorts last. Ties break by ticker.
   */
  sortKey: number | null;
}

/** Injected so the view model stays pure and testable without the market calendar. */
export interface DashboardDeps {
  isStale: (capturedAt: Date | null, now: Date) => boolean;
}
