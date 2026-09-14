/**
 * Rule #1 valuation math — §3.2. Pure. No I/O, no DB, no fetching (§6.5).
 *
 * Every constant here is pinned by the AMZN golden fixture in §3.4. Two rules
 * that an agent will be tempted to "clean up" and must not:
 *
 *  1. §3.3 — the 2x relationship between a price and its sticker is an artifact
 *     of mosPct = 0.50, NOT a formula. Always `price / (1 - mosPct)`.
 *     Which side is primary differs by method:
 *       MOS     -> sticker is primary (a real discounted intrinsic value),
 *                  price   = sticker * (1 - mosPct)
 *       10 Cap  -> price is primary,   sticker = price / (1 - mosPct)
 *       PBT     -> price is primary,   sticker = price / (1 - mosPct)
 *
 *  2. §3.4 — TWO DIFFERENT SHARE COUNTS ARE IN PLAY. Do not normalize them.
 *     `shares` for 10 Cap is the cover-page count (AMZN 10,754.252M).
 *     `epsTtm` is already per-diluted-weighted-average-share (~10,845M).
 *     Forcing one count everywhere breaks the 10 Cap fixture.
 */

export interface MethodResult<I> {
  /** The buy price. This is the alert threshold. */
  price: number;
  /** Display only (D2). Never an alert threshold. */
  sticker: number;
  inputs: I;
}

const assertFinite = (label: string, v: number): number => {
  if (!Number.isFinite(v)) throw new RangeError(`${label} must be a finite number, got ${v}`);
  return v;
};

const assertMosPct = (mosPct: number): number => {
  assertFinite('mosPct', mosPct);
  // (1 - mosPct) is a divisor for 10 Cap and PBT stickers.
  if (mosPct < 0 || mosPct >= 1) throw new RangeError(`mosPct must be in [0, 1), got ${mosPct}`);
  return mosPct;
};

/** §3.3: sticker from a primary price. Never hardcode 2x. */
export const stickerFromPrice = (price: number, mosPct: number): number =>
  price / (1 - assertMosPct(mosPct));

/** §3.3: price from a primary sticker (MOS only). */
export const priceFromSticker = (sticker: number, mosPct: number): number =>
  sticker * (1 - assertMosPct(mosPct));

// ---------------------------------------------------------------- 10 Cap

export interface TenCapInput {
  /** Cash from operations, TTM. */
  cfo: number;
  /** Capital expenditures, TTM. Conventionally NEGATIVE, but sign-tolerant here. */
  capex: number;
  /** Fraction of capex treated as maintenance. Judgment call (§7.3), default 0.70. */
  maintPct: number;
  /** Income tax provision, TTM. Added back — owner earnings are pre-tax. */
  tax: number;
  /** Cover-page shares outstanding. NOT diluted weighted-average. See §3.4. */
  shares: number;
  mosPct: number;
}

export interface TenCapDerived extends TenCapInput {
  maintCapex: number;
  ownerEarnings: number;
  oePerShare: number;
}

export function tenCap(i: TenCapInput): MethodResult<TenCapDerived> {
  assertFinite('cfo', i.cfo); assertFinite('capex', i.capex); assertFinite('tax', i.tax);
  assertFinite('maintPct', i.maintPct);
  if (assertFinite('shares', i.shares) <= 0) throw new RangeError('shares must be > 0');
  assertMosPct(i.mosPct);

  // abs() so a filer reporting capex as a positive outflow cannot flip the sign (§6.1 hazard).
  const maintCapex = Math.abs(i.capex) * i.maintPct;
  const ownerEarnings = i.cfo - maintCapex + i.tax;
  const oePerShare = ownerEarnings / i.shares;
  const price = oePerShare * 10;

  return {
    price,
    sticker: stickerFromPrice(price, i.mosPct),
    inputs: { ...i, maintCapex, ownerEarnings, oePerShare },
  };
}

// ------------------------------------------------------- Margin of Safety

export interface MosInput {
  /** Diluted EPS, TTM. */
  epsTtm: number;
  /** Future growth rate, DECIMAL (0.1334 = 13.34%). */
  g: number;
  /** Minimum acceptable rate of return, default 0.15. */
  marr: number;
  mosPct: number;
  /**
   * Optional cap on the future P/E. §9 known-unverified: the AMZN fixture never
   * exercises this branch because 2*g% was already the lower value.
   */
  historicalAvgPe?: number;
  /** Projection horizon. 10 is the Rule #1 convention; exposed but not a knob to twiddle. */
  years?: number;
}

export interface MosDerived extends MosInput {
  futureEps: number;
  futurePe: number;
  futureValue: number;
}

export function marginOfSafety(i: MosInput): MethodResult<MosDerived> {
  assertFinite('epsTtm', i.epsTtm); assertFinite('g', i.g); assertFinite('marr', i.marr);
  assertMosPct(i.mosPct);
  if (i.marr <= -1) throw new RangeError('marr must be > -1');
  const years = i.years ?? 10;

  const futureEps = i.epsTtm * (1 + i.g) ** years;
  const cappedPe = 2 * i.g * 100;
  const futurePe = i.historicalAvgPe === undefined
    ? cappedPe
    : Math.min(cappedPe, i.historicalAvgPe);
  const futureValue = futureEps * futurePe;

  // Sticker is PRIMARY here — a discounted intrinsic value, independently derivable.
  const sticker = futureValue / (1 + i.marr) ** years;

  return {
    price: priceFromSticker(sticker, i.mosPct),
    sticker,
    inputs: { ...i, futureEps, futurePe, futureValue },
  };
}

// ----------------------------------------------------------- Payback Time

export interface PbtInput {
  /**
   * Free cash flow per share.
   *
   * §6.3 IS OPEN. How the Toolbox derives its FCF ratio is unresolved, so this
   * stays an explicit manual input rather than being computed. Ruled out against
   * the AMZN fixture (target 14.2956): cfo+capex (-0.23), cfo-maintCapex (3.98),
   * ownerEarnings (6.22), cfo/coverShares (13.81), and cfo/trueTtmNetIncome
   * (ratio 1.6358 -> 13.6756, pbtPrice 200.21 vs 209.29).
   *
   * Use fcfPerShareFromRatio() when you have the Toolbox's displayed ratio: the
   * fixture needs 8.36 * 1.71 = 14.2956, not the displayed-rounded 14.30, which
   * yields 209.35 against a target of 209.29.
   */
  fcfPerShare: number;
  /** Future growth rate, DECIMAL. */
  g: number;
  /** Payback window, default 8. */
  years: number;
  mosPct: number;
}

/** §3.4: build fcfPerShare at full precision. Do not round before compounding. */
export const fcfPerShareFromRatio = (epsTtm: number, fcfRatio: number): number =>
  assertFinite('epsTtm', epsTtm) * assertFinite('fcfRatio', fcfRatio);

export function paybackTime(i: PbtInput): MethodResult<PbtInput> {
  assertFinite('fcfPerShare', i.fcfPerShare); assertFinite('g', i.g);
  assertMosPct(i.mosPct);
  if (!Number.isInteger(i.years) || i.years < 1) {
    throw new RangeError(`years must be a positive integer, got ${i.years}`);
  }

  let price = 0;
  for (let n = 1; n <= i.years; n++) price += i.fcfPerShare * (1 + i.g) ** n;

  return { price, sticker: stickerFromPrice(price, i.mosPct), inputs: { ...i } };
}

/**
 * §3.2 inverse — years of compounding FCF needed to recoup `price`.
 * This is the M5 dashboard's headline number: more informative than a raw $ gap.
 * Returns a fractional year count.
 */
export function pbtYearsAt(
  price: number,
  i: Pick<PbtInput, 'fcfPerShare' | 'g'>,
  maxYears = 100,
): number {
  assertFinite('price', price);
  if (price <= 0) return 0;
  if (i.fcfPerShare <= 0) return Number.POSITIVE_INFINITY;

  let cum = 0;
  for (let n = 1; n <= maxYears; n++) {
    const contribution = i.fcfPerShare * (1 + i.g) ** n;
    if (cum + contribution >= price) return n - 1 + (price - cum) / contribution;
    cum += contribution;
  }
  return Number.POSITIVE_INFINITY;
}
