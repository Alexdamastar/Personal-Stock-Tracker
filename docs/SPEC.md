<!-- Original build spec, verbatim. Superseded where docs/PLAN.md, docs/DEFECTS.md or CLAUDE.md say so. The "§" references across the repo point here. -->

# Rule #1 Watchlist — Build Spec

Agent handoff. Execute phases in order. Every acceptance criterion is a runnable test.

## 0. Product

Monitor live prices for a small watchlist. Highlight a ticker when price crosses either
(a) the **buy price** computed by a Rule #1 valuation method, or (b) a manually-set **safe price**.
Phase 2 recomputes buy/sticker prices from SEC filings on each new earnings report.

No push/email. Dashboard-only surface. Free-tier data only.

## 1. Decisions (locked — do not re-litigate)

| # | Decision |
|---|---|
| D1 | Canonical headline buy price = **Payback Time (PBT)**. 10 Cap and MOS computed and stored, shown as secondary. |
| D2 | Sticker price is **display-only**. Never an alert threshold. Derived, not stored independently — see §3.3. |
| D3 | Safe price is a **manual, optional** field. No math. Nullable per ticker. Crossing it = strongest visual state. |
| D4 | Start with 5 tickers; design for ~50. Do not design for 500. |
| D5 | TypeScript end to end. Postgres. No ORM-free raw SQL sprawl — use Drizzle. |
| D6 | Delayed quotes (15–20 min) are acceptable and assumed. |

## 2. Stack

| Layer | Choice | Note |
|---|---|---|
| App | Next.js (App Router), TypeScript | Server components read DB directly |
| DB | Postgres — Neon or Supabase free tier | |
| Scheduler | **Cloudflare Workers Cron Trigger** → authenticated `/api/poll` | see below |
| Styling | Tailwind | |
| Quotes | Finnhub primary, Twelve Data fallback | |
| Fundamentals | SEC EDGAR XBRL (free, no key) | Phase 2 |

### Scheduler — cost-ranked

Polling load is tiny: 79 polls/trading day (09:30–16:00 ET at 5-min intervals, inclusive)
≈ **1,659 invocations/month** at 21 trading days.

| Option | Cost | Verdict |
|---|---|---|
| **Cloudflare Workers Cron Trigger** | Free — 100k req/day, 5 cron triggers/account, 1-min granularity | **Use this.** 1,659/mo against a ~3M/mo allowance |
| Supabase `pg_cron` | Free on Supabase free tier | Good alternative if DB is already Supabase |
| GitHub Actions cron | Free (unlimited on public repos; 2,000 min/mo private) | Fallback. Schedules drift under load; workflows auto-disable after 60 days of repo inactivity |
| Vercel Cron | **Hobby = once per day.** Needs Pro at $20/mo | Rejected |
| Fly.io machine | **No free tier as of 2026** (trial only). ~$4.30/mo for one always-on machine | Rejected |
| Claude Cowork scheduled task | Burns a model session per firing; **hourly minimum interval** | Rejected for polling. See §8 |

Worker constraints to respect: free-plan CPU ceiling is 10 ms per invocation — network wait does not
count, and parsing 5 quotes plus a few comparisons is sub-millisecond, so this is not binding.
Workers cannot open raw TCP to Postgres: use **Neon's HTTP serverless driver** (or Supabase's REST
endpoint). The Worker holds the bearer token and calls `/api/poll`, or does the whole poll itself and
writes over HTTP — either is fine, keep the evaluator logic in one place.

### Quote providers

| Provider | Free limit | Delay | Role |
|---|---|---|---|
| Finnhub | 60/min | ~20 min | Primary |
| Twelve Data | 800/day | ~4 hr | Fallback. 79 batched calls/day, or 395 credits if billed per symbol — both under 800 |
| Alpha Vantage | 5/min | 15 min | Second fallback |
| Yahoo/yfinance | — | — | **Do not use.** Unofficial, no SLA |
| IEX Cloud | — | — | **Do not use.** Retail data sunset |

Interface:

```ts
interface QuoteProvider {
  name: string;
  getQuotes(tickers: string[]): Promise<Quote[]>; // { ticker, price, at }
}
```

Failover on 429/timeout, 3 attempts, exponential backoff. Record `provider` on every tick.

## 3. Valuation math (VERIFIED — use as golden tests)

All formulas below were reverse-engineered from the Rule #1 Toolbox and reconcile to its
displayed output for AMZN. Treat §3.4 as fixtures.

### 3.1 Inputs

| Symbol | Meaning | Source |
|---|---|---|
| `cfo` | Cash from operations, TTM | SEC |
| `capex` | Capital expenditures, TTM (negative) | SEC |
| `maintPct` | % of capex treated as maintenance | **Manual per security**, default 0.70 |
| `tax` | Income tax provision, TTM | SEC |
| `shares` | Shares outstanding | SEC |
| `epsTtm` | Diluted EPS, TTM | SEC |
| `g` | Future growth rate (decimal) | Manual or computed — see §6.2 |
| `marr` | Minimum acceptable rate of return | Default 0.15 |
| `mosPct` | Margin of safety | Default 0.50 |
| `fcfRatio` | FCF-to-net-income ratio | **Derivation unresolved — see §6.3** |
| `fcfPerShare` | Free cash flow per share | `epsTtm × fcfRatio` (verified) |
| `pbtYears` | Payback window | Default 8 |

### 3.2 Formulas

```
maintCapex   = abs(capex) * maintPct
ownerEarnings= cfo - maintCapex + tax
oePerShare   = ownerEarnings / shares
tenCapPrice  = oePerShare * 10

futureEps    = epsTtm * (1 + g) ** 10
futurePe     = min(2 * g * 100, historicalAvgPe)   // historicalAvgPe optional; Toolbox used 2*g%
futureValue  = futureEps * futurePe
mosSticker   = futureValue / (1 + marr) ** 10
mosPrice     = mosSticker * (1 - mosPct)

pbtPrice     = sum(n = 1..pbtYears) of fcfPerShare * (1 + g) ** n
pbtSticker   = pbtPrice / (1 - mosPct)

// inverse, for the dashboard: years of FCF to recoup a given price
pbtYearsAt(price):
  accumulate fcfPerShare * (1+g)**n for n = 1,2,3...
  return n_last_full + (price - cumBefore) / contributionOfYear(n_last_full + 1)
```

### 3.3 Sticker direction — ANSWERED

The Toolbox reports every method as a `{price, sticker}` pair, and with `mosPct = 0.50`
each sticker is exactly 2× its price. **That 2× is an artifact of the 50% setting, not a formula.**
The relationship is `sticker = price / (1 - mosPct)`.

Which side is primary differs by method:

| Method | Primary calculation | Derived side |
|---|---|---|
| MOS | `mosSticker` (discounted future value) | `mosPrice = sticker × (1 - mosPct)` |
| 10 Cap | `tenCapPrice` (owner earnings × 10) | `sticker = price / (1 - mosPct)` |
| PBT | `pbtPrice` (n-year FCF sum) | `sticker = price / (1 - mosPct)` |

Evidence: `mosSticker` 192.86 is independently derivable as `futureValue / 1.15^10` — it is a real
intrinsic-value estimate. `tenCapPrice` 62.23 and `pbtPrice` 209.29 are independently derivable as
prices; their stickers are not derivable any other way than dividing by `(1 - mosPct)`.

**Never hardcode 2×.** At `mosPct = 0.25`, `mosSticker` stays 192.86 while `mosPrice` becomes 144.65,
and `tenCapPrice` stays 62.23 while its sticker becomes 82.97.

> Optional 30-second confirmation: change MOS% to 25% in the Toolbox and observe which number in each
> pair holds still. Not required to proceed.

### 3.4 Golden test fixture — AMZN

```ts
const AMZN_FIXTURE = {
  input: {
    cfo: 148531.0, capex: -151003.0, maintPct: 0.70, tax: 24094.0,
    shares: 10754.252, epsTtm: 8.36, g: 0.1334, marr: 0.15, mosPct: 0.50,
    fcfPerShare: 14.30, pbtYears: 8, lastPrice: 266.03,
  },
  expect: {
    maintCapex: 105702.1, ownerEarnings: 66922.9, oePerShare: 6.22,
    tenCapPrice: 62.23,  tenCapSticker: 124.46,
    futureEps: 29.24, futurePe: 26.68, futureValue: 780.23,
    mosSticker: 192.86, mosPrice: 96.43,
    pbtPrice: 209.29,   pbtSticker: 418.58,
    pbtYearsAtLastPrice: 9.26,
  },
};
```

Tolerances: `±0.01` on most values; `±0.05` on `maintCapex`, `ownerEarnings`, `mosSticker`;
`±0.15` on `futureValue`; `±0.10` on `pbtPrice`; `±0.20` on `pbtSticker`; `±0.02` on `pbtYearsAtLastPrice`.

**Compute `pbtPrice` from `epsTtm × fcfRatio` (= 14.2956), not from the displayed 14.30.**
The rounded input yields 209.35; the exact one yields 209.2876 against a target of 209.29.

> **Two different share counts are in play — do not normalize them.**
> `oePerShare` (10 Cap) uses the cover-page count, 10,754.252M — verified, it reproduces 6.22.
> `epsTtm` uses diluted weighted-average shares, which SEC reports as ~10,845M for AMZN's most
> recent quarter. `8.36 × 10,845 ≈ 90,660M`, consistent with AMZN's TTM net income. An agent that
> "fixes" this by using one share count everywhere will break the 10 Cap fixture.

**Verification status:** all 15 assertions in `verify.py` pass, including the M4 evaluator replay
and the polling budget. Port that script to the project's test runner as the first test file.

## 4. Schema

```sql
CREATE TABLE securities (
  id          serial PRIMARY KEY,
  ticker      text UNIQUE NOT NULL,
  name        text NOT NULL,
  cik         text,                    -- 10-digit padded, Phase 2
  maint_pct   numeric DEFAULT 0.70,    -- judgment input, per security
  active      boolean DEFAULT true
);

-- APPEND-ONLY. New filing => new row. Dashboard reads latest per (security, method).
CREATE TABLE valuations (
  id            serial PRIMARY KEY,
  security_id   int REFERENCES securities(id),
  method        text NOT NULL,         -- 'pbt' | 'mos' | 'ten_cap'
  buy_price     numeric NOT NULL,
  sticker_price numeric NOT NULL,
  growth_rate   numeric,
  marr          numeric,
  mos_pct       numeric,
  inputs        jsonb,                 -- full input object, for reproducibility
  source        text NOT NULL,         -- 'manual' | 'engine'
  as_of         date NOT NULL,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX ON valuations (security_id, method, as_of DESC);

CREATE TABLE watch_rules (
  id          serial PRIMARY KEY,
  security_id int REFERENCES securities(id),
  kind        text NOT NULL,           -- 'safe' | 'buy'
  value       numeric,                 -- NULL for kind='buy' => follows latest pbt valuation
  enabled     boolean DEFAULT true
);

CREATE TABLE price_ticks (
  security_id  int REFERENCES securities(id),
  price        numeric NOT NULL,
  provider     text NOT NULL,
  captured_at  timestamptz NOT NULL,
  PRIMARY KEY (security_id, captured_at)
);

CREATE TABLE daily_bars (
  security_id int REFERENCES securities(id),
  date        date,
  open        numeric, high numeric, low numeric, close numeric,
  PRIMARY KEY (security_id, date)
);

CREATE TABLE alert_events (
  id              serial PRIMARY KEY,
  rule_id         int REFERENCES watch_rules(id),
  price           numeric NOT NULL,
  triggered_at    timestamptz NOT NULL,
  cleared_at      timestamptz,
  acknowledged_at timestamptz
);

CREATE TABLE positions (
  security_id int PRIMARY KEY REFERENCES securities(id),
  avg_cost    numeric,
  shares      numeric
);
```

Notes:
- `valuations` is append-only. Never `UPDATE`. History of the thesis is free.
- `watch_rules.kind='buy'` with `value = NULL` tracks the latest PBT valuation automatically (D1).
  A non-null value pins it.
- Safe price is `kind='safe'`, simple `price <= value` (D3). No operator column, no band —
  the user's "below 400" / "around 220" are just numbers he sets by feel.

### Seed

| ticker | name | buy (pbt) | sticker | safe | avg_cost |
|---|---|---|---|---|---|
| AAPL | Apple Inc. | 121.04 | 242.08 | 200.00 | 228.21 |
| META | Meta Platforms | 841.77 | — | — | 632.78 |
| GOOGL | Alphabet Inc. | 421.50 | 843.00 | — | 239.89 |
| MSFT | Microsoft Corp. | 270.87 | 541.74 | 400.00 | 455.69 |
| AMZN | Amazon.com Inc. | 209.29 | 418.58 | 220.00 | — |

Seed as `source='manual'`, `method='pbt'`. META sticker null → compute for display as
`buy / (1 - 0.50)` = 1683.54, or leave blank; do not block on it.

## 5. Phase 1 — Watchlist

### M1 — Schema + seed
Migrations, Drizzle models, seed script.
**Accept:** `SELECT` reproduces the §4 seed table exactly.

### M2 — Quote provider layer
`QuoteProvider` interface, Finnhub + Twelve Data adapters, env-driven selection, failover.
**Accept:** integration test with a mocked 429 from Finnhub falls through to Twelve Data and returns 5 quotes.

### M3 — Poller
Entry point `/api/poll` (bearer-token guarded) + scheduler. Runs every 5 min,
**09:30–16:00 America/New_York, weekdays, skipping NYSE holidays and honoring early closes.**
Writes `price_ticks`, then invokes the evaluator.
**Accept:** unit test asserts the gate returns false for a Saturday, for 08:00 ET, and for 2026-12-25;
true for a normal Tuesday 10:00 ET.
> **Timezone trap:** developer is in Phoenix, which does not observe DST. Market schedule must be
> computed in `America/New_York` explicitly. Never use system-local time.

### M4 — Rule evaluator
Pure function:
```ts
evaluate(rule, price, openEvent): 'trigger' | 'clear' | 'none'
```
- `trigger` when `price <= threshold` and no open event.
- `clear` when an event is open and `price > threshold * 1.005` (0.5% hysteresis).
- Otherwise `none`.

**Accept:** replay a synthetic series `[410, 401, 399, 399.5, 398, 405, 402]` against a
threshold of 400 → exactly one trigger and one clear.

### M5 — Dashboard
One table, sorted by proximity to firing. Per row:

- ticker, live price, % change
- distance to safe price, distance to buy price (both as % and $)
- `pbtYearsAtPrice` — years of FCF to recoup at the current price (better than a raw $ gap)
- avg cost, if set
- **state chip**, encoded in shape + color, not number alone:
  `watching` → `approaching` (within 10%) → `at safe price` → `at buy price`
- 30-day sparkline with safe and buy prices drawn as horizontal rules
- secondary row/expander showing 10 Cap and MOS prices + all three stickers (D2)
- **stale badge** if newest tick > 15 min old during market hours

Semantic colors (good/warn/critical) must be distinct from the brand accent.

**Accept:** with seeded data and a fabricated tick at 195.00 for AAPL, the AAPL row renders
`at safe price` and sorts first.

### M6 — History + manual edit
Alert log with acknowledge buttons. Form to edit buy / sticker / safe by hand, writing a new
`valuations` row with `source='manual'`. Phase 2 writes to the same table — manual entry must
never be removed.

**Phase 1 exit gate:** poller runs unattended 5 trading days with zero gaps in `price_ticks`.
Do not start Phase 2 before this passes.

## 6. Phase 2 — Valuation engine

### 6.1 SEC EDGAR ingest

No API key. Required header: `User-Agent: <name> <email>`. Rate limit **10 req/sec**.

```
https://www.sec.gov/files/company_tickers.json                              # ticker → CIK, refresh monthly
https://data.sec.gov/submissions/CIK{10digit}.json                          # detect new 10-K/10-Q
https://data.sec.gov/api/xbrl/companyconcept/CIK{10digit}/us-gaap/{tag}.json # prefer: small payload
https://data.sec.gov/api/xbrl/companyfacts/CIK{10digit}.json                # everything, large
```

| Input | US-GAAP tag | Hazard |
|---|---|---|
| CFO | `NetCashProvidedByUsedInOperatingActivities` | some filers use `...ContinuingOperations` |
| CapEx | `PaymentsToAcquirePropertyPlantAndEquipment` | AMZN also files `PaymentsToAcquireProductiveAssets`; leases distort |
| Tax | `IncomeTaxExpenseBenefit` | sign flips on benefits |
| Shares | `dei:EntityCommonStockSharesOutstanding` | cover-page figure ≠ diluted weighted-average |
| EPS | `EarningsPerShareDiluted` | must be summed across 4 quarters |
| Net income | `NetIncomeLoss` | needed for FCF ratio, §6.3 |

**Fail loudly on a missing tag.** A silent zero in capex produces a plausible, wrong valuation.

Store facts keyed by accession number. Dedupe preferring the most recently *filed* value —
restatements are real.

> **Overlapping duration frames — observed, not theoretical.** A `companyconcept` series mixes
> frames with different span lengths: ~90-day quarterly, year-to-date cumulative, full-year, and in
> AMZN's case a 12-month frame (`2025-04-01 → 2026-03-31`, $90,798M `NetIncomeLoss`) sitting right
> next to quarterly rows. Taking "the most recent rows" and summing four of them double-counts
> badly — a naive read of exactly this series produced a TTM of $147B against a true figure near
> $91B. **Always filter on `(end - start)` span explicitly** and assert the four selected periods
> are contiguous and non-overlapping before summing.

Validate every parsed series: assert unit is `USD` (or `USD/shares` for EPS), assert the span
matches the frame you asked for, and assert no two selected periods overlap.

### 6.2 Growth rate — not in the filings

The Toolbox's 13.34% is a forward analyst consensus. SEC data cannot produce it. Implement:

1. **Historical calculator (build this).** Rule #1 Big Five growth rates over 1/3/5/9 years:
   equity/book value, EPS, sales, operating cash flow. Free, reproducible. This is "Composite GR".
2. **Manual override.** Always available.
3. Optional later: Finnhub estimates endpoint for "Analyst GR".

Store which one a valuation used in `valuations.inputs`.

### 6.3 OPEN — the PBT cash-flow input (narrowed, not resolved)

**Established:** `fcfPerShare = epsTtm × fcfRatio` (8.36 × 1.71 = 14.2956). Verified — it reproduces
`pbtPrice` 209.29 to within 0.003. So the only unknown is how the Toolbox derives `fcfRatio`.

**Ruled out** as the FCF definition (each computed against the fixture):

| Candidate | Implied FCF/share | Verdict |
|---|---|---|
| `cfo - capex` | **-0.23** | Impossible — negative. AMZN's capex exceeds CFO |
| `cfo - maintCapex` | 3.98 | Off by 3.6× |
| `ownerEarnings` | 6.22 | Off by 2.3× |
| `cfo` ÷ cover-page shares | 13.81 | Closest, still 3.4% low |

**Best remaining hypothesis:** `FCF = cash from operations`. It requires a share count of 10,390M
to land exactly on 14.2956 — but SEC reports AMZN diluted weighted-average shares at ~10,845M and
cover-page at 10,754M, so this does **not** reconcile. Roughly a 4% gap remains unexplained.

**Second hypothesis, now favored:** `fcfRatio` is a *multi-year average* FCF-to-net-income ratio, not
a current-period ratio. The Toolbox renders a refresh icon (↻) beside the FCF Ratio field, which
suggests a derived/recomputed value rather than a straight read from the current filing. A trailing
average would explain why no single-period definition reconciles.

**Two experiments to close this, cheapest first:**

1. In the Toolbox, hover/click the ↻ beside FCF Ratio — check for a tooltip or a definition, and see
   whether the value changes on refresh.
2. Pull the same panel for **MSFT**, where capex is well below CFO so all candidate definitions give
   distinct positive numbers. Solve for which reproduces its `fcfRatio` and `fcfPerShare`. AAPL is a
   useful third data point.

Record the answer here when found.

**Until resolved:** `paybackTime()` takes `fcfPerShare` as an explicit input and the engine leaves it
manual. Everything else in Phase 2 can proceed — this blocks one input, not the pipeline.

### 6.4 TTM derivation

TTM is not a reported field. AMZN's FY2025 10-K reports CFO 139,514; the fixture needs 148,531.

Cash-flow items in a 10-Q are **year-to-date cumulative**, not quarterly:

```
Q4         = FY - Q3_YTD
TTM(flow)  = latest_YTD + prior_FY - prior_year_YTD_at_same_quarter
TTM(stock) = latest value only   // share counts do not sum
```

**Accept:** returns 148,531 for AMZN CFO at the fixture's quarter.

### 6.5 Engine

Three pure functions — `tenCap()`, `marginOfSafety()`, `paybackTime()` — each taking an explicit
input object, returning `{ price, sticker, inputs }`. No DB access, no fetching, no I/O.
Every value in §3.4 is a test case.

### 6.6 Calibration harness

Run all three methods × all five tickers, diff against §4 seed.
**Accept:** AMZN returns `62.23 / 96.43 / 209.29` within §3.4 tolerances; other four within ±2%.
Anything worse means a tag mapping or a TTM window is wrong — fix, do not widen the tolerance.

### 6.7 Filing watcher

Daily job polling `submissions` per CIK. New 10-K/10-Q → refetch facts → recompute all three
methods → insert new `valuations` rows → dashboard shows a "prices updated" banner with the delta
from the previous row. `watch_rules` with `value = NULL` follow automatically.

## 7. Known hazards

1. **XBRL tag drift** between filing years. Fail loudly; never substitute zero.
2. **10 Cap collapses on capital-heavy compounders.** AMZN capex > CFO → $62 vs a $266 market price.
   Working as designed. UI must show all three methods so the headline is never mistaken for consensus.
3. **`maintPct = 70%` is a judgment call**, not a filed fact. Per-security, visible, editable.
4. **Free-tier throttling / provider outage.** The stale badge (M5) is what makes silent failure visible.
5. **Restatements** change history. Append-only `valuations` preserves what was believed and when.
6. **Do not integrate a brokerage API.** Different project, real security surface. `positions.avg_cost` stays manual.

## 8. Where a Claude Cowork scheduled task does belong

Not the price poller — that is a numeric comparison running 78×/day, and a scheduled task spends a
model session per firing with an hourly floor on frequency. Wrong tool, ~1,600× the cost of a Worker.

It is a reasonable fit for **§6.7, the filing watcher**, and only there:

- Frequency is daily or weekly, not 5-minute.
- The work is judgment-shaped: a new 10-Q dropped, a tag was renamed between filings, a derived
  number looks wrong versus last quarter. That is exactly the class of thing that is annoying to
  encode as rules and cheap to hand to a model.
- It is a useful **stopgap before Phase 2 exists**: a daily task that checks EDGAR for new filings on
  the 5 CIKs and reports what changed gives most of the Phase 2 value while the engine is still being
  built, at ~30 firings/month.

Once §6.5–6.7 are implemented and calibrated, move it into code and retire the task.

## 9. Verification log

Everything below was checked, not assumed. Re-verify anything older than ~3 months.

### Math — 15/15 assertions pass (`verify.py`, shipped alongside this spec)

All of §3.4 recomputed from raw inputs: `maintCapex`, `ownerEarnings`, `oePerShare`, `tenCapPrice`,
`tenCapSticker`, `futureEps`, `futurePe`, `futureValue`, `mosSticker`, `mosPrice`, `pbtPrice`,
`pbtSticker`, `pbtYearsAtLastPrice`, plus the M4 evaluator replay (exactly 1 trigger, 1 clear) and
the polling budget. Largest residual: `pbtYearsAtLastPrice` 9.2524 vs 9.26 displayed.

### External facts

| Claim | Status | Checked |
|---|---|---|
| SEC XBRL API: no key, `User-Agent` required, 10 req/sec | Confirmed | 2026-08-29 |
| `companyconcept` endpoint returns usable data for AMZN | Confirmed by live call | 2026-08-29 |
| AMZN FY2025 CFO = 139,514M (vs fixture TTM 148,531M) | Confirmed — TTM ≠ FY, §6.4 stands | 2026-08-29 |
| AMZN diluted WA shares ~10,845M ≠ cover-page 10,754M | Confirmed | 2026-08-29 |
| Vercel Hobby cron = once/day max | Confirmed | 2026-08-29 |
| Cloudflare Workers free: 100k req/day, 5 cron triggers/account, 1-min floor, 10ms CPU | Confirmed | 2026-08-29 |
| Fly.io has no free tier in 2026 (~$4.30/mo minimum) | Confirmed | 2026-08-29 |
| Finnhub 60/min free; Twelve Data 800/day; Alpha Vantage 5/min | Confirmed | 2026-08-29 |
| Yahoo/yfinance unofficial, no SLA; IEX retail sunset | Confirmed | 2026-08-29 |

### Corrections applied during verification

1. Polling count 78 → **79**/day (both endpoints inclusive); monthly 1,640 → **1,659**.
2. Scheduler was Fly.io; its free tier is gone → **Cloudflare Workers**.
3. `pbtPrice` must use `epsTtm × fcfRatio`, not the displayed `14.30` (209.35 vs 209.29).
4. Added the dual-share-count warning to §3.4 — the single most likely thing for an agent to
   "helpfully" break.
5. Added the overlapping-XBRL-frames warning to §6.1 after observing the exact failure.
6. §6.3 narrowed: three candidate FCF definitions ruled out arithmetically; `cfo` identified as
   closest but still 4% off; multi-year-average hypothesis added.

### Known-unverified

- Whether `futurePe` should be `min(2×g%, historicalAvgPe)` — the fixture never exercises the
  `historicalAvgPe` branch because `2×g%` was lower. Implement both, test the branch separately.
- Exact NYSE holiday and early-close calendar — use a maintained library
  (`pandas_market_calendars` equivalent, or `@nasdaq/market-calendar`), do not hand-code 10 dates.
- The other four tickers' fixtures. Only AMZN has a full input panel captured. §6.6 calibration will
  be approximate for AAPL/META/GOOGL/MSFT until their panels are pulled.
- Neon HTTP driver inside a Cloudflare Worker — standard pattern, not tested here.