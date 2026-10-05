export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    /** From the provider's Retry-After header, when it sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface RetryOptions {
  /** Extra attempts after the first. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface PostResult {
  json: unknown;
  attempts: number;
}

const RETRYABLE = new Set([408, 409, 425, 429]);
export const isRetryableStatus = (status: number) => RETRYABLE.has(status) || status >= 500;

export function backoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number, rand = Math.random): number {
  const exp = baseDelayMs * 2 ** attempt;
  return Math.min(maxDelayMs, exp + Math.floor(rand() * baseDelayMs));
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** POST a JSON body; retry 408/409/425/429/5xx, network errors and per-attempt timeouts with backoff. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: RetryOptions = {},
): Promise<PostResult> {
  const { retries = 2, baseDelayMs = 250, maxDelayMs = 4000, timeoutMs = 15_000, signal } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const wait = opts.sleep ?? sleep;
  let lastError: LlmError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason;
    const timeout = AbortSignal.timeout(timeoutMs);
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let delay: number | undefined;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: attemptSignal,
      });
      if (res.ok) return { json: await res.json(), attempts: attempt + 1 };
      const text = await res.text().catch(() => "");
      delay = retryAfterMs(res.headers.get("retry-after"));
      lastError = new LlmError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, isRetryableStatus(res.status), delay);
      if (!lastError.retryable) throw lastError;
    } catch (err) {
      if (err instanceof LlmError && !err.retryable) throw err;
      if (signal?.aborted) throw signal.reason;
      if (!(err instanceof LlmError)) {
        const timedOut = timeout.aborted;
        lastError = new LlmError(timedOut ? `timeout after ${timeoutMs}ms` : `network: ${String(err)}`, undefined, true);
      }
    }
    if (attempt < retries) {
      await wait(Math.min(maxDelayMs, delay ?? backoffMs(attempt, baseDelayMs, maxDelayMs)), signal);
    }
  }
  throw lastError ?? new LlmError("request failed");
}
