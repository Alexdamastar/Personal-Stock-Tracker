import {
  describeError, fetchWithTimeout, mapWithConcurrency, resolveConfig, withRetry,
} from './http.js';
import type {
  Attempt, FailureKind, ProviderConfig, Quote, QuoteProvider, QuoteResult,
} from './types.js';

export const FINNHUB_BASE = 'https://finnhub.io/api/v1';

/**
 * DEFECT-16 / A3: Finnhub's free tier is 60 calls/min and there is NO batch quote
 * endpoint, so one poll costs one call per ticker. At the D4 ceiling of 50 tickers
 * that is 50 calls in one burst against a 60/min limit — valid, but only if the
 * fan-out is bounded. Unbounded, 50 simultaneous sockets is how you get 429s from a
 * limit you are technically under.
 */
export const FINNHUB_DEFAULT_CONCURRENCY = 5;
export const FINNHUB_CALLS_PER_MINUTE = 60;

/** The documented /quote body. Everything is optional because a stub is not a contract. */
interface FinnhubQuoteBody {
  c?: unknown; // current price
  t?: unknown; // UNIX seconds
  pc?: unknown; // previous close
}

/**
 * DEFECT-23: `pc` is optional data. Finnhub zero-fills fields it has no value for (as
 * with `c` and `t`), so 0 means "unknown", not a close of $0. Anything that is not a
 * finite positive number becomes null; it must never fail the quote.
 */
function parsePrevClose(pc: unknown): number | null {
  return typeof pc === 'number' && Number.isFinite(pc) && pc > 0 ? pc : null;
}

export function createFinnhubProvider(cfg: ProviderConfig): QuoteProvider {
  const conf = resolveConfig(cfg, { concurrency: FINNHUB_DEFAULT_CONCURRENCY });
  const secrets = [conf.apiKey];

  async function attempt(ticker: string): Promise<Attempt<Quote>> {
    const url = `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(ticker)}`;
    let res;
    try {
      // DEFECT-19: the documented form is ?token=KEY, which puts a live credential in
      // every request URL and therefore in every error and log line that echoes it.
      // Finnhub also accepts this header.
      res = await fetchWithTimeout(
        conf.fetchImpl, url, { headers: { 'X-Finnhub-Token': conf.apiKey } }, conf.timeoutMs,
      );
    } catch (err) {
      return { ok: false, kind: 'transient', detail: describeError(err, secrets) };
    }

    // 401/403 share `rate_limited`'s semantics exactly: this provider is unusable
    // right now, so fail over immediately and do not spend attempts on it.
    if (res.status === 429 || res.status === 401 || res.status === 403) {
      return { ok: false, kind: 'rate_limited', detail: `HTTP ${res.status}` };
    }
    if (res.status >= 500) return { ok: false, kind: 'transient', detail: `HTTP ${res.status}` };
    if (!res.ok) return { ok: false, kind: 'bad_response', detail: `HTTP ${res.status}` };

    let body: FinnhubQuoteBody;
    try {
      body = (await res.json()) as FinnhubQuoteBody;
    } catch (err) {
      return { ok: false, kind: 'bad_response', detail: describeError(err, secrets) };
    }

    const price = body.c;
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      return { ok: false, kind: 'bad_response', detail: `c is ${JSON.stringify(price)}` };
    }
    // Finnhub answers an unknown or delisted symbol with an all-zero body. That is a
    // fact about the symbol, not an outage: recording it would violate
    // price_ticks_positive_ck, and failing over would spend the fallback's very small
    // credit budget re-asking a question that has the same answer everywhere.
    if (price === 0) return { ok: false, kind: 'no_data', detail: 'c=0 (unknown or halted symbol)' };
    if (price < 0) return { ok: false, kind: 'bad_response', detail: `c=${price}` };

    const t = body.t;
    // `t` is UNIX SECONDS, not ms. t=0 means "no timestamp", not the epoch (DEFECT-01).
    const at = typeof t === 'number' && Number.isFinite(t) && t > 0 ? new Date(t * 1000) : null;

    return {
      ok: true,
      value: { ticker, price, at, prevClose: parsePrevClose(body.pc), provider: 'finnhub' },
    };
  }

  return {
    name: 'finnhub',
    async getQuotes(tickers: string[]): Promise<QuoteResult> {
      const quotes: Quote[] = [];
      const failures = new Map<string, FailureKind>();
      if (tickers.length === 0) return { quotes, failures };

      let rateLimited = false;
      await mapWithConcurrency(tickers, conf.concurrency, async (ticker) => {
        const outcome = await withRetry(() => attempt(ticker), {
          maxAttempts: conf.maxAttempts,
          retryBaseMs: conf.retryBaseMs,
        });
        if (outcome.ok) {
          quotes.push(outcome.value);
          return;
        }
        // One ticker's 429 rate-limits the whole account, not the symbol. Halt the
        // remaining fan-out rather than firing N more calls into a closed door.
        if (outcome.kind === 'rate_limited') rateLimited = true;
        failures.set(ticker, outcome.kind);
      }, () => rateLimited);

      for (const ticker of tickers) {
        if (failures.has(ticker)) continue;
        if (quotes.some((q) => q.ticker === ticker)) continue;
        failures.set(ticker, 'rate_limited'); // never attempted: the fan-out was halted
      }
      return { quotes, failures };
    },
  };
}
