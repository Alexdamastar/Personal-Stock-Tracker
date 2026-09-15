# Spec defects — findings against the Rule #1 Watchlist build spec

Every entry states what the spec said, why it breaks, and what was done. Fixed
entries name the test that would fail if the fix were reverted.

Status key: **FIXED** (resolved in the named milestone) · **DEFERRED** (fix
belongs to a later milestone; recorded so it is not rediscovered) ·
**AMENDMENT** (spec text is wrong and should be corrected in place).

DEFECT-08 stays filed under DEFERRED because that is where it was found; its
resolution is recorded in place at the end of the entry.

---

## FIXED in M1

### DEFECT-01 — `price_ticks` primary key collides on delayed quotes
**Severity: high. Would have failed on the first day of polling.**

§4 declared `PRIMARY KEY (security_id, captured_at)`. §2/D6 accept 15–20 minute
delayed quotes and M3 polls every 5 minutes, so the same provider timestamp is
returned 3–4 consecutive times. If `captured_at` is populated from `Quote.at`
(the natural reading, since `QuoteProvider` returns `{ticker, price, at}`), every
poll after the first raises a duplicate-key error, and the Phase 1 exit gate
("zero gaps in `price_ticks`") can never pass.

**Fix.** Two distinct columns with distinct meanings:
- `captured_at` — poll wall-clock. Unique per poll, so the PK holds. Proves the
  poller ran.
- `quote_at` — the provider's own timestamp. Nullable. ~~This is the column the
  M5 stale badge must read~~ — **corrected in M5:** the badge reads `captured_at`
  (poll age) and `quote_at` is shown as text. See "DEFECT-01 correction" under
  FIXED in M5.

Guarded by `tests/defects.test.ts` → *DEFECT-01*.

### DEFECT-02 — nothing enforced "at most one open alert event per rule"
**Severity: high.**

M4 branches on "no open event", but §4's `alert_events` had no constraint. A poll
overlapping a retry could open two events on one rule, and the evaluator would
then never clear cleanly.

**Fix.** `CREATE UNIQUE INDEX alert_events_one_open_per_rule ON alert_events
(rule_id) WHERE cleared_at IS NULL` — the invariant is now a database guarantee,
not a convention. Added `alert_events_order_ck` so `cleared_at >= triggered_at`.

Guarded by `tests/defects.test.ts` → *DEFECT-02*.

### DEFECT-04 — `numeric` columns return JavaScript strings
**Severity: high. Silent wrong answers, no error.**

Every price column in §4 is `numeric`. Both node-postgres and postgres.js return
`numeric` as a **string** to preserve precision. `price + 1` yields `"266.031"`;
`Math.min(price, threshold)` compares lexicographically. The M4 evaluator is
entirely numeric comparison, so this corrupts the core of the product quietly.

**Fix.** Every numeric column is declared `numeric({ mode: 'number' })` with
explicit precision/scale (`18,4` money, `9,6` ratios, `20,6` share counts), so
Drizzle parses at the boundary. Bare unbounded `numeric` is not used anywhere.
All values sit far below 2^53, so float64 round-trips exactly at these scales.

**Caveat that remains:** raw `db.execute()` bypasses Drizzle's column mapping and
still returns strings. Raw-SQL call sites parse explicitly — see DEFECT-13.

Guarded by `tests/defects.test.ts` → *DEFECT-04*, and by the strict `toEqual` in
the M1 acceptance test, which compares against number literals.

### DEFECT-05 — `daily_bars` was declared but never written
**Severity: medium.**

§4 created the table; no milestone in Phase 1 or Phase 2 populated it. Meanwhile
M5 requires a 30-day sparkline. An unpopulated table is a trap: the dashboard
would read empty and silently render nothing.

**Fix.** `src/db/rollup.ts` (`rollupDailyBars`) gives it a writer in M1. Kept
rather than deleted, because the rollup is what makes pruning `price_ticks`
possible without losing history.

**Honesty constraint recorded in the code:** these bars are derived from delayed
intraday ticks, not an exchange feed. `open` = first tick at/after 09:30 ET,
`close` = last tick at/before 16:00 ET. They will not match official OHLC and
must not be labelled as if they do.

Guarded by `tests/defects.test.ts` → *DEFECT-05*, including a DST case proving
the same UTC hour is in-session in August and pre-market in December.

### DEFECT-06 — the §3.4 fixture could not be run as written
**Severity: medium. Blocks the golden test.**

The `input` object carried `fcfPerShare: 14.30`, but the instruction immediately
below required computing from `epsTtm × fcfRatio`. `fcfRatio: 1.71` was not in
the object, so the fixture as literally given cannot reproduce `pbtPrice`
209.29 — it yields 209.35.

**Fix.** `AMZN_FIXTURE_INPUT` carries `fcfRatio: 1.71` and the exact
`fcfPerShare: 14.2956`. `fcfPerShareFromRatio()` builds it at full precision.
A test asserts the exact input beats the rounded one against the 209.29 target.

Guarded by `tests/valuation.test.ts` → *uses epsTtm x fcfRatio, not the displayed 14.30*.

### DEFECT-07 — capex sign convention contradicted itself
**Severity: medium.**

§3.2 uses `abs(capex)`, implying capex is stored negative. §6.3's ruled-out table
writes `cfo - capex` for a value actually obtained by `cfo + capex` (−0.23). The
arithmetic was right; the notation was wrong. §6.1 separately warns that sign
handling on capex and tax is a known hazard, so an inconsistent convention in the
spec is exactly the wrong thing to leave lying around.

**Fix.** `tenCap()` applies `Math.abs()` to capex and is sign-tolerant by
construction, with a test asserting `capex: -151003` and `capex: 151003` give an
identical price. Spec text amended — see AMENDMENT-A.

### DEFECT-12 — manual `g` and `fcfPerShare` had nowhere to live
**Severity: medium.**

§7.3 correctly gave `maint_pct` a per-security home. But §6.2 requires a manual
growth-rate override and §6.3 requires `fcfPerShare` to stay manual until the FCF
ratio is resolved — and `securities` had a column for neither. They would have
ended up hardcoded or wedged into `valuations.inputs`, where they cannot be
edited before a valuation exists.

**Fix.** `securities` now carries the full set of judgment inputs:
`maint_pct`, `growth_rate`, `fcf_per_share`, `marr`, `mos_pct`, `pbt_years`.
All visible, all editable, all defaulted per §3.1.

Guarded by `tests/defects.test.ts` → *DEFECT-12*.

### DEFECT-13 — `db.execute()` result shape differs by driver (found during M1)
**Severity: medium. Passes in tests, breaks in production.**

Not a spec defect — found while building. postgres.js returns a `RowList`
(an **array**); PGlite and node-postgres return an object with `.rows`. Code
written against the test harness reads `.rows` and breaks under postgres.js;
code written against production treats it as an array and breaks in tests.

**Fix.** All raw-SQL call sites go through `rowsOf()` in `src/db/rows.ts`, which
normalizes both shapes and throws on anything else.

### DEFECT-15 — pinned `drizzle-orm` carries a high-severity advisory
**Severity: high (supply chain). Found during install.**

`drizzle-orm < 0.45.2` has SQL injection via improperly escaped SQL identifiers
(GHSA-gpj5-g38j-94v9). The version resolved by the stack in §2 was 0.44.7.

**Fix.** Upgraded to `drizzle-orm@^0.45.2`. `npm audit` reports zero high or
critical findings.

**Still open, accepted:** 4 moderate advisories remain, all one dev-only
transitive chain — `drizzle-kit@0.31.10 → @esbuild-kit/* → esbuild <=0.24.2`
(GHSA-67mh-4wv8-2f99, esbuild dev-server request forgery). `npm audit fix --force`
"resolves" it by downgrading drizzle-kit to 0.18.1, a large regression. The
vulnerability affects a dev server that this project never runs, and `drizzle-kit`
is not a runtime dependency. Accepted deliberately; revisit when drizzle-kit drops
the deprecated `@esbuild-kit` loader.

---

## FIXED in M2

Four defects found by verifying the two provider APIs *before* writing the
adapters. All four are things the spec asserts or implies that are not true.

### DEFECT-16 — Finnhub has no batch quote endpoint
**Severity: medium.**

§2's interface is `getQuotes(tickers: string[])`, which reads as one call per
poll. Finnhub's `/quote` accepts **exactly one symbol**; there is no
comma-separated form. Two long-standing feature requests on the Finnhub API
repo ask for one and it does not exist.

**Fixed in M2.** The interface is unchanged — the fan-out is the adapter's
business — but every outcome is now defined **per ticker** rather than per HTTP
call, which the spec never anticipated. `src/providers/finnhub.ts` fans out with
bounded concurrency (default 5) so 50 tickers cannot burst 50 sockets against a
60/min limit, and the fan-out **halts** the moment one call returns 429: a rate
limit is account-wide, and firing the remaining calls only deepens it.

### DEFECT-17 — Twelve Data reports rate limits inside an HTTP 200 body
**Severity: high — this one fails silently.**

Twelve Data's docs state the HTTP status matches the `code` in the body. That
holds for a single top-level error but **not** for the batched, keyed-by-symbol
response this project uses: per-symbol errors ride inside an HTTP 200, because
errors on one symbol do not affect the others in the same request.

A production integration was bitten by exactly this. Its bug report quotes the
body verbatim:

> `API error (code: 429): You have run out of API credits for the current`
> `minute. 27 API credits were used, with the current limit being 8.`

A `res.status === 429` check therefore records zero quotes and looks
indistinguishable from a quiet market.

**Fixed in M2.** `src/providers/twelvedata.ts` inspects the parsed body for
`status: "error"` at both the top level and per key, and maps the body's `code`
to a failure kind regardless of HTTP status. `tests/providers.test.ts` #5 and
#5b fail if that check is removed.

### DEFECT-18 — Twelve Data's free tier is 8 credits/**minute**, billed per symbol
**Severity: high for D4. Not fixable in code.**

§2's provider table lists only "800/day". The binding constraint is the
per-minute limit, and credits are billed **per symbol**, not per call — a
batched request for 5 symbols costs 5 credits, not 1.

| Tickers | Finnhub calls/poll | TD credits/poll | TD vs 8/min | TD credits/day | vs 800/day |
|---|---|---|---|---|---|
| 5 (today) | 5 | 5 | ok, 5 ≤ 8 | 395 | ok |
| 8 | 8 | 8 | at the ceiling | 632 | ok |
| **50 (D4)** | 50 | 50 | **fails: 50 > 8** | 3,950 | fails, 4.9× over |

At today's 5 tickers everything the spec claims is true, and Twelve Data could
carry all 79 polls of a trading day unaided. **The fallback breaks at 9
tickers**, and it breaks on the *first* poll against the per-minute limit — long
before the daily cap is reached.

This contradicts **D4 ("design for ~50")**. Finnhub scales to 50 (50 calls/poll
against 60/min — tight but valid); Twelve Data cannot, at any daily budget.
Alpha Vantage, the spec's second fallback, is worse at 5/min.

**Decision (user, 2026-09-09): build M2 correctly for today's 5 and record the
ceiling.** D4 is not re-litigated. The arithmetic lives in
`twelveDataBudget()` and is asserted by tests #17 and #18, so growing the
watchlist past 8 tickers fails the build rather than failing silently in
production. Going beyond 8 requires a paid tier or a different second provider —
a budget decision, not an engineering one.

### DEFECT-19 — Finnhub's documented auth puts a live key in every URL
**Severity: medium.**

The documented form is `?token=KEY`, which places a credential in every request
URL and therefore in any log line, thrown error, or stack trace that echoes it.

**Fixed in M2.** Finnhub also accepts an `X-Finnhub-Token` header, which
`src/providers/finnhub.ts` uses. Twelve Data has no header form, so its key does
travel in the query string; `redact()` / `describeError()` in
`src/providers/http.ts` strip the entire query string from any URL appearing in
an error, and additionally remove the key verbatim in case a provider echoes it
back. Test #15 asserts no error text contains a key or a raw URL.

## FIXED in M4

Found by checking what the spec's six-line evaluator glosses over before writing it.
Three implementation decisions were put to the user rather than assumed; they are
recorded with the defect they belong to.

### DEFECT-20 — `alert_events` could not say what threshold an alert crossed
**Severity: medium for M6.**

§4's `alert_events` records the trigger `price` but not the threshold. A buy rule's
threshold moves with every appended valuation (D1), and M6 edits safe prices by hand,
so by the time anyone reads the alert log the rule's *current* value is not
necessarily the one that fired. "AMZN triggered at 209.00" is unreadable history
without "against 209.29".

**Fixed in M4** (user decision 2026-09-13). Migration `0001_alert_threshold.sql` adds
`alert_events.threshold numeric(18,4) NOT NULL` and `alert_events_positive_ck`
(price and threshold > 0). The three existing inserts in `tests/defects.test.ts` and
`scripts/verify.ts` were updated to supply it.

The migration adds a NOT NULL column with no default, which fails on a table that
already has rows. No real database existed when it was written; if one ever does
before this is applied, backfill from the rule's threshold first.

**Related decision — which threshold governs clearing** (user, 2026-09-13): the
rule's **current** threshold. When a new valuation or an M6 edit moves the line, an
open event is judged against where the line is now, so it can clear without the
price moving. The stored `threshold` is history for the log; it does not govern
clearing. `tests/m4-evaluator.test.ts` fails if clearing is switched to the
trigger-time threshold.

### DEFECT-21 — `threshold * 1.005` is wrong at the boundary in floating point
**Severity: low in effect, but wrong on exactly this project's numbers.**

§5 M4: clear when `price > threshold * 1.005`, strictly greater. `1.005` has no
exact binary representation:

```
400 * 1.005  ===  401.99999999999994
```

so a price of exactly 402.00 satisfies the comparison and clears one tick early. The
same happens at 200 -> 201 and 220 -> 221.1: **all three seeded safe prices** (MSFT,
AAPL, AMZN). Written the obvious way, the spec's formula disagrees with its own
wording.

**Fixed in M4.** `src/lib/evaluate.ts` converts both sides to integer ten-thousandths
of a dollar (the `numeric(18,4)` scale the database stores) and compares
`price * 1000 > threshold * 1005` in BigInt, where the arithmetic is exact. Three
parameterised tests pin the seeded boundaries, plus one that documents the IEEE-754
fact itself, so a failure there means the platform changed rather than the code.

## FIXED in M5

M5 was built by five agents in parallel, each on its own git worktree and branch,
against a contract written first (`src/lib/dashboard-types.ts`). Seven implementation
decisions were put to the user rather than assumed; they are recorded in `CLAUDE.md`.

### DEFECT-23 — % change needs a previous close, and nothing stored one
**Severity: medium.**

§5 M5 asks for "% change" per row. `price_ticks` stored only the price, and the M2
`Quote` carried only `{ ticker, price, at }`. The alternative — deriving it from
`daily_bars` — gives a tick-derived close, not the official one, and nothing at all
until the poller has run a full day.

**Fixed in M5** (user decision 2026-09-13). Both providers already return the prior
close (Finnhub `pc`, Twelve Data `previous_close`, a string). Migration
`0002_tick_prev_close.sql` adds nullable `price_ticks.prev_close` with
`price_ticks_prev_close_positive_ck`; `Quote.prevClose` carries it. A missing or
invalid prev close is `null` and never fails a quote or triggers failover.
**M3's writer must persist it** — nothing writes the column yet.

### DEFECT-21, second form — the float boundary also breaks on division
M4 fixed `threshold * 1.005`. M5's "approaching (within 10%)" has the same bug in
the other direction:

```
(925.947 - 841.77) / 841.77  ===  0.10000000000000003
```

so META exactly 10% above its buy line would read `watching`. `src/lib/dashboard.ts`
cross-multiplies in integer ten-thousandths, and computes distances from integer
units so equal ratios tie exactly in the sort.

### DEFECT-01 correction — the stale badge reads POLL age, not quote age
DEFECT-01 said the M5 stale badge "must read" `quote_at`. That was wrong: quotes are
15–20 min delayed by design (D6), Twelve Data about 4 hours, and the badge fires at
15 minutes, so a `quote_at` badge would be lit all day every trading day.

**Decision (user, 2026-09-13):** the badge fires when the newest **poll**
(`captured_at`) is over 15 minutes old during market hours — the poller stopped, or
the provider is failing. That matches M4's evaluator gate. The quote's own age is
always shown as text ("quote 21m old"). `isStale()` in `src/lib/market-hours.ts`
also allows a grace period after the open, so yesterday's last tick doesn't show
stale the moment the bell rings. The DEFECT-01 entry above is annotated.

### DEFECT-14 resolved — the early-close table exists
`src/lib/market-hours.ts` holds explicit NYSE full-day holidays and 13:00 ET early
closes for 2026 and 2027, each checked against nyse.com's published calendar
(https://www.nyse.com/markets/hours-calendars, checked 2026-09-13). No package. A date
outside the table throws, and a tripwire test fails from **2027-11-01** so the table
is extended before it can crash anything. NYSE has already published 2028.

## FIXED in migration 0003

Both were verified on PGlite and on PostgreSQL 18.6 before being fixed;
`drizzle/0003_money_nan_guards.sql` adds the guards, and
`tests/defects.test.ts` rejects NaN prices, NaN valuations and a 0 or negative
rule value. Applied on real Postgres: not yet (Docker was down again).

### DEFECT-24 — `'NaN'` passes every "must be positive" CHECK
**Severity: medium. Verified, not inferred.**

Postgres `numeric` accepts `'NaN'`, and Postgres orders NaN above every number, so
`'NaN'::numeric > 0` is **true**. Every `> 0` CHECK in the schema lets it through:
`price_ticks.price`, `price_ticks.prev_close`, `valuations.buy_price` /
`sticker_price`, and `alert_events.price` / `threshold`. Read back through Drizzle it
becomes a JS `NaN`.

Confirmed on 2026-09-13 against PGlite and then against a real PostgreSQL 18.6
server: every insert was accepted.

Today's code already defends: M2 rejects non-finite prices, and `evaluate()` and the
view model treat a non-finite value as "no value". The realistic entry points are
manual SQL and M6's edit form. **Proposed fix:** migration 0003 adding
`and <col> <> 'NaN'` to each positive CHECK (in Postgres `'NaN' = 'NaN'` is true, so
the inequality works). **Fixed:** every money CHECK now pairs `> 0` with `<> 'NaN'` via the shared
`positiveMoney()` helper in `schema.ts`.

### DEFECT-25 — `watch_rules.value` has no positivity CHECK
**Severity: medium for M6. Verified.**

Every other money column is constrained `> 0`; `watch_rules.value` is not. A pinned
buy of 0 and a safe price of -5 were both accepted. A zero line divides by zero in
the dashboard's distance and sort key; the view model skips non-positive thresholds,
but the database does not stop them. M6's form is where a user would type one.
**Fixed** in migration 0003: `value is null or (value > 0 and value <> 'NaN')`.

## DEFERRED to the milestone that owns them

### DEFECT-26 — a tiny positive price rounds to zero and fails the insert (M3)
**Severity: low.**

Money columns are `numeric(18,4)` and must be `> 0`. A provider value such as
`0.00004` passes the code's `> 0` check, rounds to `0.0000` on insert, and violates
the CHECK, so the whole insert throws. Applies to `price` and `prev_close`. Not
realistic for today's watchlist. **M3's writer** should round to 4 dp before
validating, and treat a value that rounds to zero as `no_data`.

### DEFECT-03 — Cloudflare Cron Triggers are UTC-only; the ET window moves (M3)
**Severity: high for M3.**

§2 specifies polling `09:30–16:00 America/New_York`, but Cloudflare cron
expressions are evaluated in **UTC with no timezone support**. That window is
13:30–20:00 UTC under EDT and 14:30–21:00 UTC under EST. A cron pinned to either
one is wrong for roughly half the year.

§5/M3's timezone warning covers the developer's Phoenix locale but not the
trigger itself.

**Required fix in M3.** Widen the cron to cover both offsets and let the ET gate
do the real filtering:

```
*/5 13-21 * * 1-5     # ~108 fires/day, still trivially inside the free tier
```

The gate function — not the cron — is the authority on whether a poll happens.
It must compute in `America/New_York` explicitly and never use system-local time.

The M1 rollup already demonstrates the correct pattern
(`captured_at at time zone 'America/New_York'`), with a passing DST test.

### DEFECT-08 — a 429 should fail over immediately, not retry with backoff (M2)
**Severity: medium.**

§2 specifies "failover on 429/timeout, 3 attempts, exponential backoff" as one
policy, but the two cases want opposite behavior. A 429 means *this provider is
rate-limited right now*; retrying it three times with backoff burns the poll
window and makes the limit worse. A timeout or 5xx is transient and worth a retry.

**Required fix in M2.** Split the policy:
- `429` / `403 quota` → fail over to the next provider **immediately**, no retry.
- timeout / 5xx / network error → up to 3 attempts, exponential backoff, then
  fail over.

M2's acceptance test should assert the mocked 429 produces **zero** retries
against Finnhub before Twelve Data is called.

**Resolved in M2.** `FailureKind` in `src/providers/types.ts` splits the two
cases (plus `no_data` and `bad_response`, which the spec did not distinguish
either); only `transient` and `bad_response` are retried. Test #2 asserts the
mocked 429 produces exactly one Finnhub call, and tests #3/#4 assert a timeout
and a 5xx each produce exactly three.

### DEFECT-22 — disabling a rule freezes its open alert (M6)
**Severity: low.**

The evaluator reads enabled rules only, the same filter `resolvedThresholds()` has
used since M1. A rule disabled while its alert is open is never evaluated again, so
the alert stays open indefinitely and the dashboard keeps showing it. The evaluator
cannot resolve this correctly on its own: closing the event would record a "clear"
that never happened in the market.

**Required in M6.** The disable action lives in M6's edit form. Disabling a rule
should close or acknowledge its open event in the same transaction, and the alert
log should show why.

### DEFECT-10 — M5's sort key is undefined (M5)
**Severity: low.**

M5 says "sorted by proximity to firing" without defining it. Rows have up to two
active thresholds (safe and buy) at different distances, and some have neither.

**Required definition in M5.** Sort ascending by
`min((price - threshold) / threshold)` across that security's *enabled, resolved*
rules; a security with no resolved threshold sorts last. A buy rule whose PBT
valuation does not exist yet resolves to NULL and must be skipped, never treated
as a threshold of zero — `resolvedThresholds()` in `src/db/queries.ts` already
returns NULL for that case.

### DEFECT-14 — `@nasdaq/market-calendar` does not exist
**Severity: medium for M3.**

§9 recommends it by name. It is not published on npm:

```
@nasdaq/market-calendar   NOT FOUND
market-calendar           1.0.0
nyse-holidays             1.2.0
trading-calendar          1.1.1
```

Worse, `nyse-holidays` — the closest real package — covers **holidays only**. It
does not carry **early closes** (July 3, the day after Thanksgiving, Christmas
Eve), which M3's acceptance criterion explicitly requires.

**Resolved in M5:** `src/lib/market-hours.ts` holds the table (see FIXED in M5).

**Required fix in M3.** Expect to maintain a small explicit early-close table
regardless of which library is chosen. Verify the package resolves before
depending on it.

---

## AMENDMENTS — spec text that is wrong and should be corrected

### AMENDMENT-A — §6.3: one line of the verification is a tautology

The verification prints an implied share count of **10,390M** twice: once from
"FCF = CFO" and once from `fcfRatio = CFO/NetIncome`. These are not two
independent witnesses. The identity

```
CFO/shares == eps × (CFO/NI)   ⟺   shares == NI/eps
```

is the same equation written twice. It must not be recorded as corroboration —
it reads as a confirmed lead and will cost whoever picks up §6.3 real time.

### AMENDMENT-B — §6.3: `fcfRatio = CFO / NetIncome` is now ruled out

Tested against the true TTM net income that §6.1 already verified from SEC
(90,798M for `2025-04-01 → 2026-03-31`):

```
CFO/NI_true = 148,531 / 90,798 = 1.6358    Toolbox shows 1.71    gap +4.5%
  → fcfPerShare 13.6756 → pbtPrice 200.21 vs fixture 209.29 (miss −9.08)
```

Add as a fifth row to the ruled-out table, on verified SEC data rather than
inference. Note also that the implied share count of 10,390M sits **below** both
cover-page (10,754M) and diluted weighted-average (~10,845M) — the wrong
direction for any current-period definition, since AMZN's count is growing.

**Consequence for the two proposed experiments.** Both facts point away from a
current-period definition and toward §6.3's multi-year-average hypothesis. So
**experiment 2 (pull the MSFT/AAPL panels) is the one worth running**; experiment 1
(the ↻ tooltip) is now lower value.

The §6.3 gate itself is correct and unchanged: `fcfPerShare` stays an explicit
manual input to `paybackTime()`.

### AMENDMENT-C — §7.7: the Phase 1 exit gate is unachievable as written

"Poller runs unattended 5 trading days with **zero gaps** in `price_ticks`" fails
on a single provider hiccup, one Cloudflare cron miss, or one Neon cold start —
none of which indicate a broken poller. §7.4 already anticipates free-tier
throttling as a known hazard, which makes a zero-tolerance gate self-contradictory.

**Proposed replacement:** ≥98% of expected ticks captured over 5 trading days
(≥387 of 395), no single gap longer than 15 minutes during market hours, and the
stale badge observed firing correctly at least once. That still proves the poller
is sound while tolerating the free-tier reality the spec already accepts.

### AMENDMENT-D — §9 verification dates are one day in the future

Every external fact in the verification log is dated `2026-08-29`. The current
date is `2026-08-28`. Cosmetic, but §9 is the section whose entire value is
"everything below was checked, not assumed" — a date that cannot be right
undermines the section that most depends on being trusted. Re-date to the actual
check date.

### AMENDMENT-E — D3 and M5 disagree on the strongest chip state
Locked decision D3 says crossing the safe price is "the strongest visual state". §5 M5
orders the chips `watching → approaching → at safe price → at buy price`, with buy
last. For AAPL, MSFT and AMZN the buy line sits below the safe line, so both are
crossed whenever price is below the buy line, and the two texts pick different chips.

**Decision (user, 2026-09-13):** below both lines, **`at buy price` wins** and gets the
strongest emphasis. D3's phrase should be read as "stronger than approaching". Guarded
by the `at_buy` precedence tests in `tests/dashboard.test.ts`.

---

## Scope note

`src/lib/valuation.ts` implements §6.5's three pure functions, which is nominally
Phase 2. It is included in M1 deliberately and narrowly: §3.4 instructs that
`verify.py` be ported "to the project's test runner as the first test file", and
that port cannot run without them. The functions are pure arithmetic over locked,
verified formulas.

**No Phase 2 work beyond that is present.** No SEC ingest, no TTM derivation, no
growth-rate calculator, no filing watcher — those depend on questions §6.1–§6.4
leave genuinely open.

---

## Verification record

| | |
|---|---|
| Date | 2026-08-29 |
| Suite | 53/53 passing against PGlite 0.3.16 |
| Real engine | **PostgreSQL 18.6** (`postgres:18-alpine`), 22/22 checks via `npm run db:verify` |
| Typecheck | clean, strict + `noUncheckedIndexedAccess` |
| Advisories | 0 high, 0 critical |

The PGlite suite and the real-server verifier apply the **same**
`drizzle/0000_init.sql`. What the real run adds over PGlite:

- **The production driver.** `postgres.js`, not PGlite. This is the only
  place DEFECT-13's `db.execute()` shape difference is actually exercised on
  the side that ships — `rollupDailyBars()` runs raw SQL, and the suite alone
  would never catch a regression there.
- **The server's own tzdata.** DEFECT-03's DST case (`13:35Z` is in-session in
  August, pre-market in December) was confirmed against real `America/New_York`
  rules, not PGlite's bundled copy.
- **Catalog inspection.** The partial unique index
  (`alert_events_one_open_per_rule ... WHERE cleared_at IS NULL`) and all seven
  CHECK constraints were read back out of `pg_indexes` / `pg_constraint`.
- **Migration idempotency.** `0000_init.sql` applied twice against a virgin
  database; the journal held at one row and the table set stayed at seven.
- **No schema drift.** `drizzle-kit generate` reports "No schema changes" —
  `schema.ts` and the checked-in SQL agree.

Two notes for whoever runs this next:

1. Re-applying the migration prints Postgres NOTICEs `42P06` / `42P07`
   (`schema "drizzle" already exists, skipping`). These come from drizzle's own
   journal bookkeeping, exit code is still 0, and they are not errors.
   `scripts/verify.ts` silences them with `onnotice`; `scripts/migrate.ts`
   does not, so the raw output looks alarming and isn't.
2. `db:verify` writes and then deletes rows in `price_ticks` and `daily_bars`.
   Point it at a scratch database, not one holding real tick history.

### M2 — 2026-09-09

| | |
|---|---|
| Suite | **75 passing** (53 M1 + 22 M2), 4 files |
| Typecheck | clean, strict + `noUncheckedIndexedAccess` |
| Advisories | 0 high, 0 critical (4 moderate, all pre-existing — no dependency was added) |
| Network | none. Every M2 test injects a fake `fetch`. |

M2 adds **no runtime dependency**: Node 18+ has global `fetch`, and an HTTP
client would be dead weight inside a Cloudflare Worker.

The three guards most likely to rot were mutation-tested — each was reverted in
place and the suite re-run, to confirm the test fails rather than passing
vacuously:

| Guard reverted | Tests that failed |
|---|---|
| DEFECT-17 body-level error detection (`isErrorEnvelope` → `false`) | #5, #5b |
| `no_data` does not fail over (`if (kind !== 'no_data')` dropped) | #10 |
| Finnhub `c === 0` → `no_data` (line removed) | #8, #10 |

`npm run db:verify` was **not** re-run for M2 — Docker was not running at the
time, and M2 performs no database I/O and changes nothing under `src/db/` or
`drizzle/`. Re-run it before M3, which is the milestone that starts writing
ticks.

Two things M2 deliberately leaves untested, both belonging to M3:

1. **The Neon HTTP driver.** M2 does no I/O to Postgres, so this is still
   untouched. It is a *third* `db.execute()` result shape after postgres.js and
   PGlite — the DEFECT-13 class of bug again, and the first real risk in M3.
2. **Live provider credentials.** A smoke test against real Finnhub / Twelve
   Data keys is manual and optional by design: it spends real budget and would
   fail the build on a provider outage unrelated to this code.

### M4 — 2026-09-13

| | |
|---|---|
| Suite | **104 passing** (75 prior + 29 M4), 5 files |
| Typecheck | clean, strict + `noUncheckedIndexedAccess` |
| Schema | migration `0001_alert_threshold.sql`, generated by `drizzle-kit generate` from `schema.ts` |
| Dependencies | none added |

Six guards were mutation-tested, each reverted in place with the suite re-run:

| Guard reverted | Tests that failed |
|---|---|
| DEFECT-21 exact BigInt compare -> naive `price > threshold * 1.005` | the three seeded-boundary tests |
| `ON CONFLICT DO NOTHING` on trigger | the lost-race test |
| `greatest()` on `cleared_at` | the out-of-order tick test |
| 15-minute stale-tick gate | the stale-tick test |
| current threshold -> trigger-time threshold for clearing | the moved-line test |
| `no_threshold` skip | the no-PBT-valuation test |

**`npm run db:verify` had not been run on real Postgres for M4 at the time** —
Docker was not running. It has since passed; see "Real PostgreSQL run" below. The verifier gained five M4 checks (27 total): migration 0001's column,
the acceptance series through `runEvaluator`, the tick-derived timestamps,
`loadRuleStates` numeric/epoch parsing, and the ON CONFLICT race. They matter
because `loadRuleStates` reads through raw `db.execute()` (the DEFECT-13 class),
and PGlite cannot prove the postgres.js side.

What *was* done: the verifier's logic was dry-run against PGlite through a temporary
driver shim (since deleted), and all 27 checks passed. That validates the script's
sequencing and literals, not the driver. **Run the real verifier before M3.**

### M5 — 2026-09-13

| | |
|---|---|
| Suite | **271 passing** (104 prior + 167 M5), 10 files |
| Typecheck | clean, strict + `noUncheckedIndexedAccess` |
| Build | `npm run build` passes; `/` is dynamic (server-rendered per request) |
| Schema | migration `0002_tick_prev_close.sql`; `drizzle-kit generate` reports no drift |
| Advisories | 0 high, 0 critical, 6 moderate (2 new ones are in vitest itself, dev-only) |

**How it was built.** Groundwork commit `163dfae` installed dependencies, added
migration 0002, and wrote the contract plus stubs. Five agents then worked in
parallel on `m5/a`–`m5/e`, each in its own `git worktree`, owning disjoint files; no
file was touched by more than one branch and all five merged without conflict.

| Branch | Tests | Owns |
|---|---|---|
| a-provider-prevclose | 5 | `Quote.prevClose` from Finnhub `pc` / Twelve Data `previous_close` |
| b-market-hours | 55 | NYSE calendar 2026–27, DST, `isStale`, M3's gate acceptance test |
| c-view-model | 51 | `buildDashboardRows`: chip, distances, sort, pbtYears |
| d-loader-demo | 22 (+4 at merge) | `loadDashboardData` (5 queries, any N), `getAppDb`, PGlite demo |
| e-ui | 28 | Next.js 16 app, table, chip, sparkline, auto-refresh |

**Integration, done after the merge:**
- `tests/m5-acceptance.test.tsx` — the spec's criterion **end to end**: seeded database
  → loader → view model → `renderToStaticMarkup`, and the AAPL row renders
  "at safe price" and sorts first. Each layer had only ever run against stubs of the
  others; this is the first test where they meet. A second test runs `page.tsx`'s exact
  sequence in demo mode and finds all four chip states.
- `refreshDemo()` re-stamps demo ticks on each page load (user decision 2026-09-13);
  mutation-checked: making it a no-op fails 3 tests.
- The production server (`next start`, demo mode) was run and fetched: HTTP 200, all
  four chips, three open alerts, rows AMZN/AAPL/MSFT/GOOGL/META, "quote 21m old".
  Screenshots taken in light and dark.
- DEFECT-24 and DEFECT-25 were verified against PGlite before being filed.

**Build notes for whoever runs this next:**
1. **Use `npm run build` / `npm run dev`, not bare `npx next build`.** Turbopack (Next
   16's default) cannot resolve this codebase's `.js` imports of `.ts` files, so the
   scripts pass `--webpack`, where `resolve.extensionAlias` handles it.
2. **Node 22.11 is below jsdom 30's floor (22.22.2).** `vitest.config.ts` passes
   `--experimental-require-module` to test workers only when Node lacks
   `require(esm)`. Upgrading Node makes that a no-op.
3. **Git Bash does not pass named `TZ` values to Node.** `TZ=Asia/Tokyo npx vitest`
   silently runs in the machine's zone; only `TZ=UTC` gets through. Run timezone
   proofs from PowerShell (`$env:TZ='Asia/Tokyo'`).
4. **`next dev`, run by an agent, appends a managed block to `CLAUDE.md`.** Revert it.
5. **Stopping a backgrounded `next start` on Windows can leave its `node.exe` holding
   the port.** Check with `Get-NetTCPConnection -LocalPort <port>`.
6. **The harness's built-in worktree isolation is unavailable** from a session started
   outside the repo; the worktrees were created manually with `git worktree add`.

**Real-Postgres verification:** done the same day — see below.

### Real PostgreSQL run — 2026-09-13

Docker available; throwaway `postgres:18-alpine` container (PostgreSQL 18.6), removed
afterwards.

| Check | Result |
|---|---|
| `npm run db:verify`, postgres.js | **33/33 pass** — including M4's 5 and M5's 6, previously PGlite-only |
| Second run on the populated database | 33/33 pass; `drizzle.__drizzle_migrations` holds 3 rows — all migrations re-apply cleanly |
| DEFECT-24 / DEFECT-25 on the real server | confirmed: `'NaN'::numeric > 0` is true; NaN price and valuation, and `watch_rules.value` of 0 and -5, all accepted (rolled back) |
| **Database mode, end to end** | `next start` with `DATABASE_URL` set, AAPL tick at 195.00 inserted: HTTP 200, no DEMO banner, AAPL first, "at safe price", $195.00, -1.19% change, -2.50% to safe, "quote 21m old" |

That last row is the spec's M5 acceptance criterion through the production server,
the production driver and a real Postgres — the one path no automated test covers,
because `getAppDb()`'s database mode needs a live server.

Still not exercised: the Neon HTTP driver (M3), and any hosted database.
