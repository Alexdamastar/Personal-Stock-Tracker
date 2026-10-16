# CLAUDE.md — working state for the Rule #1 Watchlist

Read this first. It is the live state of the project: where things stand, what is
blocked, and which mistakes have already been made and must not be made again.

- **What is true about the code** → `README.md`
- **What is wrong with the spec and what was done about it** → `docs/DEFECTS.md`
- **How the UI must look** → `DESIGN.md`. **Read it before writing or changing any UI**
  (user, 2026-09-13). Tokens live in `src/app/globals.css`; the deviations it forces are
  recorded under "Implementation decisions" below.
- **The build plan as amended** → `docs/PLAN.md` (M6, the exit gate and Phase 2 in full)
- **The original spec** → `docs/SPEC.md`. Every "§" reference in the repo points there.

**Location:** `C:\Users\wwwra\Downloads\VSCode Projects\rule1-watchlist` since 2026-09-13.
The path contains a space; quote it in every shell command. Verified after the move:
75 tests passed and typecheck was clean from the new path.

This file is the index and the memory. Update it at the end of any milestone.

---

## The goal

Monitor live prices for a small watchlist and highlight a ticker when price crosses
either the Rule #1 **Payback Time buy price** (D1) or a manually-set **safe price**
(D3). Dashboard only — no push, no email. Free-tier data only.

Phase 2 recomputes valuations from SEC filings on each new earnings report.

**Not a trading system.** No brokerage API, ever (§7.6). `positions.avg_cost` stays
manual. That is a deliberate scope boundary, not an unfinished feature.

---

## Where things stand — 2026-10-16

| Milestone | State |
|---|---|
| **M1 — schema + seed** | **Complete.** 53 tests (PGlite) + 22 checks on real PostgreSQL 18.6. No schema drift. |
| **M2 — quote provider layer** | **Complete.** 22 tests, injected `fetch`, no network. |
| **M3 — poller** | **Live (2026-10-16).** App on Vercel (https://personal-stock-tracker-delta.vercel.app, env vars Production-only), Worker `rule1-poller` deployed on Cloudflare with POLL_URL/POLL_TOKEN secrets, no workers.dev URL, logs on. `src/db/poll.ts` (`runPoll`, `isAuthorized`), `POST /api/poll` (bearer `POLL_TOKEN`; 401 / 503 demo / 502 nothing written), `worker/` Cloudflare cron that only calls the route. 10 tests. Verified via `next start` on Neon: 401s and `closed` off-session. First Worker-written ticks 2026-10-16 16:40 UTC after the DEFECT-27 fix. **Open:** Phase 1 exit gate (5 clean trading days from 2026-10-19); dashboard is public with no password yet (needed before M6). |
| **M4 — rule evaluator** | **Complete.** 29 tests. Migration 0001 adds `alert_events.threshold`. Verified on PostgreSQL 18.6. |
| **M5 — dashboard** | **Complete.** 167 tests; spec acceptance passes end to end, including through `next start` on PostgreSQL 18.6. Next.js 16 (webpack). PGlite demo when `DATABASE_URL` is unset. |
| M6 — history + manual edit | Not started. Needs dashboard auth first (`docs/PLAN.md`). |
| Phase 2 (§6) | Not started. **Start with AMZN 10 Cap**: it needs no growth rate or FCF ratio, so §6.3 does not block it. Only PBT is blocked on §6.3. |

`npm test` → 283 passing. `npm run build` → passes. `npx tsc --noEmit` → clean. `npm audit` → 0 high, 0 critical
(6 moderate, all dev tooling).

---

## Problems — the live list

### Blocking, and not fixable in code

1. ~~No API keys.~~ **Live (2026-10-15).** `.env` holds both; `npx tsx --env-file=.env
   scripts/quote.ts AAPL META GOOGL MSFT AMZN` returned 5/5 from Finnhub with previous
   closes, no failover. `.env` is gitignored and must stay that way.
2. ~~No hosted database.~~ **Neon, live (2026-10-15).** Migrations 0000-0003 applied,
   §4 seeded, `db:verify` 33/33, and the dashboard renders against it with no DEMO
   banner. `.env` uses the POOLED endpoint. Free tier suspends after ~5 min idle.
3. ~~No remote.~~ `origin` is github.com/Alexdamastar/Personal-Stock-Tracker. Run
   `git fetch` before trusting `git status` ahead/behind. Pushing `master` redeploys
   the app on Vercel; `worker/` changes deploy separately with `npx wrangler deploy`.

### Known risks, already understood

4. ~~Only a throwaway Postgres.~~ **Verified on Neon** (2026-10-15): 33/33 including
   migration 0003, which had never run on real Postgres.
5. ~~Neon HTTP driver~~ — moot: the Worker calls `/api/poll` over HTTP and never
   touches the database. If a Worker ever queries Postgres directly, its driver is a
   third `db.execute()` result shape (DEFECT-13 class); verify it in `src/db/rows.ts`.
6. **Twelve Data's free tier breaks the fallback at 9 tickers** (DEFECT-18). 8
   credits/**minute**, billed per symbol. D4 says "design for ~50"; the free tier
   cannot reach it at any daily budget. Decision on 2026-09-09: build for today's 5,
   record the ceiling. `twelveDataBudget()` plus tests #17/#18 make growth past 8 a
   failing build rather than a silent production failure.
7. ~~Cloudflare cron is UTC-only~~ (DEFECT-03) — done in `worker/wrangler.toml`:
   `*/5 13-21 * * MON-FRI`, and `runPoll`'s ET gate is the authority. Use day NAMES:
   Cloudflare counts 1 = Sunday, so `1-5` skipped every Friday (DEFECT-27, 2026-10-16).
8. **Disabling a rule freezes its open alert** (DEFECT-22). The evaluator only
   reads enabled rules. M6's disable action must close the event in the same
   transaction.
9. **The market calendar ends 2027-12-31** (DEFECT-14, resolved). A tripwire test
   starts failing on **2027-11-01**; add 2028 from nyse.com before then.
10. ~~M3's writer obligations~~ (done, tested in `tests/m3-poller.test.ts`): persist `Quote.prevClose` to
   `price_ticks.prev_close` (DEFECT-23), and round to 4 dp before the `> 0` check so
   a tiny value becomes `no_data` rather than a failed insert (DEFECT-26).
11. **Node 22.11 is below jsdom 30's floor.** A conditional vitest flag works around
   it; upgrading Node (22.22+ or 24 LTS) removes the need.

### Open questions for the user

12. **§6.3 — how `fcfRatio` is derived — is genuinely unresolved.** Five candidate
   definitions are ruled out arithmetically in `docs/DEFECTS.md`. Experiment 2 (pull
   the MSFT/AAPL panels) is unrun and gates PBT only (10 Cap and MOS do not use it).
   `fcfPerShare` stays a manual input until it settles.
13. **SEC EDGAR requires `User-Agent: <name> <email>`** (Phase 2, §6.1). That means
   sending the user's email to an external service. **Needs explicit sign-off before
   any EDGAR call** — never assume it.
14. **Is the Toolbox's "Buy Price" always PBT?** For GOOGL it equals the MOS price to
   the cent (401.28) while our seed has 421.50 as PBT. Check GOOGL's calculator
   panel; if the Toolbox mixes methods, D1's seed labels may be wrong.
15. **Not yet built from the user's notes:** a shareable monitoring prompt for
   Nathan, and next-earnings dates on the dashboard.

---

## Implementation decisions made with the user

Asked, not assumed. The code-level ones each have a test that fails if reversed.

| Date | Decision |
|---|---|
| 2026-09-09 | M2: build for today's 5 tickers and record the Twelve Data ceiling (DEFECT-18). |
| 2026-09-13 | M4 ships the pure `evaluate()` **and** the DB writer `runEvaluator()`; M3 just calls it. |
| 2026-09-13 | `alert_events` gains a `threshold` column, migration 0001 (DEFECT-20). |
| 2026-09-13 | An open alert is judged against the rule's **current** threshold, so moving the line can clear it. |
| 2026-09-13 | Ticks older than **15 minutes** are not evaluated (same cutoff as the M5 stale badge). |
| 2026-09-13 | % change uses the **provider's previous close**, stored per tick (migration 0002, DEFECT-23). |
| 2026-09-13 | The state chip is **price-driven**; open alerts are a separate marker. |
| 2026-09-13 | Below both lines, **`at buy price` wins** (resolves D3 vs M5's chip order). |
| 2026-09-13 | pbtYearsAtPrice reads the **latest PBT valuation's inputs**, then the security's judgment inputs. |
| 2026-09-13 | The stale badge reads **poll age** (`captured_at`); quote age is text. Corrects DEFECT-01. |
| 2026-09-13 | With no `DATABASE_URL`, the app runs a **PGlite demo**, re-stamped on each page load (no API cost). |
| 2026-09-13 | M5 built by **five agents in parallel**, one git worktree and branch each, merged by the orchestrator. |
| 2026-09-13 | UI follows **`DESIGN.md`**. Where it is silent or conflicts, these rulings apply: |
| 2026-09-13 | — **Dark mode stays**, with a warm dark palette *derived* from DESIGN.md (it defines light only). |
| 2026-09-13 | — **Status uses DESIGN.md's decorative palette as colored glyphs** on white pills (buy green, safe teal, approaching orange, stale deep orange). Blue is for links and focus only. No row tints. |
| 2026-09-13 | — The **DEMO banner is the deep-indigo band**, the page's single dark moment. |
| 2026-10-16 | Hosting: **Next.js on Vercel, scheduler on Cloudflare** (AWS EventBridge considered, Cloudflare kept). Vercel env vars Production-only and Sensitive; previews run in DEMO mode. |
| 2026-10-16 | Phase 2 starts with **AMZN 10 Cap**, per the user's original notes. |

**When a high-level implementation choice comes up, ask. Don't assume** (user, 2026-09-13).

## Locked decisions — do not re-litigate

| # | |
|---|---|
| D1 | Canonical headline buy price = **Payback Time**. 10 Cap and MOS are stored and shown as secondary. |
| D2 | Sticker price is **display-only**. Never an alert threshold. |
| D3 | Safe price is **manual, optional**, nullable per ticker. No math. |
| D4 | Start with 5 tickers; design for ~50. Not 500. *(See problem 6 — the free tier does not reach 50.)* |
| D5 | TypeScript end to end. Postgres. Drizzle. |
| D6 | Delayed quotes (15–20 min) are acceptable and assumed. |

## Three things that look like bugs and are not

Each has a test that fails if "fixed". Long form in `README.md`.

1. **Two different share counts are in play.** 10 Cap uses the cover-page count
   (10,754.252M); `epsTtm` is already per diluted weighted-average share (~10,845M).
   Normalizing them breaks the 10 Cap fixture.
2. **The 2× between a price and its sticker is an artifact of `mosPct = 0.50`**, not a
   formula. Always `price / (1 - mosPct)`. Which side is primary differs by method.
3. **`fcfPerShare` is a manual input and stays that way** until §6.3 is settled.

---

## How this project works

- **Append-only.** Valuations are never UPDATEd; a new one is inserted and the reads
  resolve the latest. `seed()` is idempotent and skips rather than overwrites.
- **The database is the last line of defence.** Ten CHECK constraints (every money column rejects NaN, DEFECT-24) and a partial
  unique index (`alert_events ... WHERE cleared_at IS NULL`) enforce invariants that
  application code would otherwise be trusted with. Do not weaken them to make a test
  pass.
- **Money comparisons happen in integer ten-thousandths, never raw floats** (DEFECT-21).
  `400 * 1.005 === 401.99999999999994`. `src/lib/evaluate.ts` shows the pattern.
- **Alert timestamps are tick timestamps (`captured_at`), not the wall clock**, so a
  replay is deterministic.
- **`quote_at` is the provider's timestamp and may be NULL. Never default it to
  `now()`** (DEFECT-01). It is shown as "quote 21m old"; defaulting it would make a
  delayed quote look fresh. `captured_at` is the poll time, and it is what the stale
  badge and M4's 15-minute gate read (corrected 2026-09-13).
- **Timezone work is explicit `America/New_York`,** never the session's local zone.
  The developer is in Phoenix, which does not observe DST — a bug there would not
  reproduce locally.
- **No new runtime dependency without a reason.** M2 added none: Node 18+ has global
  `fetch`, and an HTTP client would be dead weight in a Cloudflare Worker. M5 added
  Next.js, React and PGlite (now a runtime dependency, for demo mode).
- **Page loads never call a quote provider.** Only the M3 poller does. The dashboard
  reads the database, so traffic cannot spend API budget or reach a paid tier.
- **The UI is presentational.** Components render `DashboardRow[]` and never fetch.
  `src/lib/dashboard-types.ts` is the contract; change it deliberately.

## Working agreements

These came out of things that actually went wrong. Keep them.

- **Verify a third-party API before writing the adapter for it.** Doing this for M2
  turned up four defects (DEFECT-16..19), one of which — Twelve Data reporting a rate
  limit inside an HTTP 200 body — fails completely silently and looks like a quiet
  market.
- **Mutation-test the guards that matter.** Revert the guard in place, re-run, confirm
  the test actually fails. Three M2 guards were checked this way; the results are in
  the verification record. A test that passes with the code deleted is not a test.
- **Assert on literals, not on recomputation.** The M1 fixture asserts number
  literals; the M2 budget tests encode the credit arithmetic. A limit that lives only
  in a paragraph is a limit nobody re-reads.
- **Do not guess database credentials** against the user's live PostgreSQL server. Use
  a throwaway container:
  ```bash
  docker run -d --name r1w -p 55432:5432 -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=rule1 postgres:18-alpine
  DATABASE_URL='postgres://postgres:verify@127.0.0.1:55432/rule1' npm run db:verify
  docker rm -f r1w
  ```
  `db:verify` deletes rows in `price_ticks` and `daily_bars`. Scratch database only.
- **Re-applying the migration prints Postgres NOTICEs 42P06/42P07.** Those come from
  drizzle's own journal bookkeeping, exit code is 0, and they are not errors.
  `scripts/verify.ts` silences them; `scripts/migrate.ts` deliberately does not.
- **Test timezones from PowerShell, not Git Bash.** Git Bash does not pass named `TZ`
  values to Node, so `TZ=Asia/Tokyo npx vitest` silently runs in Phoenix time.
  `$env:TZ='Asia/Tokyo'; npx vitest run` works.
- **Build with the npm scripts** (`npm run dev` / `npm run build`). They select
  webpack; Turbopack cannot resolve this codebase's `.js` imports of `.ts` files.
- **An agent running `next dev` gets a managed block appended to this file.** Revert it.
- **On Windows, stopping a backgrounded `next start` can leave `node.exe` on the port.**
  Check `Get-NetTCPConnection -LocalPort <port>` and stop that PID.
- **For parallel agents, use one `git worktree` per agent** with disjoint file
  ownership and a contract written first. The harness's own worktree isolation
  fails when the session started outside the repo, so create them with
  `git worktree add` and give each agent its absolute path.
- **No API key is ever committed, logged, or included in an error message.** Finnhub's
  key goes in the `X-Finnhub-Token` header; Twelve Data's has to ride in the query
  string, so `redact()` strips query strings from any URL in an error and removes the
  key verbatim. Test #15 guards this.

---

## Commands

```bash
npm test                 # 283 tests, no database or container required
npm run dev              # dashboard on :3000 — DEMO data unless DATABASE_URL is set
npm run build            # production build (webpack)
npx tsc --noEmit         # strict + noUncheckedIndexedAccess
npm run db:generate      # regenerate the migration from schema.ts
npm run db:migrate       # apply migrations   (needs DATABASE_URL)
npm run db:seed          # idempotent §4 seed (needs DATABASE_URL)
npm run db:verify        # 33 acceptance checks on real Postgres — scratch DB only
```
