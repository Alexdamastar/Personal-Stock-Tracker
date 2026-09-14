import type { Attempt, FailureKind, FetchLike, HttpResponse, ProviderConfig } from './types.js';

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_MS = 250;

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`request timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export interface ResolvedConfig {
  apiKey: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  concurrency: number;
}

export function resolveConfig(cfg: ProviderConfig, defaults: { concurrency: number }): ResolvedConfig {
  const fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) throw new Error('no fetch implementation available (Node 18+ or pass fetchImpl)');
  return {
    apiKey: cfg.apiKey,
    fetchImpl,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: cfg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    retryBaseMs: cfg.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    concurrency: cfg.concurrency ?? defaults.concurrency,
  };
}

/**
 * `fetch` with a hard deadline.
 *
 * The AbortController is what cancels a real socket. The racing timer is what
 * guarantees rejection even against an injected fetch that ignores the signal —
 * which is every stub in the test suite.
 */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: { headers?: Record<string, string> },
  timeoutMs: number,
): Promise<HttpResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const inflight = fetchImpl(url, { ...init, signal: controller.signal });
  // If the deadline wins, `inflight` still settles later; without this its rejection
  // is unhandled and crashes the process under Node's default policy.
  inflight.catch(() => {});
  try {
    return await Promise.race([inflight, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Retried classes. A `rate_limited` provider is not retried — it is failed over (A5). */
const RETRYABLE: ReadonlySet<FailureKind> = new Set<FailureKind>(['transient', 'bad_response']);

export async function withRetry<T>(
  run: (attempt: number) => Promise<Attempt<T>>,
  opts: { maxAttempts: number; retryBaseMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<Attempt<T>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: Attempt<T> = { ok: false, kind: 'transient', detail: 'no attempt was made' };
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    last = await run(attempt);
    if (last.ok || !RETRYABLE.has(last.kind)) return last;
    if (attempt < opts.maxAttempts && opts.retryBaseMs > 0) {
      await sleep(opts.retryBaseMs * 2 ** (attempt - 1));
    }
  }
  return last;
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)]+/g;

/**
 * DEFECT-19: strip the query string from any URL in a message. Twelve Data's key
 * travels as `?apikey=`, so an unredacted URL in a thrown error or a log line is a
 * leaked credential. Origin + path is enough to identify the call.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<url>';
  }
}

/**
 * Belt and braces: redact URLs, then remove the key verbatim in case it reached the
 * text some other way (a provider echoing it back, a driver embedding the request).
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(URL_IN_TEXT, (m) => redactUrl(m));
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

/** Error -> a safe one-line detail string. */
export function describeError(err: unknown, secrets: readonly string[] = []): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redact(raw, secrets);
}

/**
 * Runs `task` over `items` with at most `limit` in flight, stopping early once
 * `halted()` returns true. Finnhub needs both: the cap keeps 50 tickers under the
 * 60/min limit, and the halt stops the fan-out the moment one call reports 429 —
 * continuing would only deepen the limit.
 */
export async function mapWithConcurrency<T>(
  items: readonly string[],
  limit: number,
  task: (item: string) => Promise<T>,
  halted: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!halted()) {
      const i = next++;
      if (i >= items.length) return;
      await task(items[i]!);
    }
  });
  await Promise.all(workers);
}
