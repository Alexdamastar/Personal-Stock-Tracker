import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type {
  DashboardData, OpenAlertData, RuleData, RuleKind, SecurityData, TickData,
  ValuationData, ValuationMethod,
} from '../lib/dashboard-types.js';
import { latestPbtBuyJoin } from './queries.js';
import { rowsOf } from './rows.js';
import { positions, priceTicks, securities, valuations } from './schema.js';
import type { Db } from './seed.js';

/**
 * §5 M5 loader: everything the dashboard needs, read from the database.
 *
 * Raw facts only — nothing is derived here; `buildDashboardRows` does that.
 *
 * FIVE queries regardless of how many securities there are (D4: design for ~50),
 * one per concern, stitched together in memory by security id:
 *   1. active securities + judgment inputs + positions.avg_cost   (query builder)
 *   2. latest tick per active security                            (query builder)
 *   3. enabled rules, D1-resolved threshold, open alert           (raw SQL)
 *   4. latest valuation per (active security, method)             (query builder)
 *   5. the 30 most recent daily bars per active security          (raw SQL)
 *
 * DEFECT-13: raw `db.execute()` results differ by driver (postgres.js returns an
 * array, PGlite `{ rows }`), numerics come back as strings, and timestamptz/date may
 * be a Date or a string. So the query builder is used wherever it can express the
 * query, because Drizzle's column mapping yields the same JS types on every driver.
 * The two raw queries go through `rowsOf()`, parse every numeric with `Number()`,
 * return timestamps as epoch milliseconds and dates via `to_char` — the same
 * discipline as `loadRuleStates`.
 */
export async function loadDashboardData(db: Db): Promise<DashboardData> {
  const [securityRows, tickRows, ruleResult, valuationRows, barResult] = await Promise.all([
    // 1. Securities. positions is keyed by security_id, so the left join is at most one row.
    db.select({
      id: securities.id,
      ticker: securities.ticker,
      name: securities.name,
      fcfPerShare: securities.fcfPerShare,
      growthRate: securities.growthRate,
      avgCost: positions.avgCost,
    })
      .from(securities)
      .leftJoin(positions, eq(positions.securityId, securities.id))
      .where(eq(securities.active, true))
      .orderBy(asc(securities.ticker)),

    // 2. Latest tick per security. DISTINCT ON takes the first row of each group in
    //    ORDER BY order, so captured_at DESC selects the newest poll. It is served by
    //    price_ticks_recent_idx (security_id, captured_at desc).
    db.selectDistinctOn([priceTicks.securityId], {
      securityId: priceTicks.securityId,
      price: priceTicks.price,
      prevClose: priceTicks.prevClose,
      capturedAt: priceTicks.capturedAt,
      quoteAt: priceTicks.quoteAt,
      provider: priceTicks.provider,
    })
      .from(priceTicks)
      .innerJoin(securities, and(eq(securities.id, priceTicks.securityId), eq(securities.active, true)))
      .orderBy(priceTicks.securityId, desc(priceTicks.capturedAt)),

    // 3. Rules. latestPbtBuyJoin is THE definition of D1, shared with the evaluator
    //    and resolvedThresholds(), so the dashboard cannot disagree with the alerts
    //    about where a buy line is. The open-alert join yields at most one row per
    //    rule because alert_events_one_open_per_rule is a partial unique index
    //    (DEFECT-02) — a database guarantee, not a hope.
    db.execute(sql`
      select r.id                                       as rule_id,
             r.security_id,
             r.kind,
             coalesce(r.value, lv.buy_price)            as threshold,
             (r.value is not null)                      as pinned,
             oe.id                                      as event_id,
             oe.price                                   as event_price,
             oe.threshold                               as event_threshold,
             extract(epoch from oe.triggered_at) * 1000 as triggered_ms
        from watch_rules r
        join securities s on s.id = r.security_id and s.active
        ${latestPbtBuyJoin}
        left join alert_events oe on oe.rule_id = r.id and oe.cleared_at is null
       where r.enabled
       order by r.security_id, r.kind
    `),

    // 4. Latest valuation per method: (as_of desc, id desc), the append-only read
    //    pattern from latestValuations() — id breaks a same-day restatement tie.
    db.selectDistinctOn([valuations.securityId, valuations.method], {
      securityId: valuations.securityId,
      method: valuations.method,
      buyPrice: valuations.buyPrice,
      stickerPrice: valuations.stickerPrice,
      asOf: valuations.asOf,
      source: valuations.source,
      inputs: valuations.inputs,
    })
      .from(valuations)
      .innerJoin(securities, and(eq(securities.id, valuations.securityId), eq(securities.active, true)))
      .orderBy(valuations.securityId, valuations.method, desc(valuations.asOf), desc(valuations.id)),

    // 5. Bars. The lateral LIMIT picks the 30 NEWEST (date desc); they are then
    //    re-sorted OLDEST first by the outer ORDER BY, which is the order a sparkline
    //    draws in. Getting that backwards draws the chart mirrored, with nothing
    //    looking obviously wrong.
    //    A bar with no close cannot be plotted, so it does not take one of the 30.
    db.execute(sql`
      select s.id                              as security_id,
             to_char(b.date, 'YYYY-MM-DD')     as date,
             b.close
        from securities s
        join lateral (
              select d.date, d.close
                from daily_bars d
               where d.security_id = s.id and d.close is not null
               order by d.date desc
               limit 30
        ) b on true
       where s.active
       order by s.id, b.date asc
    `),
  ]);

  const byId = new Map<number, SecurityData>();
  const result: SecurityData[] = securityRows.map((s) => {
    const data: SecurityData = {
      securityId: s.id,
      ticker: s.ticker,
      name: s.name,
      latestTick: null,
      rules: [],
      valuations: {},
      judgment: { fcfPerShare: s.fcfPerShare, growthRate: s.growthRate },
      avgCost: s.avgCost,
      bars: [],
    };
    byId.set(s.id, data);
    return data;
  });

  for (const t of tickRows) {
    const target = byId.get(t.securityId);
    if (!target) continue;
    const tick: TickData = {
      price: t.price,
      prevClose: t.prevClose,
      capturedAt: t.capturedAt,
      // DEFECT-01: a null quote_at stays null. Defaulting it would make stale data
      // look fresh on the exact badge that exists to catch it.
      quoteAt: t.quoteAt,
      provider: t.provider,
    };
    target.latestTick = tick;
  }

  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  for (const row of rowsOf<Record<string, unknown>>(ruleResult)) {
    const target = byId.get(Number(row['security_id']));
    if (!target) continue;
    const eventId = num(row['event_id']);
    const openAlert: OpenAlertData | null = eventId === null ? null : {
      eventId,
      price: Number(row['event_price']),
      // DEFECT-20: the threshold stored at trigger time, not the rule's current one.
      threshold: Number(row['event_threshold']),
      triggeredAt: new Date(Number(row['triggered_ms'])),
    };
    const rule: RuleData = {
      ruleId: Number(row['rule_id']),
      // watch_rules_kind_ck restricts kind to these two values.
      kind: String(row['kind']) as RuleKind,
      // Null stays null: a buy rule with no PBT valuation has no line (D1), never zero.
      threshold: num(row['threshold']),
      // postgres.js and PGlite both return a boolean. Accepting 't' too covers a
      // text-protocol driver (problem 5, Neon HTTP) without letting 'f' read as truthy.
      pinned: row['pinned'] === true || row['pinned'] === 't',
      openAlert,
    };
    target.rules.push(rule);
  }

  for (const v of valuationRows) {
    const target = byId.get(v.securityId);
    if (!target) continue;
    const valuation: ValuationData = {
      buyPrice: v.buyPrice,
      stickerPrice: v.stickerPrice,
      asOf: v.asOf,
      // valuations_source_ck / valuations_method_ck restrict both columns.
      source: v.source as ValuationData['source'],
      inputs: v.inputs,
    };
    target.valuations[v.method as ValuationMethod] = valuation;
  }

  // Rows arrive oldest first per security (outer ORDER BY), so push preserves it.
  for (const row of rowsOf<Record<string, unknown>>(barResult)) {
    const target = byId.get(Number(row['security_id']));
    if (!target) continue;
    target.bars.push({ date: String(row['date']), close: Number(row['close']) });
  }

  return { securities: result };
}
