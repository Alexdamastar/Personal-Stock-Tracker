import { describe, expect, it } from 'vitest';
import {
  fcfPerShareFromRatio, marginOfSafety, paybackTime,
  pbtYearsAt, priceFromSticker, stickerFromPrice, tenCap,
} from '../src/lib/valuation.js';

/**
 * §3.4 golden fixture — the direct port of verify.py, which §3.4 designates as
 * the first test file. All 15 assertions, same tolerances.
 */
const F = {
  cfo: 148531.0, capex: -151003.0, maintPct: 0.7, tax: 24094.0,
  shares: 10754.252, epsTtm: 8.36, g: 0.1334, marr: 0.15, mosPct: 0.5,
  fcfRatio: 1.71, pbtYears: 8, lastPrice: 266.03,
} as const;

const near = (got: number, want: number, tol: number) =>
  expect(Math.abs(got - want), `got ${got}, want ${want} ±${tol}`).toBeLessThanOrEqual(tol);

describe('§3.4 AMZN golden fixture', () => {
  const ten = tenCap(F);
  const mos = marginOfSafety(F);
  const fcfPerShare = fcfPerShareFromRatio(F.epsTtm, F.fcfRatio);
  const pbt = paybackTime({ fcfPerShare, g: F.g, years: F.pbtYears, mosPct: F.mosPct });

  it('maintCapex', () => near(ten.inputs.maintCapex, 105702.1, 0.05));
  it('ownerEarnings', () => near(ten.inputs.ownerEarnings, 66922.9, 0.05));
  it('oePerShare', () => near(ten.inputs.oePerShare, 6.22, 0.01));
  it('tenCapPrice', () => near(ten.price, 62.23, 0.01));
  it('tenCapSticker', () => near(ten.sticker, 124.46, 0.01));

  it('futureEps', () => near(mos.inputs.futureEps, 29.24, 0.01));
  it('futurePe', () => near(mos.inputs.futurePe, 26.68, 0.01));
  it('futureValue', () => near(mos.inputs.futureValue, 780.23, 0.15));
  it('mosSticker', () => near(mos.sticker, 192.86, 0.05));
  it('mosPrice', () => near(mos.price, 96.43, 0.01));

  it('pbtPrice', () => near(pbt.price, 209.29, 0.1));
  it('pbtSticker', () => near(pbt.sticker, 418.58, 0.2));
  it('pbtYearsAtLastPrice', () =>
    near(pbtYearsAt(F.lastPrice, { fcfPerShare, g: F.g }), 9.26, 0.02));

  it('uses epsTtm x fcfRatio, not the displayed 14.30 (§3.4)', () => {
    expect(fcfPerShare).toBeCloseTo(14.2956, 4);
    const rounded = paybackTime({ fcfPerShare: 14.3, g: F.g, years: 8, mosPct: 0.5 });
    // The rounded input misses the target; the exact one hits it.
    near(rounded.price, 209.35, 0.01);
    expect(Math.abs(pbt.price - 209.29)).toBeLessThan(Math.abs(rounded.price - 209.29));
  });
});

describe('§3.3 sticker direction — the 2x is an artifact of mosPct, not a formula', () => {
  it('at mosPct=0.50 every pair happens to be exactly 2x', () => {
    expect(tenCap(F).sticker / tenCap(F).price).toBeCloseTo(2, 10);
    expect(marginOfSafety(F).sticker / marginOfSafety(F).price).toBeCloseTo(2, 10);
  });

  it('at mosPct=0.25 the PRIMARY side of each method holds still', () => {
    const q = { ...F, mosPct: 0.25 };
    // MOS: sticker is primary (a discounted intrinsic value) -> unchanged.
    near(marginOfSafety(q).sticker, 192.86, 0.05);
    near(marginOfSafety(q).price, 144.65, 0.05);
    // 10 Cap: price is primary -> unchanged, sticker moves.
    near(tenCap(q).price, 62.23, 0.01);
    near(tenCap(q).sticker, 82.97, 0.01);
    // PBT: price is primary -> unchanged, sticker moves.
    const fcf = fcfPerShareFromRatio(F.epsTtm, F.fcfRatio);
    near(paybackTime({ fcfPerShare: fcf, g: F.g, years: 8, mosPct: 0.25 }).price, 209.29, 0.1);
    near(paybackTime({ fcfPerShare: fcf, g: F.g, years: 8, mosPct: 0.25 }).sticker, 279.05, 0.1);
  });

  it('sticker/price helpers round-trip', () => {
    for (const m of [0, 0.25, 0.5, 0.75]) {
      expect(priceFromSticker(stickerFromPrice(100, m), m)).toBeCloseTo(100, 10);
    }
  });
});

describe('§3.4 dual share counts must not be normalized', () => {
  it('forcing diluted weighted-average shares into 10 Cap breaks the fixture', () => {
    const diluted = tenCap({ ...F, shares: 10845 });
    expect(Math.abs(diluted.price - 62.23)).toBeGreaterThan(0.5);
  });
});

describe('§9 known-unverified: futurePe historicalAvgPe branch', () => {
  it('takes 2*g% when it is the lower of the two (the fixture path)', () => {
    expect(marginOfSafety({ ...F, historicalAvgPe: 40 }).inputs.futurePe).toBeCloseTo(26.68, 10);
  });
  it('takes historicalAvgPe when it is lower (never exercised by the fixture)', () => {
    const capped = marginOfSafety({ ...F, historicalAvgPe: 18 });
    expect(capped.inputs.futurePe).toBeCloseTo(18, 10);
    expect(capped.sticker).toBeLessThan(marginOfSafety(F).sticker);
  });
});

describe('input guards — a silent zero must never produce a plausible price (§6.1)', () => {
  it('rejects mosPct >= 1 instead of dividing by zero', () => {
    expect(() => paybackTime({ fcfPerShare: 14.3, g: 0.1, years: 8, mosPct: 1 })).toThrow(RangeError);
  });
  it('rejects zero shares', () => {
    expect(() => tenCap({ ...F, shares: 0 })).toThrow(RangeError);
  });
  it('rejects NaN inputs', () => {
    expect(() => tenCap({ ...F, cfo: Number.NaN })).toThrow(RangeError);
  });
  it('rejects a non-integer payback window', () => {
    expect(() => paybackTime({ fcfPerShare: 14.3, g: 0.1, years: 8.5, mosPct: 0.5 })).toThrow(RangeError);
  });
  it('is sign-tolerant on capex', () => {
    expect(tenCap({ ...F, capex: 151003 }).price).toBeCloseTo(tenCap(F).price, 10);
  });
});
