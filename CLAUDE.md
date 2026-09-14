# CLAUDE.md — working state for the Rule #1 Watchlist

Read this first. It is the live state of the project: where things stand, what is
blocked, and which mistakes have already been made and must not be made again.

- **What is true about the code** → `README.md`
- **What is wrong with the spec and what was done about it** → `docs/DEFECTS.md`
- **The build plan as amended** → `C:\Users\wwwra\.claude\plans\mossy-juggling-owl.md`
  *(outside the repo — it does not travel with the project and git does not track it.
  Move it to `docs/PLAN.md`.)*

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

## Where things stand — 2026-09-13

| Milestone | State |
|---|---|
| **M1 — schema + seed** | **Complete.** 53 tests (PGlite) + 22 checks on real PostgreSQL 18.6. No schema drift. |
| **M2 — quote provider layer** | **Complete.** 22 tests, injected `fetch`, no network. |
| M3 — poller | **Next.** Blocked on API keys and a hosted database (see below). |
| **M4 — rule evaluator** | **Complete.** 29 tests. Migration 0001 adds `alert_events.threshold`. **Not yet run on real Postgres.** |
| M5 — dashboard | Not started. **There is no web app yet** — no Next.js, no React, no `src/app`. This is scaffolding, not a milestone. |
| M6 — history + manual edit | Not started. |
| Phase 2 (§6) | Blocked on §6.3 (below). |

`npm test` → 104 passing. `npx tsc --noEmit` → clean. `npm audit` → 0 high, 0 critical
(4 moderate, pre-existing).

---

## Problems — the live list

### Blocking, and not fixable in code

1. **No API keys.** `.env` does not exist. M2 is fully tested against an injected
   `fetch`, but M3 cannot poll anything real until there is a Finnhub key and a
   Twelve Data key. Both are free signups. `.env.example` lists what is needed.
2. **No hosted database.** Neon/Supabase has never been touched. Everything so far
   ran against PGlite and a throwaway Docker container.
3. **Git exists, but most work is uncommitted.** Local repo on `master`, no remote. The
   one commit ("Initial commmit", 2026-09-13) holds M1 + M2. **M4 is uncommitted**, so a
   worktree or branch cut from `master` will not see it. Check `git status` before
   branching; commit only when the user asks.

### Known risks, already understood

4. **M4 has never run on real Postgres.** Docker was down. `loadRuleStates` reads
   through raw `db.execute()` (the DEFECT-13 class), so PGlite passing proves
   nothing about postgres.js. `db:verify` now has five M4 checks; its logic was
   dry-run on PGlite, not on the real driver. **Run it before starting M3.**
5. **The Neon HTTP driver is a third `db.execute()` result shape** after postgres.js
   and PGlite — the DEFECT-13 class of bug again, and the first real risk in M3.
   `src/db/rows.ts` normalizes the two known shapes; verify the third before trusting
   it. M2 does no database I/O, so it did not exercise this.
6. **Twelve Data's free tier breaks the fallback at 9 tickers** (DEFECT-18). 8
   credits/**minute**, billed per symbol. D4 says "design for ~50"; the free tier
   cannot reach it at any daily budget. Decision on 2026-09-09: build for today's 5,
   record the ceiling. `twelveDataBudget()` plus tests #17/#18 make growth past 8 a
   failing build rather than a silent production failure.
7. **Cloudflare cron is UTC-only** (DEFECT-03) — the ET window moves by an hour twice
   a year. Widen to `*/5 13-21 * * 1-5` and let the ET gate be the authority.
8. **Disabling a rule freezes its open alert** (DEFECT-22). The evaluator only
   reads enabled rules. M6's disable action must close the event in the same
   transaction.
9. **`@nasdaq/market-calendar` does not exist** (DEFECT-14). `nyse-holidays` is the
   closest real package and carries **no early closes**, which M3's acceptance
   criterion requires. Expect to maintain a small explicit early-close table.

### Open questions for the user

10. **§6.3 — how `fcfRatio` is derived — is genuinely unresolved.** Five candidate
   definitions are ruled out arithmetically in `docs/DEFECTS.md`. Experiment 2 (pull
   the MSFT/AAPL panels) is unrun and gates the whole Phase 2 valuation engine.
   `fcfPerShare` stays a manual input until it settles.
11. **SEC EDGAR requires `User-Agent: <name> <email>`** (Phase 2, §6.1). That means
   sending the user's email to an external service. **Needs explicit sign-off before
   any EDGAR call** — never assume it.

---

## Implementation decisions made with the user

Asked, not assumed. Each has a test that fails if it is reversed.

| Date | Decision |
|---|---|
| 2026-09-09 | M2: build for today's 5 tickers and record the Twelve Data ceiling (DEFECT-18). |
| 2026-09-13 | M4 ships the pure `evaluate()` **and** the DB writer `runEvaluator()`; M3 just calls it. |
| 2026-09-13 | `alert_events` gains a `threshold` column, migration 0001 (DEFECT-20). |
| 2026-09-13 | An open alert is judged against the rule's **current** threshold, so moving the line can clear it. |
| 2026-09-13 | Ticks older than **15 minutes** are not evaluated (same cutoff as the M5 stale badge). |

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
- **The database is the last line of defence.** Eight CHECK constraints and a partial
  unique index (`alert_events ... WHERE cleared_at IS NULL`) enforce invariants that
  application code would otherwise be trusted with. Do not weaken them to make a test
  pass.
- **Money comparisons happen in integer ten-thousandths, never raw floats** (DEFECT-21).
  `400 * 1.005 === 401.99999999999994`. `src/lib/evaluate.ts` shows the pattern.
- **Alert timestamps are tick timestamps (`captured_at`), not the wall clock**, so a
  replay is deterministic.
- **`quote_at` is the provider's timestamp and may be NULL. Never default it to
  `now()`** (DEFECT-01). M5's stale badge reads it; defaulting makes stale data look
  fresh, which is the exact failure it exists to catch. `captured_at` is the poll time
  and is a different column for a reason.
- **Timezone work is explicit `America/New_York`,** never the session's local zone.
  The developer is in Phoenix, which does not observe DST — a bug there would not
  reproduce locally.
- **No new runtime dependency without a reason.** M2 added none: Node 18+ has global
  `fetch`, and an HTTP client would be dead weight in a Cloudflare Worker.

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
- **No API key is ever committed, logged, or included in an error message.** Finnhub's
  key goes in the `X-Finnhub-Token` header; Twelve Data's has to ride in the query
  string, so `redact()` strips query strings from any URL in an error and removes the
  key verbatim. Test #15 guards this.

---

## Commands

```bash
npm test                 # 104 tests, no database or container required
npx tsc --noEmit         # strict + noUncheckedIndexedAccess
npm run db:generate      # regenerate the migration from schema.ts
npm run db:migrate       # apply migrations   (needs DATABASE_URL)
npm run db:seed          # idempotent §4 seed (needs DATABASE_URL)
npm run db:verify        # 27 acceptance checks on real Postgres — scratch DB only
```
