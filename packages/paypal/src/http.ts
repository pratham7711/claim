import { PayPalError, errorFromResponse } from "./errors.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Extra attempts after the first, for idempotent-safe calls only. */
  retries?: number;
  timeoutMs?: number;
}

export interface ApiRequest {
  op: string;
  method: "GET" | "POST" | "DELETE" | "PATCH";
  path: string;
  /** JSON body; serialised with JSON.stringify. */
  json?: unknown;
  /** Pre-serialised JSON body, sent verbatim (webhook verification embeds the raw event). */
  rawJson?: string;
  headers?: Record<string, string>;
  /**
   * True only when replaying the request cannot double-act: GET/DELETE, a fixed PayPal-Request-Id,
   * or an endpoint PayPal documents as idempotent. Only these are retried on 5xx/429/network errors.
   */
  idempotent: boolean;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  debugId: string | undefined;
}

export interface AccessToken {
  token: string;
  scope: string;
  appId: string | undefined;
  expiresAt: number;
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/** Refresh this long before PayPal's stated expiry so a token never dies mid-request. */
const EXPIRY_SKEW_MS = 60_000;

export function createHttp(opts: HttpOptions) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const basic = `Basic ${btoa(`${opts.clientId}:${opts.clientSecret}`)}`;

  let cached: AccessToken | undefined;
  let inflight: Promise<AccessToken> | undefined;

  async function send(op: string, url: string, init: RequestInit): Promise<ApiResponse> {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new PayPalError({
        op,
        status: 0,
        errorName: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        message: `${op}: ${timedOut ? `no response within ${timeoutMs}ms` : `network error: ${String((cause as Error)?.message ?? cause)}`}`,
        cause,
      });
    }
    const text = await res.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } else {
      body = null;
    }
    return { status: res.status, body, debugId: res.headers.get("paypal-debug-id") ?? undefined };
  }

  /** Runs `attempt` with backoff retries when the call is idempotent-safe. */
  async function withRetries(op: string, idempotent: boolean, attempt: () => Promise<ApiResponse>): Promise<ApiResponse> {
    for (let n = 0; ; n++) {
      const canRetry = idempotent && n < retries;
      let res: ApiResponse;
      try {
        res = await attempt();
      } catch (e) {
        if (canRetry && e instanceof PayPalError && e.status === 0) {
          await sleep(backoff(n));
          continue;
        }
        throw e;
      }
      if (canRetry && retryable(res)) {
        await sleep(backoff(n));
        continue;
      }
      return res;
    }
  }

  async function fetchToken(): Promise<AccessToken> {
    const res = await withRetries("oauth", true, () =>
      send("oauth", `${baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: formHeaders(basic),
        body: "grant_type=client_credentials",
      }),
    );
    if (res.status !== 200) throw errorFromResponse("oauth", res.status, res.body, res.debugId);
    const b = res.body as { access_token?: string; expires_in?: number; scope?: string; app_id?: string };
    if (!b?.access_token) throw errorFromResponse("oauth", res.status, { name: "INVALID_TOKEN_RESPONSE" }, res.debugId);
    const ttl = Number(b.expires_in ?? 0) * 1000;
    return { token: b.access_token, scope: b.scope ?? "", appId: b.app_id, expiresAt: now() + ttl };
  }

  /** Cached client-credentials token; concurrent callers share one in-flight fetch. */
  async function accessToken(force = false): Promise<AccessToken> {
    if (!force && cached && now() < cached.expiresAt - EXPIRY_SKEW_MS) return cached;
    if (force) cached = undefined;
    inflight ??= fetchToken().finally(() => {
      inflight = undefined;
    });
    const t = await inflight;
    cached = t;
    return t;
  }

  /** POST /v1/oauth2/token with response_type=client_token, as the v6 sample server does. Never cached. */
  async function clientToken(fields: Record<string, string | string[]> = {}): Promise<{ token: string; expiresIn: number }> {
    const form = new URLSearchParams({ grant_type: "client_credentials", response_type: "client_token" });
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) form.append(k, x);
    const res = await withRetries("clientToken", true, () =>
      send("clientToken", `${baseUrl}/v1/oauth2/token`, { method: "POST", headers: formHeaders(basic), body: form.toString() }),
    );
    const b = res.body as { access_token?: string; expires_in?: number };
    if (res.status !== 200 || !b?.access_token) throw errorFromResponse("clientToken", res.status, res.body, res.debugId);
    return { token: b.access_token, expiresIn: Number(b.expires_in ?? 0) };
  }

  /** Authenticated REST call. A 401 refreshes the token once (the request was never processed). */
  async function call<T = unknown>(req: ApiRequest): Promise<ApiResponse<T>> {
    const url = `${baseUrl}${req.path}`;
    const body = req.rawJson ?? (req.json === undefined ? undefined : JSON.stringify(req.json));
    const once = async (force: boolean) => {
      const { token } = await accessToken(force);
      return send(req.op, url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(req.method === "POST" || req.method === "PATCH" ? { "Content-Type": "application/json" } : {}),
          ...req.headers,
        },
        ...(body === undefined ? {} : { body }),
      });
    };
    let refreshed = false;
    const res = await withRetries(req.op, req.idempotent, async () => {
      const r = await once(false);
      if (r.status !== 401 || refreshed) return r;
      refreshed = true;
      return once(true);
    });
    if (res.status < 200 || res.status >= 300) throw errorFromResponse(req.op, res.status, res.body, res.debugId);
    return res as ApiResponse<T>;
  }

  return { accessToken, clientToken, call, baseUrl };
}

export type Http = ReturnType<typeof createHttp>;

function formHeaders(basic: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Accept-Language": "en_US",
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: basic,
  };
}

function retryable(res: ApiResponse): boolean {
  if (RETRY_STATUS.has(res.status)) return true;
  // A replay that lands while the first attempt is still running: safe to wait and replay again.
  const b = res.body as { details?: { issue?: string }[] } | null;
  return res.status === 409 && !!b?.details?.some((d) => d.issue === "PREVIOUS_REQUEST_IN_PROGRESS");
}

function backoff(n: number): number {
  return 250 * 2 ** n;
}
