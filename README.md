# Rule #1 Watchlist — M1 + M2

Schema, seed, the §3.2 valuation math, and the quote provider layer.
Phase 1 milestones M1 and M2 of the build spec.

Monitors live prices for a small watchlist and highlights a ticker when price
crosses either the Payback Time buy price (D1) or a manually-set safe price (D3).

## Status

| Milestone | State |
|---|---|
| **M1 — schema + seed** | **Complete.** 53 tests passing; verified on PostgreSQL 18.6. |
| **M2 — quote provider layer** | **Complete.** 22 tests passing. See DEFECT-16..19 — four things the spec got wrong about the provider APIs. |
| M3 — poller | Not started. See DEFECT-03 (cron is UTC) and DEFECT-14 (market calendar). |
| **M4 — rule evaluator** | **Complete.** 29 tests passing. Adds migration 0001 (DEFECT-20) and fixes a float boundary in the spec's own formula (DEFECT-21). |
| **M5 — dashboard** | **Complete.** 167 tests, including the spec's acceptance criterion end to end. Next.js 16 app; runs a PGlite demo when `DATABASE_URL` is unset. |
| M6 — history + manual edit | Not started. |

`CLAUDE.md` is the working state — current milestone, live blockers, locked
decisions, and the traps. `docs/DEFECTS.md` records every defect found in the
spec, what was done about it, and what the later milestones must not repeat.

## Quick start

```bash
npm install
npm test                 # full suite — no database or container required
npm run dev              # dashboard at http://localhost:3000 — DEMO data unless DATABASE_URL is set
npm run build            # production build (webpack; see below)
```

With `DATABASE_URL` unset, the app boots an in-process PGlite database, migrates and
seeds it, and fills it with invented prices that show every chip state, under a
DEMO banner. Page loads never call a quote provider in either mode: only the M3
poller does, so dashboard traffic cannot spend API budget.

Use the npm scripts rather than bare `next`: Turbopack cannot resolve the `.js`
imports of `.ts` files this codebase uses, so the scripts select webpack.

Tests run against **PGlite**, an in-process WASM Postgres, applying the same
`drizzle/0000_init.sql` that ships to production. Nothing is mocked.

Against a real database:

```bash
export DATABASE_URL='postgres://user:pass@host/db'
npm run db:migrate
npm run db:seed
npm run db:verify     # 27 acceptance checks; use a scratch database
```

`db:verify` is the one that covers what PGlite cannot: the `postgres.js`
driver, the server's own tzdata, and the constraints as the real planner
enforces them. It writes and deletes rows in `price_ticks` and `daily_bars`,
so do not point it at a database holding real tick history. A throwaway
server is enough:

```bash
docker run -d --name r1w -p 55432:5432 -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=rule1 postgres:18-alpine
DATABASE_URL='postgres://postgres:verify@127.0.0.1:55432/rule1' npm run db:verify
```

## Layout

```
src/lib/valuation.ts   §3.2 pure math — tenCap, marginOfSafety, paybackTime, pbtYearsAt
src/db/schema.ts       Drizzle schema (§4, with the DEFECTS.md fixes applied)
src/db/seed-data.ts    the §4 seed table, verbatim
src/db/seed.ts         idempotent seeder; never UPDATEs a valuation
src/db/queries.ts      latestValuations, resolvedThresholds (append-only read patterns)
src/db/rollup.ts       daily_bars writer, bucketed in America/New_York
src/db/rows.ts         driver-agnostic result normalizer (DEFECT-13)
src/db/alerts.ts       runEvaluator: applies M4 to alert_events; M3 calls it after each poll
src/lib/evaluate.ts    §5 M4 pure evaluator: trigger / clear / none, exact 0.5% hysteresis
src/providers/types.ts       QuoteProvider, Quote, the failure taxonomy (DEFECT-08)
src/providers/http.ts        timeout, retry, concurrency cap, secret redaction
src/providers/finnhub.ts     one call per symbol — there is no batch endpoint (DEFECT-16)
src/providers/twelvedata.ts  batched; errors can arrive inside an HTTP 200 (DEFECT-17)
src/providers/index.ts       env-driven selection + failover orchestrator
src/lib/dashboard-types.ts   M5 contract between loader, view model and UI
src/lib/dashboard.ts         buildDashboardRows: chip, distances, sort (DEFECT-10), pbtYears
src/lib/market-hours.ts      NYSE sessions 2026-27, early closes, DST, isStale
src/db/dashboard-data.ts     loadDashboardData: five queries for any number of securities
src/db/app-db.ts             DATABASE_URL -> real database; unset -> PGlite demo
src/db/demo.ts               demo ticks, bars and alerts; refreshed on each page load
src/app/, src/components/   Next.js App Router page and presentational components
drizzle/0000_init.sql  generated migration
drizzle/0001_alert_threshold.sql  alert_events.threshold (DEFECT-20)
drizzle/0002_tick_prev_close.sql  price_ticks.prev_close (DEFECT-23)
tests/                 golden fixture, M1/M4/M5 acceptance, providers, calendar, dashboard, defect regressions
```

## Three things not to "fix"

1. **Two different share counts are in play (§3.4).** 10 Cap uses the cover-page
   count (10,754.252M); `epsTtm` is already per diluted weighted-average share
   (~10,845M). Normalizing them breaks the 10 Cap fixture. There is a test that
   fails if you try.

2. **The 2× between a price and its sticker is an artifact of `mosPct = 0.50`,
   not a formula (§3.3).** Always `price / (1 - mosPct)`. Which side is primary
   differs by method — MOS derives its price from its sticker, 10 Cap and PBT
   derive their sticker from their price.

3. **`fcfPerShare` is a manual input and stays that way.** §6.3 is genuinely
   unresolved; five candidate definitions are ruled out arithmetically in
   `docs/DEFECTS.md`. Do not let the engine compute it until the panel comparison
   settles the question.

## Environment

```
DATABASE_URL=            # Postgres connection string (Neon or Supabase free tier)
QUOTE_PROVIDERS=         # failover order, default "finnhub,twelvedata"
FINNHUB_API_KEY=
TWELVE_DATA_API_KEY=
QUOTE_TIMEOUT_MS=        # optional, default 5000
```

A provider named in `QUOTE_PROVIDERS` with no key throws at construction rather
than being skipped — silently dropping the primary looks exactly like a healthy
system until the fallback's budget runs out mid-session.

The M2 suite injects a fake `fetch`, so it needs no keys and touches no network.
A live smoke test against real keys is deliberately not part of `npm test`: it
spends real budget and would fail the build on a provider outage.

Note for M3: Cloudflare Workers cannot open a raw TCP socket to Postgres. The
Worker must either call `/api/poll` over HTTP or use Neon's HTTP driver — the
postgres.js client in `src/db/client.ts` will not run inside a Worker.
