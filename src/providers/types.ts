/**
 * M2 quote provider layer — shared vocabulary.
 *
 * The spec's interface is `getQuotes(tickers: string[])`, which reads as one call
 * per poll. It is not: Finnhub's /quote takes exactly one symbol (DEFECT-16), so
 * the fan-out is the adapter's business and every outcome below is defined
 * PER TICKER rather than per HTTP call.
 */

/** A single filled quote. */
export interface Quote {
  ticker: string;
  price: number;
  /**
   * The PROVIDER's timestamp, or null when the provider did not supply one.
   *
   * DEFECT-01: this becomes `price_ticks.quote_at`, which is what M5's stale badge
   * reads. It must never fall back to now() — defaulting it to the poll time makes
   * stale data look fresh, which is the exact failure quote_at exists to prevent.
   */
  at: Date | null;
  /**
   * The PROVIDER's previous session close, or null when it was missing or unusable.
   *
   * DEFECT-23: M5's % change needs the prior close and nothing stored it. The user
   * chose (2026-09-13) to take the provider's own value rather than derive one from
   * daily_bars; M3 persists it to the nullable `price_ticks.prev_close`. It is
   * OPTIONAL data: a bad prevClose is null, never a failed quote and never a reason
   * to fail over — losing a good price to protect a % change would be backwards.
   * Always null or > 0, matching price_ticks_prev_close_positive_ck.
   */
  prevClose: number | null;
  /** Provider name, stored per-row in `price_ticks.provider`. */
  provider: string;
}

/**
 * Why one ticker did not come back.
 *
 * DEFECT-08 / A5: the spec gives a single retry policy ("failover on 429/timeout,
 * 3 attempts, exponential backoff") for two cases that want opposite behaviour.
 * A 429 means *this provider is rate-limited right now*; retrying it three times
 * with backoff burns the poll window and deepens the limit.
 */
export type FailureKind =
  /** 429, a 200 body carrying code 429 (DEFECT-17), or 401/403. Fail over NOW, zero retries. */
  | 'rate_limited'
  /** Timeout, 5xx, network error. Retry up to `maxAttempts`, then fail over. */
  | 'transient'
  /** Provider answered; the symbol is unknown, delisted or halted. Do NOT retry, do NOT fail over. */
  | 'no_data'
  /** Unparseable or nonsensical body. Retried like `transient`, but worth logging loudly. */
  | 'bad_response';

/** Partial success is a first-class outcome, not an error. */
export interface QuoteResult {
  quotes: Quote[];
  /** Keyed by ticker. A ticker appears in exactly one of `quotes` or `failures`. */
  failures: Map<string, FailureKind>;
}

export interface QuoteProvider {
  readonly name: string;
  getQuotes(tickers: string[]): Promise<QuoteResult>;
}

/**
 * Thrown only for configuration faults (missing key, unknown provider) — never for
 * a failed fetch, which is reported through `QuoteResult.failures` instead.
 *
 * DEFECT-19: the message is redacted before it is constructed. An API key must never
 * reach a log line, a stack trace or an error string.
 */
export class ProviderError extends Error {
  constructor(message: string, readonly provider?: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * The subset of `fetch` this layer uses. Global `fetch` satisfies it, and so does a
 * three-line stub — which is how every M2 test runs with no network and no keys.
 */
export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<HttpResponse>;

/** Knobs every adapter shares. Defaults live in `resolveConfig`. */
export interface ProviderConfig {
  apiKey: string;
  fetchImpl?: FetchLike;
  /** The spec never defined a timeout. Without one a hung socket stalls the whole poll. */
  timeoutMs?: number;
  maxAttempts?: number;
  /** Exponential backoff base. 0 disables sleeping, which is what the tests use. */
  retryBaseMs?: number;
  /** Finnhub only: bounds the fan-out so 50 tickers cannot burst past 60/min. */
  concurrency?: number;
}

/**
 * One HTTP attempt's outcome, classified. Adapters return this from the retry loop
 * so the retry policy can branch on `kind` without re-inspecting a Response.
 */
export type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; kind: FailureKind; detail: string };
