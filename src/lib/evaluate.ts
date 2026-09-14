/**
 * §5 M4 — the rule evaluator. Pure: no clock, no database, no I/O.
 *
 *   trigger  when price <= threshold and no event is open
 *   clear    when an event is open and price > threshold * 1.005   (0.5% hysteresis)
 *   none     otherwise
 *
 * The hysteresis band is what stops a price hovering at 400 from opening and
 * closing an alert on every poll.
 */

export type Decision = 'trigger' | 'clear' | 'none';

/** What the evaluator needs to know about a rule. */
export interface RuleThreshold {
  /**
   * Resolved threshold, or null when there is none — a buy rule whose security has
   * no PBT valuation yet (D1). Null is never treated as zero: a zero threshold would
   * clear every open event and could never trigger, silently disabling the rule.
   */
  threshold: number | null;
}

/** Only presence matters to the decision; the id is for the caller. */
export type OpenEvent = { id: number } | null;

/** 0.5% expressed as a ratio of integers — see `toUnits` for why not 1.005. */
const CLEAR_NUMERATOR = 1005n;
const CLEAR_DENOMINATOR = 1000n;

/** Money columns are numeric(18, 4). Comparisons happen at exactly that precision. */
const UNITS_PER_DOLLAR = 10_000;

/**
 * DEFECT-21: `threshold * 1.005` in floating point is WRONG at the boundary, and
 * wrong on exactly the numbers this project uses. 1.005 has no exact binary form:
 *
 *   400 * 1.005 === 401.99999999999994
 *
 * so a price of exactly 402.00 satisfies `price > threshold * 1.005` and clears,
 * though the spec says strictly greater. The same happens at 200 -> 201 and
 * 220 -> 221.1 — all three seeded safe prices.
 *
 * Both sides are converted to integer ten-thousandths of a dollar (the scale the
 * database stores) and compared as BigInt, where the arithmetic is exact.
 */
function toUnits(dollars: number): bigint {
  return BigInt(Math.round(dollars * UNITS_PER_DOLLAR));
}

const isUsable = (n: number | null): n is number =>
  n !== null && Number.isFinite(n) && n > 0;

export function evaluate(rule: RuleThreshold, price: number, openEvent: OpenEvent): Decision {
  // Nothing to compare against, or nothing trustworthy to compare. The price_ticks
  // CHECK already rejects non-positive prices; this keeps the function total anyway.
  if (!isUsable(rule.threshold) || !isUsable(price)) return 'none';

  const p = toUnits(price);
  const t = toUnits(rule.threshold);

  if (openEvent === null) {
    return p <= t ? 'trigger' : 'none';
  }
  return p * CLEAR_DENOMINATOR > t * CLEAR_NUMERATOR ? 'clear' : 'none';
}
