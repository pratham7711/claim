import type { FetchLike } from "../http.js";

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
  json: unknown;
}

export type Reply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { throws: Error };

type Handler = (call: RecordedCall) => Reply | undefined;

/**
 * Scripted fetch: routes are matched in order by "METHOD /path" (prefix match on the path, no
 * query); `once` routes are consumed. The OAuth token endpoint answers by default.
 */
export function fakeFetch() {
  const calls: RecordedCall[] = [];
  const routes: { key: string; reply: Reply | Handler; once: boolean }[] = [];
  let tokenN = 0;

  const fetchImpl: FetchLike = async (input, init) => {
    const u = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init.body === "string" ? init.body : undefined;
    let json: unknown;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    const call: RecordedCall = { method: init.method ?? "GET", url: input, path: u.pathname, headers, body, json };
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    const idx = routes.findIndex((r) => key === r.key || key.startsWith(`${r.key}/`));
    let reply: Reply | undefined;
    if (idx >= 0) {
      const r = routes[idx]!;
      if (r.once) routes.splice(idx, 1);
      reply = typeof r.reply === "function" ? r.reply(call) : r.reply;
    } else if (key === "POST /v1/oauth2/token") {
      tokenN += 1;
      const isClient = body?.includes("response_type=client_token");
      reply = { status: 200, body: { access_token: `${isClient ? "client" : "access"}-${tokenN}`, expires_in: 32400, scope: "https://uri.paypal.com/services/vault/payment-tokens/readwrite", token_type: "Bearer" } };
    }
    if (!reply) return new Response(JSON.stringify({ name: "NO_ROUTE", message: key }), { status: 599 });
    if ("throws" in reply) throw reply.throws;
    const text = reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(reply.status === 204 ? null : text, {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };

  return {
    fetchImpl,
    calls,
    /** Calls excluding the OAuth token fetches. */
    api: () => calls.filter((c) => c.path !== "/v1/oauth2/token"),
    on(key: string, reply: Reply | Handler) {
      routes.push({ key, reply, once: false });
      return this;
    },
    once(key: string, reply: Reply | Handler) {
      routes.push({ key, reply, once: true });
      return this;
    },
  };
}

export const noSleep = async () => {};

export function orderJson(over: { id?: string; status?: string; capture?: { id: string; status: string; reason?: string } | null } = {}) {
  const cap = over.capture === undefined ? { id: "3B017991HX624902V", status: "COMPLETED" } : over.capture;
  return {
    id: over.id ?? "4TH21426N05692944",
    status: over.status ?? "COMPLETED",
    purchase_units: [
      {
        reference_id: "default",
        ...(cap
          ? { payments: { captures: [{ id: cap.id, status: cap.status, ...(cap.reason ? { status_details: { reason: cap.reason } } : {}) }] } }
          : {}),
      },
    ],
    links: [{ href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/x", rel: "self", method: "GET" }],
  };
}

export function issue422(issue: string, debugId = "f200264a4e02a") {
  return {
    status: 422,
    body: {
      name: "UNPROCESSABLE_ENTITY",
      details: [{ issue, description: `${issue} description` }],
      message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
      debug_id: debugId,
    },
  };
}
