/**
 * NYSE regular-session calendar, computed in America/New_York. Shared by the M3
 * poller gate and the M5 stale badge.
 *
 * STUB — the M5 fan-out replaces this file. Signatures are the contract.
 */

export interface Session {
  /** America/New_York calendar date, YYYY-MM-DD. */
  date: string;
  open: Date;
  close: Date;
  earlyClose: boolean;
}

/** Stale threshold: three missed 5-minute polls. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** The regular session on the New York calendar date containing `at`, or null if closed that day. */
export function sessionOn(_at: Date): Session | null {
  throw new Error('not implemented: market-hours (M5 fan-out)');
}

/** True when `at` falls within a session, open and close both inclusive. */
export function isMarketOpen(_at: Date): boolean {
  throw new Error('not implemented: market-hours (M5 fan-out)');
}

/**
 * Poll-age staleness (decision 2026-09-13). True only while the market is open, when
 * more than STALE_AFTER_MS has passed since max(capturedAt, today's open).
 */
export function isStale(_capturedAt: Date | null, _now: Date): boolean {
  throw new Error('not implemented: market-hours (M5 fan-out)');
}
