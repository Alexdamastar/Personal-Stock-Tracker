/**
 * NYSE regular-session calendar, computed in America/New_York. Shared by the M3
 * poller gate and the M5 stale badge.
 *
 * Every calculation goes through `Intl` with an explicit `America/New_York` zone. The
 * process's local zone is never read: the developer is in Phoenix, which has no DST,
 * so a local-zone bug would only show up in production twice a year.
 * `tests/market-hours.test.ts` runs clean under TZ=America/Phoenix, UTC and Asia/Tokyo.
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

const NY = 'America/New_York';
const OPEN_HHMM = [9, 30] as const;
const CLOSE_HHMM = [16, 0] as const;
const EARLY_CLOSE_HHMM = [13, 0] as const;

interface YearCalendar {
  /** Full-day closures, keyed YYYY-MM-DD. */
  holidays: Readonly<Record<string, string>>;
  /** 13:00 ET closes, keyed YYYY-MM-DD. */
  earlyCloses: Readonly<Record<string, string>>;
}

/**
 * NYSE holidays and early closes, transcribed from the official calendar:
 *   https://www.nyse.com/markets/hours-calendars  ("Holidays & Trading Hours"),
 *   checked 2026-09-13.
 *
 * An explicit table rather than a package (DEFECT-14): `@nasdaq/market-calendar` does
 * not exist on npm and `nyse-holidays` carries no early closes.
 *
 * Things in this table that look wrong and are not (all per the NYSE page):
 * - 2026 has no July 2 early close; July 4 is a Saturday, so July 3 is the holiday.
 * - 2027 has no Christmas Eve early close; Christmas is observed Friday Dec 24.
 * - 2027-12-31 is a normal session: New Year's Day 2028 is a Saturday and NYSE
 *   observes no holiday for it.
 *
 * A year missing from this table throws rather than guessing (§7.1). The tripwire in
 * the test file fails 60 days before the last covered day. NYSE has already published
 * 2028 on the same page; add it from there when extending.
 */
const CALENDAR: Readonly<Record<number, YearCalendar>> = {
  2026: {
    holidays: {
      '2026-01-01': "New Year's Day",
      '2026-01-19': 'Martin Luther King, Jr. Day',
      '2026-02-16': "Washington's Birthday",
      '2026-04-03': 'Good Friday',
      '2026-05-25': 'Memorial Day',
      '2026-06-19': 'Juneteenth National Independence Day',
      '2026-07-03': 'Independence Day (observed)',
      '2026-09-07': 'Labor Day',
      '2026-11-26': 'Thanksgiving Day',
      '2026-12-25': 'Christmas Day',
    },
    earlyCloses: {
      '2026-11-27': 'Day after Thanksgiving',
      '2026-12-24': 'Christmas Eve',
    },
  },
  2027: {
    holidays: {
      '2027-01-01': "New Year's Day",
      '2027-01-18': 'Martin Luther King, Jr. Day',
      '2027-02-15': "Washington's Birthday",
      '2027-03-26': 'Good Friday',
      '2027-05-31': 'Memorial Day',
      '2027-06-18': 'Juneteenth National Independence Day (observed)',
      '2027-07-05': 'Independence Day (observed)',
      '2027-09-06': 'Labor Day',
      '2027-11-25': 'Thanksgiving Day',
      '2027-12-24': 'Christmas Day (observed)',
    },
    earlyCloses: {
      '2027-11-26': 'Day after Thanksgiving',
    },
  },
};

// hourCycle h23: some engines format midnight as "24" under hour12:false.
const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** The New York wall clock at instant `ms`. */
function nyWallClock(ms: number): WallClock {
  const get = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`market-hours: Intl gave no "${type}" part`);
    return Number(part.value);
  };
  const parts = nyParts.formatToParts(ms);
  return {
    y: get(parts, 'year'),
    mo: get(parts, 'month'),
    d: get(parts, 'day'),
    h: get(parts, 'hour'),
    mi: get(parts, 'minute'),
    s: get(parts, 'second'),
  };
}

/** New York's UTC offset at instant `ms`, in ms (negative: EST -5h, EDT -4h). */
function nyOffsetMs(ms: number): number {
  const w = nyWallClock(ms);
  // Date.UTC treats the wall clock as if it were UTC; the difference is the offset.
  // Truncate `ms` to the second because the formatter does.
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC instant of a New York wall-clock time. Resolve the offset at the naive guess,
 * then re-resolve at the result in case the guess landed on the other side of a DST
 * change. 09:30, 13:00 and 16:00 are never inside the 02:00 transition gap, so the
 * second pass is a guard, not a real ambiguity.
 */
function nyInstant(y: number, mo: number, d: number, h: number, mi: number): Date {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const first = naive - nyOffsetMs(naive);
  return new Date(naive - nyOffsetMs(first));
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The regular session on the New York calendar date containing `at`, or null if closed that day. */
export function sessionOn(at: Date): Session | null {
  const ms = at.getTime();
  if (Number.isNaN(ms)) throw new Error('market-hours: sessionOn() was given an invalid Date');

  const { y, mo, d } = nyWallClock(ms);
  const cal = CALENDAR[y];
  if (!cal) {
    // Fail loudly (§7.1): guessing "open" for an unknown year would poll through holidays
    // and flag stale badges on days the market is shut.
    throw new Error(
      `market-hours: no NYSE holiday table for ${y}. Add ${y} to CALENDAR in ` +
        'src/lib/market-hours.ts from https://www.nyse.com/markets/hours-calendars',
    );
  }

  const date = `${y}-${pad2(mo)}-${pad2(d)}`;
  // Weekday of the NY date itself, computed in UTC so no local zone is involved.
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  if (date in cal.holidays) return null;

  const earlyClose = date in cal.earlyCloses;
  const [ch, cm] = earlyClose ? EARLY_CLOSE_HHMM : CLOSE_HHMM;
  return {
    date,
    open: nyInstant(y, mo, d, OPEN_HHMM[0], OPEN_HHMM[1]),
    close: nyInstant(y, mo, d, ch, cm),
    earlyClose,
  };
}

/** True when `at` falls within a session, open and close both inclusive. */
export function isMarketOpen(at: Date): boolean {
  const session = sessionOn(at);
  if (!session) return false;
  const ms = at.getTime();
  // Inclusive close: M3's 79 polls per day include the 16:00 poll.
  return session.open.getTime() <= ms && ms <= session.close.getTime();
}

/**
 * Poll-age staleness (decision 2026-09-13). True only while the market is open, when
 * more than STALE_AFTER_MS has passed since max(capturedAt, today's open).
 */
export function isStale(capturedAt: Date | null, now: Date): boolean {
  if (!isMarketOpen(now)) return false;
  const session = sessionOn(now);
  if (!session) return false; // unreachable: isMarketOpen(now) implies a session
  // Grace period: yesterday's last tick must not read stale the moment the bell rings,
  // so the clock starts no earlier than today's open. A missing tick counts from open.
  const captured = capturedAt ? capturedAt.getTime() : -Infinity;
  const reference = Math.max(captured, session.open.getTime());
  return now.getTime() - reference > STALE_AFTER_MS;
}
