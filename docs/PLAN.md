# Build plan, as amended

The original spec is `docs/SPEC.md` ("§" references). This file is the plan as it
stands now: what changed, what is done, and the unbuilt steps in full detail.
Defect numbers refer to `docs/DEFECTS.md`.

## Phase 1 — watchlist

### M1 — schema + seed (done)
Tables: securities, valuations (append-only), watch_rules (buy value NULL = follows
latest PBT; safe needs an explicit value), price_ticks (PK security_id + captured_at;
quote_at = provider stamp; prev_close), daily_bars (rolled up in America/New_York),
alert_events (partial unique index: one open event per rule; threshold column),
positions. Migrations 0000–0003. Seed from the 2026-08-28 Toolbox values:

| Ticker | Buy (PBT) | Sticker | Safe | Avg cost |
|---|---|---|---|---|
| AAPL | 121.04 | 242.08 | 200 | 228.21 |
| META | 841.77 | 1683.54 (derived) | — | 632.78 |
| GOOGL | 421.50 | 843.00 | — | 239.89 |
| MSFT | 270.87 | 541.74 | 400 | 455.69 |
| AMZN | 209.29 | 418.58 | 220 | — |

### M2 — quote providers (done)
Finnhub (one call per symbol, header auth, concurrency 5, halt on 429), Twelve Data
(batched; errors inside HTTP 200). Failover asks the next provider only for unfilled
tickers; `no_data` does not fail over; 3 attempts for transient errors only; keys
redacted. Twelve Data's free tier breaks the fallback past 8 tickers (DEFECT-18).

### M3 — poller (done, live 2026-10-16)
`POST /api/poll` (bearer `POLL_TOKEN`) → `runPoll`: ET session gate → quotes for
active securities → price_ticks (prev_close kept, quote_at never now(), 4 dp rounding,
sub-cent = no_data) → `runEvaluator`. Next.js on Vercel; Cloudflare Worker cron
`*/5 13-21 * * MON-FRI` calls the route (DEFECT-03, DEFECT-27).
Still optional: schedule `rollupDailyBars` so sparklines fill.

### M4 — evaluator (done)
Trigger at price ≤ threshold, clear above threshold × 1.005, in integer
ten-thousandths (DEFECT-21). Open alerts are judged against the rule's current
threshold.

### M5 — dashboard (done)
Price-driven chip (at buy > at safe > approaching ≤10% > watching), open-alert
marker, stale badge (poll age >15 min in market hours), quote age, % change from
previous close, sparkline, all-methods expander. Styled to DESIGN.md.

### Before M6 — dashboard login (not started)
The dashboard is public. M6 adds write actions, so add auth first. Proposed: HTTP Basic auth in a Next.js proxy/middleware with `DASHBOARD_PASSWORD`,
exempting `/api/poll` (it has its own token). Not yet approved by the user.

### M6 — history + manual edit (not started)
Spec: "Alert log with acknowledge buttons. Form to edit buy / sticker / safe by
hand, writing a new `valuations` row with `source='manual'`. Phase 2 writes to the
same table — manual entry must never be removed."
1. Alert log: every alert_events row, newest first, showing the STORED threshold
   (DEFECT-20), not the rule's current one; triggered / cleared / acknowledged times.
2. Acknowledge button: sets acknowledged_at; does not clear the event.
3. Edit form: buy / sticker per method, inserting a new valuations row
   (source='manual', as_of = today). Never UPDATE a valuation.
4. Safe price edit and rule enable/disable. Disabling a rule must close its open
   alert in the same transaction and record why (DEFECT-22).
5. The database already rejects 0, negative and NaN money (migration 0003); surface
   those errors in the form instead of failing silently.
6. UI follows DESIGN.md.

### Phase 1 exit gate (running)
AMENDMENT-C replaces "zero gaps over 5 trading days" with: ≥98% of expected ticks
(≥387 of 395 per day), no gap >15 min in market hours, and the stale badge observed
firing at least once. 2026-10-16 is excluded (DEFECT-27 gap); the run starts
2026-10-19. Do not start Phase 2 before it passes.

## Phase 2 — valuation engine (§6)

**Order changed (2026-10-16):** start with **AMZN 10 Cap**, as the user's original
notes said ("10 cap formula for amazon for starters"). 10 Cap needs only filed facts
(CFO, capex, tax, cover-page shares) — no growth rate and no FCF ratio — so §6.3
does not block it. Target: CFO 148,531 → price 62.23 / sticker 124.46.

- **6.1 EDGAR ingest.** No key; requires `User-Agent: <name> <email>`. **Needs the
  user's explicit sign-off before sending their email.** 10 req/s. Endpoints:
  company_tickers.json, submissions/CIK{10}.json, companyconcept, companyfacts.
  Tags: CFO `NetCashProvidedByUsedInOperatingActivities`; capex
  `PaymentsToAcquirePropertyPlantAndEquipment` (AMZN also `...ProductiveAssets`);
  tax `IncomeTaxExpenseBenefit`; shares `dei:EntityCommonStockSharesOutstanding`;
  EPS `EarningsPerShareDiluted` (sum 4 quarters); `NetIncomeLoss`. Fail loudly on a
  missing tag. Key facts by accession; prefer the most recently filed (restatements).
  Filter frames by (end − start) span; assert contiguous, non-overlapping periods
  and USD units.
- **6.4 TTM.** 10-Q cash flows are year-to-date: TTM = latest YTD + prior FY − prior
  YTD for the same quarter. Point-in-time values (shares) take the latest only.
  Accept: AMZN CFO 148,531.
- **6.2 Growth rate.** Not in filings. Historical Big Five calculator (equity, EPS,
  sales, OCF over 1/3/5/9 years) plus manual override; an analyst growth rate
  (the Toolbox default) maybe later. Record which was used in valuations.inputs.
- **6.3 FCF ratio (open).** fcfPerShare = epsTtm × fcfRatio; how the Toolbox derives
  the ratio is unknown (multi-year average favored). Experiments: hover the ↻ icon
  in the Toolbox; read the MSFT and AAPL panels. Until settled, fcfPerShare is manual
  and PBT stays manual.
- **Open question (2026-10-16):** the Toolbox watchlist's "Latest Buy Price" equals
  the MOS price exactly for GOOGL (401.28), NFLX and EPAM, and differs for AMZN.
  It may show a different method per stock, which would make the seed's GOOGL
  421.50 a PBT number and 401.28 an MOS one. Check GOOGL's calculator panel.
- **6.5 Engine.** Pure functions already exist in `src/lib/valuation.ts` and
  reproduce the AMZN panel.
- **6.6 Calibration.** All methods × 5 tickers against the Toolbox; AMZN 62.23 /
  96.43 / 209.29 within tolerance, others ±2%. Never widen the tolerance to pass.
- **6.7 Filing watcher.** Daily check of submissions per CIK; a new 10-K/10-Q →
  refetch, recompute, append engine valuations, show a "prices updated" banner.
  Next relevant filings: GOOGL 10/29, AMZN and AAPL 10/30 (Q3 2026).

Hazards (§7): XBRL tag drift; 10 Cap collapses for capex-heavy names (always show
all three methods); maintPct is judgment; provider throttling; restatements; no
brokerage API, ever.

## Out of scope by design
Portfolio actions from the original notes ($2k into AMZN, rebalancing after Q4,
brokerage vs. Roth) — no brokerage integration. Not yet built from the notes: a
shareable monitoring prompt for Nathan, and next-earnings dates on the dashboard.
