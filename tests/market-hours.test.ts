import { describe, expect, it } from 'vitest';
import { STALE_AFTER_MS, isMarketOpen, isStale, sessionOn } from '../src/lib/market-hours.js';

// Every instant here is a UTC literal with its New York wall time in the comment.
// 2026 DST: EDT (UTC-4) from Sun 2026-03-08 to Sun 2026-11-01, EST (UTC-5) otherwise.
// The file must pass under any local zone. Verified under America/Phoenix, UTC and
// Asia/Tokyo from PowerShell:  $env:TZ='Asia/Tokyo'; npx vitest run tests/market-hours.test.ts
// Not from Git Bash: MSYS silently drops TZ=Asia/Tokyo (and TZ=America/Phoenix) before
// Node sees it, so the run falls back to the system zone and proves nothing.
const at = (iso: string): Date => new Date(iso);

describe('M3 acceptance — the ET market-hours gate', () => {
  it('is closed on a Saturday', () => {
    expect(isMarketOpen(at('2026-09-12T15:00:00Z'))).toBe(false); // Sat 11:00 EDT
  });

  it('is closed at 08:00 ET on a weekday', () => {
    expect(isMarketOpen(at('2026-09-15T12:00:00Z'))).toBe(false); // Tue 08:00 EDT
  });

  it('is closed on 2026-12-25', () => {
    expect(isMarketOpen(at('2026-12-25T15:00:00Z'))).toBe(false); // Fri 10:00 EST
  });

  it('is open on a normal Tuesday at 10:00 ET', () => {
    expect(isMarketOpen(at('2026-09-15T14:00:00Z'))).toBe(true); // Tue 10:00 EDT
  });
});

describe('sessionOn()', () => {
  it('returns the session as UTC instants during EDT', () => {
    expect(sessionOn(at('2026-09-15T14:00:00Z'))).toEqual({
      date: '2026-09-15',
      open: at('2026-09-15T13:30:00Z'),
      close: at('2026-09-15T20:00:00Z'),
      earlyClose: false,
    });
  });

  it('returns the session as UTC instants during EST', () => {
    expect(sessionOn(at('2026-12-01T15:00:00Z'))).toEqual({
      date: '2026-12-01',
      open: at('2026-12-01T14:30:00Z'),
      close: at('2026-12-01T21:00:00Z'),
      earlyClose: false,
    });
  });

  it('uses the New York date, not the UTC or local date', () => {
    // 03:00Z Wed is 23:00 EDT Tue — and already Wednesday in Tokyo.
    expect(sessionOn(at('2026-09-16T03:00:00Z'))?.date).toBe('2026-09-15');
    // 23:30 EDT Fri is Saturday in UTC, but the NY date is a trading Friday.
    expect(sessionOn(at('2026-09-19T03:30:00Z'))?.date).toBe('2026-09-18');
    // 22:00 EDT Sun is Monday in UTC: still a NY Sunday, so closed.
    expect(sessionOn(at('2026-09-14T02:00:00Z'))).toBeNull();
  });

  it('returns null on weekends', () => {
    expect(sessionOn(at('2026-09-12T15:00:00Z'))).toBeNull(); // Sat
    expect(sessionOn(at('2026-09-13T15:00:00Z'))).toBeNull(); // Sun
  });
});

describe('DST — the same UTC instant flips between in-session and pre-market', () => {
  it('13:35Z is 09:35 EDT (open) after DST starts', () => {
    expect(isMarketOpen(at('2026-03-10T13:35:00Z'))).toBe(true); // Tue 09:35 EDT
  });

  it('13:35Z is 08:35 EST (closed) after DST ends', () => {
    expect(isMarketOpen(at('2026-11-03T13:35:00Z'))).toBe(false); // Tue 08:35 EST
    expect(isMarketOpen(at('2026-11-03T14:35:00Z'))).toBe(true); // Tue 09:35 EST
  });

  it('the first session after each transition opens at the new offset', () => {
    expect(sessionOn(at('2026-03-09T15:00:00Z'))?.open).toEqual(at('2026-03-09T13:30:00Z'));
    expect(sessionOn(at('2026-11-02T15:00:00Z'))?.open).toEqual(at('2026-11-02T14:30:00Z'));
  });
});

describe('session boundaries are inclusive to the second', () => {
  it('09:29:59 ET is closed, 09:30:00 ET is open', () => {
    expect(isMarketOpen(at('2026-09-15T13:29:59Z'))).toBe(false);
    expect(isMarketOpen(at('2026-09-15T13:30:00Z'))).toBe(true);
  });

  it('16:00:00 ET is open (the 79th poll), 16:00:01 ET is closed', () => {
    expect(isMarketOpen(at('2026-09-15T20:00:00Z'))).toBe(true);
    expect(isMarketOpen(at('2026-09-15T20:00:01Z'))).toBe(false);
  });
});

describe('early closes', () => {
  it('2026-11-27 (day after Thanksgiving): 13:00 ET is open, 13:05 ET is closed', () => {
    expect(isMarketOpen(at('2026-11-27T18:00:00Z'))).toBe(true); // 13:00 EST
    expect(isMarketOpen(at('2026-11-27T18:05:00Z'))).toBe(false); // 13:05 EST
  });

  it('2026-12-24 closes at 13:00 ET and is flagged earlyClose', () => {
    expect(sessionOn(at('2026-12-24T15:00:00Z'))).toEqual({
      date: '2026-12-24',
      open: at('2026-12-24T14:30:00Z'),
      close: at('2026-12-24T18:00:00Z'),
      earlyClose: true,
    });
  });
});

describe('the holiday table matches the NYSE calendar', () => {
  // Literals, transcribed independently from https://www.nyse.com/markets/hours-calendars.
  const holidays = [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
    '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
    '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  ];
  const earlyCloses = ['2026-11-27', '2026-12-24', '2027-11-26'];

  it('Good Friday 2026 is closed', () => {
    expect(sessionOn(at('2026-04-03T14:00:00Z'))).toBeNull(); // Fri 10:00 EDT
    expect(isMarketOpen(at('2026-04-03T14:00:00Z'))).toBe(false);
  });

  it.each(holidays)('%s is a full-day holiday', (date) => {
    expect(sessionOn(at(`${date}T16:00:00Z`))).toBeNull(); // midday ET in either offset
  });

  it.each(earlyCloses)('%s closes early at 13:00 ET', (date) => {
    const s = sessionOn(at(`${date}T16:00:00Z`));
    expect(s?.earlyClose).toBe(true);
    // All three fall in EST, so 13:00 ET is 18:00Z.
    expect(s?.close).toEqual(at(`${date}T18:00:00Z`));
  });

  it.each([
    ['2026-07-02', '2026-07-02T20:00:00Z', 'no early close before an observed Friday July 3'],
    ['2027-12-23', '2027-12-23T21:00:00Z', 'no early close before an observed Friday Christmas'],
    ['2027-12-31', '2027-12-31T21:00:00Z', 'no New Year holiday observed for Sat 2028-01-01'],
    ['2026-11-03', '2026-11-03T21:00:00Z', 'Election Day is a normal session'],
  ])('%s is a full normal session, closing %s (%s)', (date, close) => {
    const s = sessionOn(at(`${date}T16:00:00Z`));
    expect(s?.earlyClose).toBe(false);
    expect(s?.close).toEqual(at(close));
  });
});

describe('isStale() — poll age, only while the market is open (decision 2026-09-13)', () => {
  it('is 15 minutes', () => {
    expect(STALE_AFTER_MS).toBe(900_000);
  });

  it('is false while the market is closed, however old the tick', () => {
    expect(isStale(at('2026-09-01T20:00:00Z'), at('2026-09-12T15:00:00Z'))).toBe(false); // Sat
    expect(isStale(null, at('2026-09-15T12:00:00Z'))).toBe(false); // 08:00 EDT
    expect(isStale(null, at('2026-12-25T15:00:00Z'))).toBe(false); // holiday
  });

  it("is false just after the open with yesterday's last tick (grace from the open)", () => {
    const yesterdayClose = at('2026-09-14T20:00:00Z');
    expect(isStale(yesterdayClose, at('2026-09-15T13:31:00Z'))).toBe(false);
    expect(isStale(yesterdayClose, at('2026-09-15T13:45:00Z'))).toBe(false); // open + 15m exactly
    expect(isStale(yesterdayClose, at('2026-09-15T13:45:00.001Z'))).toBe(true);
  });

  it('exactly 15 minutes is not stale; 15 minutes + 1 ms is', () => {
    const captured = at('2026-09-15T14:00:00Z');
    expect(isStale(captured, at('2026-09-15T14:15:00.000Z'))).toBe(false);
    expect(isStale(captured, at('2026-09-15T14:15:00.001Z'))).toBe(true);
  });

  it('a null capturedAt counts from the open', () => {
    expect(isStale(null, at('2026-09-15T13:45:00Z'))).toBe(false);
    expect(isStale(null, at('2026-09-15T13:45:00.001Z'))).toBe(true);
    expect(isStale(null, at('2026-09-15T15:00:00Z'))).toBe(true);
  });

  it('a fresh tick is not stale', () => {
    expect(isStale(at('2026-09-15T14:55:00Z'), at('2026-09-15T15:00:00Z'))).toBe(false);
  });
});

describe('the table fails loudly outside its years (§7.1)', () => {
  it('throws for a year after the table, naming the year and the file', () => {
    expect(() => sessionOn(at('2028-01-03T15:00:00Z'))).toThrow(/2028.*src\/lib\/market-hours\.ts/);
    expect(() => isMarketOpen(at('2028-01-03T15:00:00Z'))).toThrow(/2028/);
    expect(() => isStale(null, at('2028-01-03T15:00:00Z'))).toThrow(/2028/);
  });

  it('throws for a year before the table, even on a weekend', () => {
    expect(() => sessionOn(at('2025-12-27T15:00:00Z'))).toThrow(/2025/); // Sat
  });

  it('decides the year in New York: 02:00Z on 2028-01-01 is still 2027 there', () => {
    expect(sessionOn(at('2028-01-01T02:00:00Z'))?.date).toBe('2027-12-31'); // 21:00 EST
    expect(() => sessionOn(at('2028-01-01T05:00:00Z'))).toThrow(/2028/); // 00:00 EST
  });

  it('throws on an invalid Date instead of answering', () => {
    expect(() => sessionOn(new Date(Number.NaN))).toThrow(/invalid Date/);
  });
});

describe('TRIPWIRE — extend the holiday table before it runs out', () => {
  // The last New York date the table covers. The first test pins this literal to the
  // table itself, so extending CALENDAR without updating it fails here too.
  const LAST_COVERED_DAY = '2027-12-31';
  const WARN_DAYS = 60;

  it(`${LAST_COVERED_DAY} is the last covered day`, () => {
    expect(() => sessionOn(at(`${LAST_COVERED_DAY}T17:00:00Z`))).not.toThrow();
    expect(() => sessionOn(at('2028-01-01T17:00:00Z'))).toThrow(/no NYSE holiday table/);
  });

  it(`the real clock is more than ${WARN_DAYS} days before ${LAST_COVERED_DAY}`, () => {
    // Deliberately the real wall clock. When this fails, add the next year to CALENDAR
    // in src/lib/market-hours.ts from https://www.nyse.com/markets/hours-calendars.
    const deadline = Date.parse(`${LAST_COVERED_DAY}T00:00:00Z`) - WARN_DAYS * 86_400_000;
    expect(
      Date.now() < deadline,
      `NYSE holiday table ends ${LAST_COVERED_DAY}; extend src/lib/market-hours.ts now`,
    ).toBe(true);
  });
});
