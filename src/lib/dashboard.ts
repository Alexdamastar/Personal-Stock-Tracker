import type {
  ChipState, DashboardData, DashboardDeps, DashboardRow, Distance, PriceSticker,
  RuleData, RuleKind, SecurityData, ValuationData, ValuationMethod,
} from './dashboard-types.js';
import { evaluate } from './evaluate.js';
import { pbtYearsAt } from './valuation.js';

/**
 * §5 M5 view model: raw dashboard data -> sorted rows. Pure: no clock (`now` is
 * passed in), no I/O, and the input is never mutated — every array and object in a
 * row is freshly built, so a caller editing a row cannot reach back into the data.
 */
export function buildDashboardRows(
  data: DashboardData,
  now: Date,
  deps: DashboardDeps,
): DashboardRow[] {
  return data.securities
    .map((s) => buildRow(s, now, deps))
    .sort(compareRows);
}

/** Money columns are numeric(18, 4); line comparisons happen at exactly that scale. */
const UNITS_PER_DOLLAR = 10_000;

/** "Approaching" = at most 10% above a line, as the integer ratio 1/10 (DEFECT-21). */
const APPROACH_DENOMINATOR = 10n;

/**
 * Same test as evaluate()'s `isUsable`. A threshold that is null, non-finite or
 * non-positive is "no threshold" and is skipped everywhere — never treated as zero.
 * Non-positive matters: a 0 or negative line divides by zero here (migration 0003
 * now rejects those at the database, DEFECT-25).
 * Non-finite matters too: Postgres numeric accepts 'NaN', and NaN > 0 is TRUE there,
 * so the price_ticks CHECK does not keep it out.
 */
const isUsable = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

const toUnits = (dollars: number): bigint => BigInt(Math.round(dollars * UNITS_PER_DOLLAR));

const METHODS: readonly ValuationMethod[] = ['pbt', 'mos', 'ten_cap'];

/** The contract allows at most one enabled rule per kind; the first one wins if not. */
const ruleOf = (s: SecurityData, kind: RuleKind): RuleData | undefined =>
  s.rules.find((r) => r.kind === kind);

function buildRow(s: SecurityData, now: Date, deps: DashboardDeps): DashboardRow {
  const tick = s.latestTick;
  // An unusable price (see isUsable) is shown as no price rather than rendered as NaN.
  const price = tick !== null && isUsable(tick.price) ? tick.price : null;

  const safeRule = ruleOf(s, 'safe');
  const buyRule = ruleOf(s, 'buy');
  const safeT = safeRule !== undefined && isUsable(safeRule.threshold) ? safeRule.threshold : null;
  const buyT = buyRule !== undefined && isUsable(buyRule.threshold) ? buyRule.threshold : null;

  // Every resolved line, buy first. An unresolved buy rule (no PBT valuation yet) is
  // simply not in this list, so it cannot reach the chip, a distance or the sortKey.
  const lines = [buyT, safeT].filter((t): t is number => t !== null);

  const distances = price === null ? [] : lines.map((t) => distance(price, t));
  const sortKey = distances.length === 0 ? null : Math.min(...distances.map((d) => d.pct));

  return {
    securityId: s.securityId,
    ticker: s.ticker,
    name: s.name,

    price,
    changePct: price !== null && tick !== null && isUsable(tick.prevClose)
      ? (price - tick.prevClose) / tick.prevClose
      : null,

    // A safe rule always carries a value (watch_rules_safe_needs_value_ck); one that
    // somehow does not has no line to show, so it renders like no safe rule at all.
    safe: safeT === null ? null : {
      threshold: safeT,
      distance: price === null ? null : distance(price, safeT),
    },
    buy: buyRule === undefined ? null : {
      threshold: buyT,
      pinned: buyRule.pinned,
      distance: price === null || buyT === null ? null : distance(price, buyT),
    },

    pbtYearsAtPrice: price === null ? null : pbtYears(price, s),
    avgCost: s.avgCost,

    chip: chipFor(price, buyT, safeT),
    openAlerts: openAlertsOf(s),

    // Poll age, not quote age: the badge exists to catch a poller that stopped (DEFECT-01).
    stale: deps.isStale(tick?.capturedAt ?? null, now),
    quoteAgeMs: tick?.quoteAt ? now.getTime() - tick.quoteAt.getTime() : null,

    sparkline: {
      points: s.bars.map((b) => ({ date: b.date, close: b.close })),
      safe: safeT,
      buy: buyT,
    },

    secondary: Object.fromEntries(
      METHODS.map((m) => [m, priceSticker(s.valuations[m])]),
    ) as Record<ValuationMethod, PriceSticker | null>,

    sortKey,
  };
}

/**
 * Computed from integer ten-thousandths so that equal ratios produce the identical
 * double: 195/200 and 97.5/100 must tie exactly in the sort, not differ in the 17th
 * digit and silently override the by-ticker tie-break.
 */
function distance(price: number, threshold: number): Distance {
  const diff = Number(toUnits(price) - toUnits(threshold));
  return { dollars: diff / UNITS_PER_DOLLAR, pct: diff / Number(toUnits(threshold)) };
}

function chipFor(price: number | null, buyT: number | null, safeT: number | null): ChipState {
  if (price === null) return 'watching';
  // evaluate() with no open event is exactly "price <= threshold" at 4dp (DEFECT-21),
  // and returns 'none' for a null threshold — so it is reused rather than re-derived.
  // Order is the precedence: below both lines is at_buy.
  if (evaluate({ threshold: buyT }, price, null) === 'trigger') return 'at_buy';
  if (evaluate({ threshold: safeT }, price, null) === 'trigger') return 'at_safe';

  const p = toUnits(price);
  const approaching = [buyT, safeT].some((t) => {
    if (t === null) return false;
    const u = toUnits(t);
    // 0 < (p - u) / u <= 1/10, cross-multiplied so exactly 10% is exact.
    return p > u && (p - u) * APPROACH_DENOMINATOR <= u;
  });
  return approaching ? 'approaching' : 'watching';
}

/** The alert's STORED threshold (DEFECT-20), which may differ from the rule's current one. */
function openAlertsOf(s: SecurityData): DashboardRow['openAlerts'] {
  return s.rules.flatMap((r) => r.openAlert === null ? [] : [{
    kind: r.kind,
    threshold: r.openAlert.threshold,
    triggeredAt: r.openAlert.triggeredAt,
  }]);
}

function priceSticker(v: ValuationData | undefined): PriceSticker | null {
  return v === undefined ? null : { price: v.buyPrice, sticker: v.stickerPrice };
}

/**
 * Inputs from the latest PBT valuation's `inputs`, else the security's judgment
 * inputs (DEFECT-12), else null. The two sources are never mixed field by field: a
 * g from one filing paired with an FCF from another is a number nobody chose.
 */
function pbtYears(price: number, s: SecurityData): number | null {
  const fromValuation = pbtInputsOf(s.valuations.pbt?.inputs);
  const { fcfPerShare, growthRate } = s.judgment;
  const inputs = fromValuation ?? (
    Number.isFinite(fcfPerShare) && Number.isFinite(growthRate)
      ? { fcfPerShare: fcfPerShare as number, g: growthRate as number }
      : null
  );
  // Infinity (FCF <= 0, or past 100 years) passes through; the UI renders it.
  return inputs === null ? null : pbtYearsAt(price, inputs);
}

/**
 * `inputs` is unvalidated jsonb. Seeded non-AMZN rows hold `{ provenance, note }`,
 * and a numeric stored as a JSON string ("14.2956") is rejected rather than coerced.
 */
function pbtInputsOf(inputs: unknown): { fcfPerShare: number; g: number } | null {
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) return null;
  const { fcfPerShare, g } = inputs as Record<string, unknown>;
  return typeof fcfPerShare === 'number' && Number.isFinite(fcfPerShare)
    && typeof g === 'number' && Number.isFinite(g)
    ? { fcfPerShare, g }
    : null;
}

/** DEFECT-10: nearest-to-a-line first; no key last; ties by ticker. */
function compareRows(a: DashboardRow, b: DashboardRow): number {
  if (a.sortKey !== b.sortKey) {
    if (a.sortKey === null) return 1;
    if (b.sortKey === null) return -1;
    return a.sortKey - b.sortKey;
  }
  // Code-unit order, not localeCompare: the order must not depend on the server's locale.
  return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
}
