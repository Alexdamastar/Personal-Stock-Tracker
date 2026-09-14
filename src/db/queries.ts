import { sql } from 'drizzle-orm';
import type { Db } from './seed.js';
import { rowsOf } from './rows.js';

/**
 * Latest valuation per (security, method) — the read pattern the append-only
 * `valuations` table requires (§4).
 *
 * Ordered by (as_of DESC, id DESC): two rows can share an as_of date when a
 * restatement is ingested the same day, and `id` breaks the tie toward the row
 * written last. Ordering by as_of alone is non-deterministic in that case.
 */
export async function latestValuations(db: Db) {
  const result = await db.execute(sql`
    select distinct on (v.security_id, v.method)
           s.ticker, v.method, v.buy_price, v.sticker_price, v.source, v.as_of
      from valuations v
      join securities s on s.id = v.security_id
     order by v.security_id, v.method, v.as_of desc, v.id desc
  `);
  return rowsOf<{
    ticker: string; method: string; buy_price: string;
    sticker_price: string; source: string; as_of: string;
  }>(result);
}

/**
 * D1 in one place. Joins `lv.buy_price` — the latest PBT buy price — onto a
 * `watch_rules r`. Both `resolvedThresholds` and the M4 evaluator use it, so the
 * dashboard and the alerts can never disagree about what a buy rule's threshold is.
 */
export const latestPbtBuyJoin = sql`
      left join lateral (
            select v.buy_price
              from valuations v
             where v.security_id = r.security_id and v.method = 'pbt'
             order by v.as_of desc, v.id desc
             limit 1
      ) lv on r.kind = 'buy'`;

/**
 * Resolve every enabled rule to a concrete threshold.
 *
 * D1/§4: kind='buy' with value IS NULL follows the latest PBT buy price. A
 * non-null value pins it. kind='safe' is always an explicit number (D3).
 * A 'buy' rule with no PBT valuation yet resolves to NULL and must be skipped
 * by the evaluator rather than treated as a threshold of zero.
 */
export async function resolvedThresholds(db: Db) {
  const result = await db.execute(sql`
    select r.id as rule_id,
           s.ticker,
           r.kind,
           coalesce(r.value, lv.buy_price) as threshold,
           (r.value is not null)           as pinned
      from watch_rules r
      join securities s on s.id = r.security_id
      ${latestPbtBuyJoin}
     where r.enabled
     order by s.ticker, r.kind
  `);
  return rowsOf<{
    rule_id: number; ticker: string; kind: string;
    threshold: string | null; pinned: boolean;
  }>(result);
}
