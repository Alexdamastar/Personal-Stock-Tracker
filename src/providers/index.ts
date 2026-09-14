import { createFinnhubProvider } from './finnhub.js';
import { createTwelveDataProvider } from './twelvedata.js';
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_BASE_MS, DEFAULT_TIMEOUT_MS } from './http.js';
import {
  ProviderError,
  type FailureKind, type FetchLike, type Quote, type QuoteProvider, type QuoteResult,
} from './types.js';

export * from './types.js';
export { createFinnhubProvider, FINNHUB_CALLS_PER_MINUTE } from './finnhub.js';
export {
  createTwelveDataProvider, twelveDataBudget, POLLS_PER_TRADING_DAY,
  TWELVE_DATA_FREE_CREDITS_PER_DAY, TWELVE_DATA_FREE_CREDITS_PER_MINUTE,
} from './twelvedata.js';

interface ProviderSpec {
  keyEnv: string;
  create: (cfg: {
    apiKey: string; fetchImpl?: FetchLike; timeoutMs?: number;
    maxAttempts?: number; retryBaseMs?: number; concurrency?: number;
  }) => QuoteProvider;
}

export const PROVIDER_REGISTRY: Readonly<Record<string, ProviderSpec>> = {
  finnhub: { keyEnv: 'FINNHUB_API_KEY', create: createFinnhubProvider },
  twelvedata: { keyEnv: 'TWELVE_DATA_API_KEY', create: createTwelveDataProvider },
};

export const DEFAULT_PROVIDER_ORDER = 'finnhub,twelvedata';

type Env = Record<string, string | undefined>;

export interface QuoteServiceOptions {
  env?: Env;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  concurrency?: number;
}

export type QuoteService = QuoteProvider & { readonly providers: readonly QuoteProvider[] };

/**
 * Builds the failover chain from the environment.
 *
 * A provider named in QUOTE_PROVIDERS with no key is a STARTUP error, not a silent
 * skip. Dropping the primary quietly looks identical to a healthy system right up
 * until the fallback's very small daily budget runs out mid-session.
 */
export function createQuoteService(opts: QuoteServiceOptions = {}): QuoteService {
  const env: Env = opts.env ?? (process.env as Env);
  const order = (env['QUOTE_PROVIDERS'] ?? DEFAULT_PROVIDER_ORDER)
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (order.length === 0) throw new ProviderError('QUOTE_PROVIDERS is empty');

  const timeoutMs = opts.timeoutMs ?? numberFromEnv(env['QUOTE_TIMEOUT_MS']) ?? DEFAULT_TIMEOUT_MS;

  const providers = order.map((name) => {
    const spec = PROVIDER_REGISTRY[name];
    if (!spec) {
      throw new ProviderError(
        `unknown quote provider "${name}" (known: ${Object.keys(PROVIDER_REGISTRY).join(', ')})`,
        name,
      );
    }
    const apiKey = env[spec.keyEnv];
    if (!apiKey) throw new ProviderError(`${spec.keyEnv} is not set`, name);
    return spec.create({
      apiKey,
      fetchImpl: opts.fetchImpl,
      timeoutMs,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      retryBaseMs: opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      concurrency: opts.concurrency,
    });
  });

  return { ...failover(providers), providers };
}

/**
 * Tries providers in order, asking each only for the tickers still unfilled.
 *
 * This is a deliberate improvement on the spec's implied all-or-nothing failover, and
 * two things already true justify it: `price_ticks.provider` is per-row, so mixed
 * provenance within one poll is representable; and Twelve Data bills per symbol
 * against an 8/min ceiling (DEFECT-18), so refetching 5 tickers to recover 1 wastes
 * four credits out of a budget that only has eight.
 */
export function failover(providers: readonly QuoteProvider[]): QuoteProvider {
  return {
    name: providers.map((p) => p.name).join('>') || 'failover',
    async getQuotes(tickers: string[]): Promise<QuoteResult> {
      const quotes: Quote[] = [];
      const failures = new Map<string, FailureKind>();
      let remaining = [...tickers];

      for (const provider of providers) {
        if (remaining.length === 0) break;
        const result = await provider.getQuotes(remaining);
        quotes.push(...result.quotes);

        const filled = new Set(result.quotes.map((q) => q.ticker));
        const next: string[] = [];
        for (const ticker of remaining) {
          if (filled.has(ticker)) {
            failures.delete(ticker);
            continue;
          }
          const kind = result.failures.get(ticker) ?? 'bad_response';
          failures.set(ticker, kind);
          // A delisted or halted symbol is not a provider outage. Asking the fallback
          // gets the same answer and spends credits it cannot spare, which is how one
          // bad ticker takes down a whole poll.
          if (kind !== 'no_data') next.push(ticker);
        }
        remaining = next;
      }

      // Every provider exhausted: return what was collected. M2 never throws on a
      // partial result - M3 decides what to write, and M5's stale badge is what makes
      // the gap visible. Throwing here turns one flaky ticker into a dead poll.
      return { quotes, failures };
    },
  };
}

function numberFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
