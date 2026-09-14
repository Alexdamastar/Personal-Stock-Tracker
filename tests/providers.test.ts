import { describe, expect, it } from 'vitest';
import { createFinnhubProvider } from '../src/providers/finnhub.js';
import {
  createTwelveDataProvider, twelveDataBudget,
  TWELVE_DATA_FREE_CREDITS_PER_DAY, TWELVE_DATA_FREE_CREDITS_PER_MINUTE,
} from '../src/providers/twelvedata.js';
import { createQuoteService, type QuoteServiceOptions } from '../src/providers/index.js';
import { describeError, redact } from '../src/providers/http.js';
import { ProviderError, type FetchLike, type HttpResponse } from '../src/providers/types.js';

/**
 * M2. Every test injects a fake fetch: no network, no API keys, no cassettes.
 *
 * The spec's acceptance criterion for this milestone is test #1 - a mocked 429 from
 * Finnhub falls through to Twelve Data and returns 5 quotes. The other seventeen
 * exist because verifying the two provider APIs before writing the adapters turned up
 * four defects the spec did not know about (DEFECT-16..19).
 */

const WATCHLIST = ['AAPL', 'META', 'GOOGL', 'MSFT', 'AMZN'];

const KEYS = { FINNHUB_API_KEY: 'fh-secret-key-123', TWELVE_DATA_API_KEY: 'td-secret-key-456' };

const res = (status: number, body: unknown): HttpResponse => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** A socket that never answers - the only honest way to exercise the timeout path. */
const hang = (): Promise<HttpResponse> => new Promise<HttpResponse>(() => {});

const symbolOf = (url: string) => new URL(url).searchParams.get('symbol') ?? '';

interface Recorded { url: string; headers: Record<string, string> }

/** Routes by hostname so one stub can serve both adapters and record the call order. */
function stub(routes: {
  finnhub?: (symbol: string, n: number) => HttpResponse | Promise<HttpResponse>;
  twelvedata?: (symbols: string[], n: number) => HttpResponse | Promise<HttpResponse>;
}) {
  const calls: Recorded[] = [];
  const fh: Recorded[] = [];
  const td: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const rec = { url, headers: init.headers ?? {} };
    calls.push(rec);
    if (url.includes('finnhub.io')) {
      fh.push(rec);
      if (!routes.finnhub) throw new Error('unexpected finnhub call');
      return routes.finnhub(symbolOf(url), fh.length);
    }
    td.push(rec);
    if (!routes.twelvedata) throw new Error('unexpected twelvedata call');
    return routes.twelvedata(symbolOf(url).split(','), td.length);
  };
  return { fetchImpl, calls, fh, td };
}

const fhQuote = (price: number, t: number | null = 1_756_393_200) =>
  res(200, { c: price, h: price, l: price, o: price, pc: price, ...(t === null ? {} : { t }) });

const tdEntry = (price: string, extra: Record<string, unknown> = {}) =>
  ({ symbol: 'X', close: price, ...extra });

const tdKeyed = (prices: Record<string, string>) =>
  res(200, Object.fromEntries(
    Object.entries(prices).map(([sym, p]) => [sym, { ...tdEntry(p), symbol: sym }]),
  ));

/** Fast defaults: no real sleeping, no real timeouts. */
const service = (over: QuoteServiceOptions & { fetchImpl: FetchLike }) =>
  createQuoteService({ env: { ...KEYS }, retryBaseMs: 0, timeoutMs: 50, ...over });

describe('M2 acceptance - failover', () => {
  it('#1 a 429 from Finnhub falls through to Twelve Data and returns 5 quotes', async () => {
    const s = stub({
      finnhub: () => res(429, { error: 'API limit reached' }),
      twelvedata: (syms) => tdKeyed(Object.fromEntries(syms.map((x, i) => [x, String(100 + i)]))),
    });
    const result = await service({ fetchImpl: s.fetchImpl }).getQuotes(WATCHLIST);

    expect(result.quotes).toHaveLength(5);
    expect(result.quotes.map((q) => q.ticker)).toEqual(WATCHLIST);
    expect(result.quotes.every((q) => q.provider === 'twelvedata')).toBe(true);
    expect(result.failures.size).toBe(0);
    expect(s.td).toHaveLength(1); // one batched call, not five
  });

  it('#2 that 429 produces ZERO Finnhub retries', async () => {
    // DEFECT-08 / A5: retrying a rate-limited provider burns the poll window and
    // deepens the limit. 429 means fail over now, not try harder.
    const s = stub({
      finnhub: () => res(429, {}),
      twelvedata: () => tdKeyed({ AAPL: '266.03' }),
    });
    await service({ fetchImpl: s.fetchImpl }).getQuotes(['AAPL']);
    expect(s.fh).toHaveLength(1);
  });

  it('#3 a timeout is retried exactly maxAttempts times, then fails over', async () => {
    const s = stub({ finnhub: hang, twelvedata: () => tdKeyed({ AAPL: '266.03' }) });
    const result = await service({ fetchImpl: s.fetchImpl, timeoutMs: 5 }).getQuotes(['AAPL']);
    expect(s.fh).toHaveLength(3);
    expect(result.quotes[0]?.provider).toBe('twelvedata');
  });

  it('#4 a 5xx is retried, then fails over', async () => {
    const s = stub({
      finnhub: () => res(503, {}),
      twelvedata: () => tdKeyed({ AAPL: '266.03' }),
    });
    const result = await service({ fetchImpl: s.fetchImpl }).getQuotes(['AAPL']);
    expect(s.fh).toHaveLength(3);
    expect(result.quotes).toHaveLength(1);
  });

  it('#9 only the UNFILLED tickers are asked of the fallback', async () => {
    // Twelve Data bills per symbol against an 8/min ceiling (DEFECT-18). Refetching
    // all five to recover two would spend three credits out of eight for nothing.
    const filled = new Set(['AAPL', 'META', 'GOOGL']);
    const s = stub({
      finnhub: (sym) => (filled.has(sym) ? fhQuote(100) : res(503, {})),
      twelvedata: (syms) => tdKeyed(Object.fromEntries(syms.map((x) => [x, '200']))),
    });
    const result = await service({ fetchImpl: s.fetchImpl }).getQuotes(WATCHLIST);

    expect(s.td).toHaveLength(1);
    expect(symbolOf(s.td[0]!.url).split(',').sort()).toEqual(['AMZN', 'MSFT']);
    expect(result.quotes).toHaveLength(5);
    expect(result.failures.size).toBe(0);
  });

  it('#10 a no_data ticker is never retried against the fallback', async () => {
    const s = stub({
      finnhub: (sym) => (sym === 'ZZZZ' ? fhQuote(0) : res(503, {})),
      twelvedata: (syms) => tdKeyed(Object.fromEntries(syms.map((x) => [x, '200']))),
    });
    const result = await service({ fetchImpl: s.fetchImpl }).getQuotes(['AAPL', 'ZZZZ']);

    expect(symbolOf(s.td[0]!.url).split(',')).toEqual(['AAPL']);
    expect(result.failures.get('ZZZZ')).toBe('no_data');
    expect(result.quotes.map((q) => q.ticker)).toEqual(['AAPL']);
  });

  it('#13 exhausting every provider returns a partial result and does not throw', async () => {
    const s = stub({
      finnhub: (sym) => (sym === 'AAPL' ? fhQuote(266.03) : res(429, {})),
      twelvedata: () => res(429, { status: 'error', code: 429, message: 'out of credits' }),
    });
    const result = await service({ fetchImpl: s.fetchImpl }).getQuotes(WATCHLIST);

    expect(result.quotes.map((q) => q.ticker)).toEqual(['AAPL']);
    expect(result.failures.size).toBe(4);
    expect([...result.failures.values()].every((k) => k === 'rate_limited')).toBe(true);
  });
});

describe('M2 - Finnhub adapter', () => {
  const finnhub = (fetchImpl: FetchLike, over = {}) =>
    createFinnhubProvider({ apiKey: KEYS.FINNHUB_API_KEY, fetchImpl, retryBaseMs: 0, timeoutMs: 50, ...over });

  it('#8 c=0 is no_data, not a zero price', async () => {
    // Finnhub answers an unknown symbol with an all-zero body. Recording it would
    // violate price_ticks_positive_ck; treating it as an outage would trigger a
    // pointless failover that spends the fallback's credits on the same answer.
    const s = stub({ finnhub: () => fhQuote(0) });
    const result = await finnhub(s.fetchImpl).getQuotes(['ZZZZ']);
    expect(result.quotes).toHaveLength(0);
    expect(result.failures.get('ZZZZ')).toBe('no_data');
    expect(s.fh).toHaveLength(1); // no_data is not retried either
  });

  it('#12 t is UNIX seconds, and t=0 means "no timestamp", not the epoch', async () => {
    const s = stub({ finnhub: (sym) => (sym === 'AAPL' ? fhQuote(266.03, 1_756_393_200) : fhQuote(266.03, 0)) });
    const result = await finnhub(s.fetchImpl).getQuotes(['AAPL', 'META']);
    const by = new Map(result.quotes.map((q) => [q.ticker, q]));
    expect(by.get('AAPL')!.at!.getTime()).toBe(1_756_393_200_000);
    expect(by.get('META')!.at).toBeNull();
  });

  it('#11 a missing timestamp yields at=null - never now()', async () => {
    // DEFECT-01: quote_at is what M5's stale badge reads. Defaulting it to the poll
    // time makes stale data look fresh, which is the exact failure it exists to catch.
    const s = stub({ finnhub: () => fhQuote(266.03, null) });
    const result = await finnhub(s.fetchImpl).getQuotes(['AAPL']);
    expect(result.quotes[0]!.at).toBeNull();
  });

  it('#16 the fan-out never exceeds the concurrency cap', async () => {
    // DEFECT-16 / A3: no batch endpoint means one call per ticker. Unbounded, 50
    // simultaneous sockets draws 429s from a 60/min limit you are technically under.
    let inFlight = 0;
    let peak = 0;
    const tickers = Array.from({ length: 20 }, (_, i) => `T${i}`);
    const fetchImpl: FetchLike = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return fhQuote(10);
    };
    const result = await finnhub(fetchImpl, { concurrency: 5 }).getQuotes(tickers);
    expect(result.quotes).toHaveLength(20);
    expect(peak).toBe(5); // saturated, and never above - a broken pool fails both ways
  });

  it('sends the key as a header, never in the URL (DEFECT-19)', async () => {
    const s = stub({ finnhub: () => fhQuote(266.03) });
    await finnhub(s.fetchImpl).getQuotes(['AAPL']);
    expect(s.fh[0]!.headers['X-Finnhub-Token']).toBe(KEYS.FINNHUB_API_KEY);
    expect(s.fh[0]!.url).not.toContain(KEYS.FINNHUB_API_KEY);
  });
});

describe('M2 - Twelve Data adapter', () => {
  const td = (fetchImpl: FetchLike) =>
    createTwelveDataProvider({ apiKey: KEYS.TWELVE_DATA_API_KEY, fetchImpl, retryBaseMs: 0, timeoutMs: 50 });

  it('#5 a rate limit reported inside an HTTP 200 body is still a rate limit', async () => {
    // DEFECT-17 / A2. The real body, from a production integration that was bitten by
    // exactly this: "You have run out of API credits for the current minute. 27 API
    // credits were used, with the current limit being 8." A status-code-only check
    // records zero quotes and looks indistinguishable from a quiet market.
    const s = stub({
      twelvedata: () => res(200, {
        status: 'error', code: 429,
        message: 'You have run out of API credits for the current minute. '
          + '27 API credits were used, with the current limit being 8.',
      }),
    });
    const result = await td(s.fetchImpl).getQuotes(WATCHLIST);
    expect(result.quotes).toHaveLength(0);
    expect([...result.failures.values()]).toEqual(Array(5).fill('rate_limited'));
    expect(s.td).toHaveLength(1); // and it is not retried
  });

  it('#5b a per-symbol error inside a 200 keyed body is classified per symbol', async () => {
    const s = stub({
      twelvedata: () => res(200, {
        AAPL: { symbol: 'AAPL', close: '266.03' },
        ZZZZ: { status: 'error', code: 404, message: 'symbol not found' },
      }),
    });
    const result = await td(s.fetchImpl).getQuotes(['AAPL', 'ZZZZ']);
    expect(result.quotes.map((q) => q.ticker)).toEqual(['AAPL']);
    expect(result.failures.get('ZZZZ')).toBe('no_data');
  });

  it('#6 a single-symbol request returns a bare object, not a keyed map', async () => {
    // The failover path can legitimately ask for one remaining ticker, so both shapes
    // are live in production. This asymmetry is the likeliest silent M2 bug.
    const s = stub({
      twelvedata: () => res(200, { symbol: 'AMZN', close: '266.03', timestamp: 1_756_393_200 }),
    });
    const result = await td(s.fetchImpl).getQuotes(['AMZN']);
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]).toMatchObject({ ticker: 'AMZN', price: 266.03, provider: 'twelvedata' });
    expect(result.quotes[0]!.at!.getTime()).toBe(1_756_393_200_000);
  });

  it('#7 string prices are parsed to finite numbers and garbage is rejected', async () => {
    // The DEFECT-04 class again: the wire format is a string, the column is numeric.
    const s = stub({
      twelvedata: () => res(200, {
        AAPL: { symbol: 'AAPL', close: '266.03' },
        META: { symbol: 'META', close: 'abc' },
        GOOGL: { symbol: 'GOOGL', close: '0' },
      }),
    });
    const result = await td(s.fetchImpl).getQuotes(['AAPL', 'META', 'GOOGL']);
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]!.price).toBe(266.03);
    expect(typeof result.quotes[0]!.price).toBe('number');
    expect(result.failures.get('META')).toBe('bad_response');
    expect(result.failures.get('GOOGL')).toBe('no_data');
  });

  it('#11b omits at when the body carries neither timestamp nor datetime', async () => {
    const s = stub({ twelvedata: () => tdKeyed({ AAPL: '266.03' }) });
    const result = await td(s.fetchImpl).getQuotes(['AAPL']);
    expect(result.quotes[0]!.at).toBeNull();
  });
});

describe('M2 - configuration and secrets', () => {
  it('#14 a selected provider with no key is a startup error, not a silent skip', async () => {
    // Silently dropping the primary looks identical to a healthy system right up until
    // the fallback's daily budget runs out mid-session.
    expect(() => createQuoteService({ env: { FINNHUB_API_KEY: 'x' } }))
      .toThrow(/TWELVE_DATA_API_KEY is not set/);
    expect(() => createQuoteService({ env: { QUOTE_PROVIDERS: 'yahoo', ...KEYS } }))
      .toThrow(ProviderError);
  });

  it('#15 no error text ever contains an API key or a raw URL', async () => {
    const leaky = new Error(
      `connect ECONNREFUSED https://api.twelvedata.com/quote?symbol=AAPL&apikey=${KEYS.TWELVE_DATA_API_KEY}`,
    );
    const safe = describeError(leaky, [KEYS.TWELVE_DATA_API_KEY]);
    expect(safe).not.toContain(KEYS.TWELVE_DATA_API_KEY);
    expect(safe).not.toContain('apikey=');
    expect(safe).toContain('https://api.twelvedata.com/quote');

    expect(redact(`token=${KEYS.FINNHUB_API_KEY}`, [KEYS.FINNHUB_API_KEY]))
      .toBe('token=[REDACTED]');

    try {
      createQuoteService({ env: { QUOTE_PROVIDERS: 'finnhub' } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(String(err)).not.toContain(KEYS.FINNHUB_API_KEY);
    }
  });

  it('honours QUOTE_PROVIDERS order', () => {
    const s = stub({});
    const svc = createQuoteService({ env: { QUOTE_PROVIDERS: 'twelvedata,finnhub', ...KEYS }, fetchImpl: s.fetchImpl });
    expect(svc.providers.map((p) => p.name)).toEqual(['twelvedata', 'finnhub']);
  });
});

describe('M2 - Twelve Data free-tier credit budget (DEFECT-18)', () => {
  // The arithmetic lives in a test so the ceiling is a failing build rather than a
  // paragraph nobody re-reads - the same reason the M1 fixture asserts on literals.
  it('#17 today’s 5 tickers fit the free tier with room to spare', () => {
    const b = twelveDataBudget(5);
    expect(b.creditsPerPoll).toBe(5);
    expect(b.creditsPerDay).toBe(395);
    expect(b.withinPerMinute).toBe(true);
    expect(b.withinPerDay).toBe(true);
    expect(TWELVE_DATA_FREE_CREDITS_PER_MINUTE).toBe(8);
    expect(TWELVE_DATA_FREE_CREDITS_PER_DAY).toBe(800);
  });

  it('#18 the fallback breaks at 9 tickers, and D4’s 50 is 6x over the per-minute limit', () => {
    expect(twelveDataBudget(8).withinPerMinute).toBe(true);
    expect(twelveDataBudget(9).withinPerMinute).toBe(false);

    const fifty = twelveDataBudget(50);
    expect(fifty.withinPerMinute).toBe(false); // 50 > 8, and it fails on the FIRST poll
    expect(fifty.creditsPerDay).toBe(3_950);
    expect(fifty.withinPerDay).toBe(false); // 4.9x the daily cap as well
  });
});
