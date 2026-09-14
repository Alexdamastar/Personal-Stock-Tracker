import { stickerFromPrice } from '../lib/valuation.js';

/**
 * §4 seed. Canonical source of truth for the M1 acceptance criterion.
 *
 * All rows are source='manual', method='pbt' (D1: PBT is the headline buy price).
 * Values were read off Rule #1 Toolbox panels; only AMZN has a full input panel
 * captured, which is why only AMZN carries `inputs` (§9 known-unverified).
 */
export const SEED_AS_OF = '2026-08-28';
export const SEED_MOS_PCT = 0.5;

export interface SeedRow {
  ticker: string;
  name: string;
  /** PBT buy price — the alert threshold (D1). */
  buy: number;
  /**
   * PBT sticker — display only (D2).
   * `null` means the panel did not show one; it is derived at seed time via
   * stickerFromPrice(), never by hardcoding 2x (§3.3).
   */
  sticker: number | null;
  /** Manual, optional (D3). null => no safe rule is created at all. */
  safe: number | null;
  /** Manual only. No brokerage integration, ever (§7.6). */
  avgCost: number | null;
}

export const SEED_ROWS: readonly SeedRow[] = [
  { ticker: 'AAPL',  name: 'Apple Inc.',      buy: 121.04, sticker: 242.08, safe: 200.0, avgCost: 228.21 },
  { ticker: 'META',  name: 'Meta Platforms',  buy: 841.77, sticker: null,   safe: null,  avgCost: 632.78 },
  { ticker: 'GOOGL', name: 'Alphabet Inc.',   buy: 421.50, sticker: 843.00, safe: null,  avgCost: 239.89 },
  { ticker: 'MSFT',  name: 'Microsoft Corp.', buy: 270.87, sticker: 541.74, safe: 400.0, avgCost: 455.69 },
  { ticker: 'AMZN',  name: 'Amazon.com Inc.', buy: 209.29, sticker: 418.58, safe: 220.0, avgCost: null },
];

/** §4: "META sticker null => compute for display as buy / (1 - 0.50) = 1683.54". */
export const resolvedSticker = (row: SeedRow): number =>
  row.sticker ?? Number(stickerFromPrice(row.buy, SEED_MOS_PCT).toFixed(4));

/** §3.4 golden fixture. Stored on AMZN's valuation row for reproducibility. */
export const AMZN_FIXTURE_INPUT = {
  cfo: 148531.0, capex: -151003.0, maintPct: 0.7, tax: 24094.0,
  shares: 10754.252, epsTtm: 8.36, g: 0.1334, marr: 0.15, mosPct: 0.5,
  fcfRatio: 1.71, fcfPerShare: 14.2956, pbtYears: 8, lastPrice: 266.03,
} as const;
