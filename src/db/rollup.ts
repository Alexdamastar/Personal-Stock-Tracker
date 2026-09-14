import { sql } from 'drizzle-orm';
import type { Db } from './seed.js';
import { rowsOf } from './rows.js';

/**
 * DEFECT-05: `daily_bars` was declared in §4 but no milestone ever wrote it, while
 * M5 needs 30 days of history for the sparkline. This is that writer.
 *
 * Bars are derived from DELAYED intraday ticks (D6), not an exchange feed:
 *   open  = first tick captured at/after 09:30 America/New_York
 *   close = last  tick captured at/before 16:00 America/New_York
 * They will not match official OHLC and must not be labelled as if they do.
 *
 * §M3 timezone trap: the session-local timezone is never used. The developer is in
 * Phoenix (no DST); market bucketing is done in America/New_York explicitly, so a
 * tick at 21:00 UTC lands on the correct trading day in both EST and EDT.
 */
export async function rollupDailyBars(db: Db, opts: { since?: string } = {}) {
  const since = opts.since ?? '1970-01-01';
  const result = await db.execute(sql`
    with bounded as (
      select security_id, price, captured_at,
             (captured_at at time zone 'America/New_York')::date              as session_date,
             (captured_at at time zone 'America/New_York')::time              as session_time
        from price_ticks
       where (captured_at at time zone 'America/New_York')::date >= ${since}::date
    ), in_session as (
      select * from bounded
       where session_time between time '09:30' and time '16:00'
    )
    insert into daily_bars (security_id, date, open, high, low, close, tick_count)
    select security_id,
           session_date,
           (array_agg(price order by captured_at asc ))[1] as open,
           max(price)                                      as high,
           min(price)                                      as low,
           (array_agg(price order by captured_at desc))[1] as close,
           count(*)                                        as tick_count
      from in_session
     group by security_id, session_date
    on conflict (security_id, date) do update set
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, tick_count = excluded.tick_count
    returning security_id, date, tick_count
  `);
  return rowsOf<{ security_id: number; date: string; tick_count: number }>(result);
}
