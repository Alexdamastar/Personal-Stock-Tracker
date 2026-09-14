import { describeError, fetchWithTimeout, resolveConfig, withRetry } from './http.js';
import type {
  Attempt, FailureKind, ProviderConfig, Quote, QuoteProvider, QuoteResult,
} from './types.js';

export const TWELVE_DATA_BASE = 'https://api.twelvedata.com';

/**
 * DEFECT-18 / A3: the spec's provider table lists only "800/day". The binding limit
 * is per-MINUTE, and credits are billed PER SYMBOL, not per call - a batched request
 * for 5 symbols costs 5 credits, not 1.
 *
 * At the current 5 tickers everything the spec claims is true and Twelve Data can
 * carry a whole trading day unaided. The fallback breaks at 9 tickers, and it breaks
 * on the FIRST poll against the per-minute limit, long before the daily cap matters.
 * See `twelveDataBudget` and the budget assertions in tests/providers.test.ts.
 */
export const TWELVE_DATA_FREE_CREDITS_PER_MINUTE = 8;
export const TWELVE_DATA_FREE_CREDITS_PER_DAY = 800;

/** 09:30-16:00 ET at 5-minute polls, inclusive of both ends: 390/5 + 1. */
export const POLLS_PER_TRADING_DAY = 79;

export interface CreditBudget {
  tickers: number;
  creditsPerPoll: number;
  creditsPerDay: number;
  withinPerMinute: boolean;
  withinPerDay: boolean;
}

export function twelveDataBudget(tickers: number, pollsPerDay = POLLS_PER_TRADING_DAY): CreditBudget {
  const creditsPerPoll = tickers; // one credit per symbol
  const creditsPerDay = creditsPerPoll * pollsPerDay;
  return {
    tickers,
    creditsPerPoll,
    creditsPerDay,
    withinPerMinute: creditsPerPoll <= TWELVE_DATA_FREE_CREDITS_PER_MINUTE,
    withinPerDay: creditsPerDay <= TWELVE_DATA_FREE_CREDITS_PER_DAY,
  };
}

type Body = Record<string, unknown>;

const isRecord = (v: unknown): v is Body => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * DEFECT-17 / A2: the docs say the HTTP status matches the body's `code`. That holds
 * for a single top-level error but NOT for the keyed batch response this project
 * uses - per-symbol errors ride inside an HTTP 200, because errors in one request do
 * not affect the success of the others. A `res.status === 429` check therefore
 * records zero quotes and looks exactly like a quiet market.
 */
function isErrorEnvelope(v: Body): boolean {
  return v['status'] === 'error' || (typeof v['code'] === 'number' && v['code'] >= 400);
}

function kindFromCode(code: unknown): FailureKind {
  const n = typeof code === 'number' ? code : Number(code);
  if (!Number.isFinite(n)) return 'bad_response';
  if (n === 429 || n === 401 || n === 403) return 'rate_limited';
  if (n === 404) return 'no_data';
  if (n >= 500) return 'transient';
  return 'bad_response';
}

/**
 * A multi-symbol request returns a map keyed by symbol; a SINGLE-symbol request
 * returns a bare quote object. The failover path can legitimately ask for one
 * remaining ticker, so both shapes are live in production. Normalising here is what
 * keeps that asymmetry from becoming a silent parse failure.
 */
function entriesBySymbol(body: Body, tickers: readonly string[]): Map<string, Body> {
  const out = new Map<string, Body>();
  const looksLikeOneQuote = 'close' in body || 'price' in body
    || ('symbol' in body && !Object.values(body).some(isRecord));
  if (looksLikeOneQuote) {
    const sym = typeof body['symbol'] === 'string' ? body['symbol'] : tickers[0];
    if (sym) out.set(sym.toUpperCase(), body);
    return out;
  }
  for (const [key, value] of Object.entries(body)) {
    if (isRecord(value)) out.set(key.toUpperCase(), value);
  }
  return out;
}

/** DEFECT-04's class again: Twelve Data sends prices as STRINGS. */
function parseNumeric(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parsePrice(entry: Body): number | null {
  return parseNumeric(entry['close'] ?? entry['price']);
}

/**
 * DEFECT-23: `previous_close` is a string like `close`, so it is parsed the same way.
 * Unlike the price it is optional data - garbage or <= 0 is null, never a failure, so
 * a bad prior close cannot cost the ticker its price.
 */
function parsePrevClose(entry: Body): number | null {
  const n = parseNumeric(entry['previous_close']);
  return n !== null && n > 0 ? n : null;
}

function parseAt(entry: Body): Date | null {
  const ts = entry['timestamp'];
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) return new Date(ts * 1000);
  const dt = entry['datetime'];
  if (typeof dt === 'string' && dt.trim() !== '') {
    const d = new Date(dt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null; // DEFECT-01: never now()
}

export function createTwelveDataProvider(cfg: ProviderConfig): QuoteProvider {
  const conf = resolveConfig(cfg, { concurrency: 1 });
  const secrets = [conf.apiKey];

  const safeMessage = (message: string): string =>
    message ? describeError(new Error(message), secrets).replace(/^Error: /, '') : '';

  async function attempt(tickers: string[]): Promise<Attempt<Body>> {
    const symbols = tickers.map((t) => encodeURIComponent(t)).join(',');
    const url = `${TWELVE_DATA_BASE}/quote?symbol=${symbols}&apikey=${encodeURIComponent(conf.apiKey)}`;
    let res;
    try {
      res = await fetchWithTimeout(conf.fetchImpl, url, {}, conf.timeoutMs);
    } catch (err) {
      return { ok: false, kind: 'transient', detail: describeError(err, secrets) };
    }
    if (res.status === 429 || res.status === 401 || res.status === 403) {
      return { ok: false, kind: 'rate_limited', detail: `HTTP ${res.status}` };
    }
    if (res.status >= 500) return { ok: false, kind: 'transient', detail: `HTTP ${res.status}` };

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return { ok: false, kind: 'bad_response', detail: describeError(err, secrets) };
    }
    if (!isRecord(body)) return { ok: false, kind: 'bad_response', detail: 'body is not an object' };

    // The whole-batch error, which may arrive under HTTP 200 (DEFECT-17).
    if (isErrorEnvelope(body)) {
      const kind = kindFromCode(body['code'] ?? res.status);
      const message = typeof body['message'] === 'string' ? body['message'] : '';
      return { ok: false, kind, detail: safeMessage(message) || `code ${String(body['code'])}` };
    }
    if (!res.ok) return { ok: false, kind: 'bad_response', detail: `HTTP ${res.status}` };
    return { ok: true, value: body };
  }

  return {
    name: 'twelvedata',
    async getQuotes(tickers: string[]): Promise<QuoteResult> {
      const quotes: Quote[] = [];
      const failures = new Map<string, FailureKind>();
      if (tickers.length === 0) return { quotes, failures };

      const outcome = await withRetry(() => attempt(tickers), {
        maxAttempts: conf.maxAttempts,
        retryBaseMs: conf.retryBaseMs,
      });
      if (!outcome.ok) {
        for (const t of tickers) failures.set(t, outcome.kind);
        return { quotes, failures };
      }

      const entries = entriesBySymbol(outcome.value, tickers);
      let rateLimited = false;
      for (const ticker of tickers) {
        const entry = entries.get(ticker.toUpperCase());
        if (!entry) {
          failures.set(ticker, 'no_data');
          continue;
        }
        if (isErrorEnvelope(entry)) {
          const kind = kindFromCode(entry['code']);
          if (kind === 'rate_limited') rateLimited = true;
          failures.set(ticker, kind);
          continue;
        }
        const price = parsePrice(entry);
        if (price === null || price <= 0) {
          failures.set(ticker, price === null ? 'bad_response' : 'no_data');
          continue;
        }
        quotes.push({
          ticker, price, at: parseAt(entry), prevClose: parsePrevClose(entry), provider: 'twelvedata',
        });
      }

      // Running out of credits is an account-wide fact. If any symbol reported it, the
      // symbols that merely went missing from the body are out of credits too, not
      // delisted - and calling those `no_data` would wrongly stop them failing over.
      if (rateLimited) {
        for (const [ticker, kind] of failures) {
          if (kind !== 'rate_limited') failures.set(ticker, 'rate_limited');
        }
      }
      return { quotes, failures };
    },
  };
}
