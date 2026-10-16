# Rule #1 Watchlist

Monitors live prices for a small watchlist and highlights a ticker when price
crosses either its Payback Time buy price (D1) or a manually set safe price (D3).
A dashboard only: free-tier data, delayed quotes, and no brokerage API, ever.

**Phase 1 is live.** A Cloudflare cron polls quotes every 5 minutes in NYSE hours,
writes them to Neon Postgres, opens and clears alerts, and the Next.js dashboard on
Vercel shows the result.

```
Cloudflare cron (every 5 min, Mon-Fri)
   └─ POST /api/poll  (bearer POLL_TOKEN)      Next.js on Vercel
        ├─ ET gate: NYSE session? else {"status":"closed"}, no provider call
        ├─ Finnhub -> Twelve Data failover      src/providers/
        ├─ write price_ticks                    src/db/poll.ts
        └─ runEvaluator -> alert_events         src/db/alerts.ts
Dashboard page (reads only, never calls a provider)
```

## Status

| Milestone | State |
|---|---|
| **M1 — schema + seed** | **Complete.** Verified on PostgreSQL 18.6 and Neon. |
| **M2 — quote providers** | **Complete.** Finnhub primary, Twelve Data fallback. See DEFECT-16..19. |
| **M3 — poller** | **Live since 2026-10-16.** `/api/poll` + Cloudflare Worker. See DEFECT-03 and DEFECT-27 (cron day numbering). |
| **M4 — rule evaluator** | **Complete.** Exact 0.5% hysteresis (DEFECT-21). |
| **M5 — dashboard** | **Complete.** PGlite demo when `DATABASE_URL` is unset. |
| M6 — history + manual edit | Not started. Needs dashboard auth first: the edit forms must not be public. |
| Phase 1 exit gate | Running. 5 clean trading days from 2026-10-19: ≥98% of expected ticks, no gap >15 min in market hours, stale badge seen once. |
| Phase 2 — valuations from SEC filings | Not started. The math (`src/lib/valuation.ts`) already reproduces the Toolbox's AMZN panel; the EDGAR ingest is the missing part. |

`npm test` → 283 passing, no database or network needed.

`CLAUDE.md` is the working state: live blockers, locked decisions, traps.
`docs/DEFECTS.md` records every defect found in the spec and in production, and
what later milestones must not repeat.

## The three valuation methods

All three are computed and shown; PBT is the alert line (D1). Stickers are display
only (D2). Checked against the AMZN Toolbox panel, which is the golden fixture:

| Method | Formula | AMZN buy / sticker |
|---|---|---|
| 10 Cap | (CFO − 70% of capex + tax) ÷ cover-page shares × 10 | 62.23 / 124.46 |
| MOS | EPS × (1+g)¹⁰ × 2g P/E, discounted 10 yrs at 15% = sticker; buy = 50% | 96.43 / 192.86 |
| PBT | sum of 8 years of FCF/share growing at g | 209.29 / 418.58 |

## Quick start

```bash
npm install
npm test                 # full suite, PGlite, nothing mocked
npm run dev              # http://localhost:3000; DEMO data unless DATABASE_URL is set
npm run build            # production build (webpack)
```

Use the npm scripts rather than bare `next`: Turbopack cannot resolve the `.js`
imports of `.ts` files this codebase uses, so the scripts select webpack.

With `DATABASE_URL` unset, the app boots an in-process PGlite database filled with
invented prices under a DEMO banner, and `/api/poll` refuses to run (503).

Against a real database:

```bash
npm run db:migrate
npm run db:seed
npm run db:verify     # 33 checks; WRITES AND DELETES ticks, so use a scratch database
npx tsx --env-file=.env scripts/quote.ts AAPL   # one live quote; spends provider budget
curl -X POST -H "authorization: Bearer $POLL_TOKEN" localhost:3000/api/poll   # one poll
```

A throwaway server for `db:verify`:

```bash
docker run -d --name r1w -p 55432:5432 -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=rule1 postgres:18-alpine
DATABASE_URL='postgres://postgres:verify@127.0.0.1:55432/rule1' npm run db:verify
```

## Deploy

**App (Vercel).** Import the repo; set the environment variables below for
Production only, marked Sensitive. Preview deployments then run in DEMO mode and
can never write to the real database.

**Poller (Cloudflare Worker, `worker/`).** It holds no logic, it just POSTs to
`/api/poll` (Workers cannot open a TCP connection to Postgres).

```bash
cd worker
npx wrangler login
npx wrangler secret put POLL_URL      # https://<app>.vercel.app/api/poll
npx wrangler secret put POLL_TOKEN    # same value as on Vercel
npx wrangler deploy
```

The cron is `*/5 13-21 * * MON-FRI` in UTC, wide enough for both EST and EDT; the
ET gate in `runPoll` is the authority, including holidays and early closes. Use day
**names**: Cloudflare counts 1 = Sunday, so `1-5` silently skips Fridays (DEFECT-27).
Worker runs are visible under Workers → `rule1-poller` → Logs.

**Budget.** 5 tickers × 79 polls a day = 395 Finnhub calls/day. Twelve Data's free
tier (8 credits/min) breaks the fallback past 8 tickers (DEFECT-18).

## Environment

```
DATABASE_URL=            # Neon pooled connection string
FINNHUB_API_KEY=
TWELVE_DATA_API_KEY=
POLL_TOKEN=              # bearer token for /api/poll; unset = every call is 401
QUOTE_PROVIDERS=         # optional, failover order, default "finnhub,twelvedata"
QUOTE_TIMEOUT_MS=        # optional, default 5000
```

None of these reach the browser: nothing is prefixed `NEXT_PUBLIC_`, and only
server code reads `process.env`. A provider named in `QUOTE_PROVIDERS` with no key
throws at startup rather than being skipped.

## Layout

```
src/lib/valuation.ts         pure math: tenCap, marginOfSafety, paybackTime, pbtYearsAt
src/lib/evaluate.ts          pure evaluator: trigger / clear / none, exact 0.5% hysteresis
src/lib/market-hours.ts      NYSE sessions 2026-27, early closes, DST, isStale
src/lib/dashboard.ts         view model: chip, distances, sort (DEFECT-10), PBT years
src/providers/               Finnhub, Twelve Data, retry/timeout/redaction, failover
src/db/schema.ts             Drizzle schema with the DEFECTS.md fixes applied
src/db/seed-data.ts          the seed watchlist
src/db/poll.ts               M3: runPoll (gate, fetch, write ticks, evaluate), isAuthorized
src/db/alerts.ts             M4: runEvaluator, race-safe on alert_events
src/db/dashboard-data.ts     dashboard loader
src/db/rollup.ts             daily_bars writer, bucketed in America/New_York
src/db/app-db.ts             DATABASE_URL -> real database; unset -> PGlite demo
src/app/api/poll/route.ts    POST /api/poll
src/app/, src/components/    dashboard page and components (styled to DESIGN.md)
worker/                      Cloudflare cron Worker + wrangler.toml
drizzle/                     migrations 0000-0003
scripts/                     migrate, seed, verify, quote
tests/                       golden fixture, M1/M3/M4/M5 acceptance, providers, calendar, defects
```

## Three things not to "fix"

1. **Two different share counts are in play.** 10 Cap uses the cover-page count
   (AMZN 10,754.252M); `epsTtm` is already per diluted weighted-average share.
   Normalizing them breaks the 10 Cap fixture, and a test fails if you try.

2. **The 2× between a price and its sticker is an artifact of `mosPct = 0.50`,
   not a formula.** Always `price / (1 - mosPct)`. MOS derives its price from its
   sticker; 10 Cap and PBT derive their sticker from their price.

3. **`fcfPerShare` is a manual input and stays that way** until the Toolbox's FCF
   ratio is understood (§6.3). Five candidate definitions are ruled out in
   `docs/DEFECTS.md`. 10 Cap needs no FCF ratio, so it is the natural first method
   for Phase 2's EDGAR ingest.

## Known limits

- The dashboard has no login yet; anyone with its URL can view it. Required before M6.
- The NYSE calendar ends 2027-12-31; a tripwire test fails from 2027-11-01 until 2028 is added.
- Seeded buy prices are Toolbox values from 2026-08-28 and drift as the Toolbox
  recomputes; M6 (manual edit) and Phase 2 keep them current.
