/**
 * Display formatting for the dashboard. Pure string functions, kept apart from the
 * components so the rules ("—" for null, a sign on every percentage) live in one place.
 *
 * Locale and zone are pinned (en-US, America/New_York) rather than read from the
 * server: the page renders on a server whose locale and zone are not the user's, and a
 * market dashboard reads in exchange time (see CLAUDE.md on explicit time zones).
 */

/** Rendered for every absent value, so "no data" never looks like a zero. */
export const EMPTY = '—';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// 'exceptZero' gives "+1.23%" and "-1.23%", and a value that rounds to zero reads
// "0.00%" rather than a misleading "-0.00%".
const signedPct = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});

const signedUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});

const alertTime = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/New_York',
  timeZoneName: 'short',
});

/** `$1,234.56`, or "—". */
export function formatMoney(value: number | null): string {
  return value === null ? EMPTY : usd.format(value);
}

/** A fraction as a signed percentage: 0.0123 -> `+1.23%`, or "—". */
export function formatSignedPct(fraction: number | null): string {
  return fraction === null ? EMPTY : signedPct.format(fraction);
}

/** `+$1.23` / `-$1.23`, or "—". */
export function formatSignedMoney(value: number | null): string {
  return value === null ? EMPTY : signedUsd.format(value);
}

/**
 * Which side of a line the price is on, judged at the cent shown to the user. A
 * sub-cent gap reads "at line" so the words never contradict the `$0.00` beside them.
 */
export type Side = 'above' | 'below' | 'at';

export function sideOf(dollars: number): Side {
  const cents = Math.round(dollars * 100);
  if (cents === 0) return 'at';
  return cents < 0 ? 'below' : 'above';
}

/** Payback Time years at the current price. Infinity is "never within 100 years". */
export function formatPbtYears(years: number | null): string {
  if (years === null) return EMPTY;
  if (!Number.isFinite(years)) return '> 100 yrs';
  return `${years.toFixed(1)} yrs`;
}

/**
 * "quote 20m old". Coarse on purpose: quotes are 15-20 minutes delayed by design (D6),
 * so seconds would be false precision. Null is spelled out, never hidden — a missing
 * provider timestamp must not pass for a fresh quote (DEFECT-01).
 */
export function formatQuoteAge(ms: number | null): string {
  if (ms === null) return 'quote age unknown';
  // A slightly negative age is clock skew between the provider and the poller.
  if (ms < 60_000) return 'quote <1m old';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `quote ${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `quote ${hours}h old`;
  return `quote ${Math.floor(hours / 24)}d old`;
}

/** Alert trigger time in exchange time, e.g. "Sep 12, 3:55 PM EDT". */
export function formatAlertTime(at: Date): string {
  return alertTime.format(at);
}
