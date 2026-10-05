import type { CartChargeInput, ChargeResult, PayNowOrder, PaymentsGateway, ShipTo } from "@claim/core";
import {
  WEBHOOK_EVENTS,
  payNowOrderBody,
  paymentTokenBody,
  refundBody,
  setupTokenBody,
  trackerBody,
  vaultOrderBody,
  verifyWebhookBody,
  webhookBody,
} from "./bodies.js";
import { PayPalError, clientError } from "./errors.js";
import { createHttp, type AccessToken, type FetchLike } from "./http.js";
import { chargeFromError, chargeFromOrder, linkHref, shipToFrom, trackerIdFrom, type OrderJson, type PaymentTokenJson } from "./parse.js";

export type GatewayOp =
  | "chargeVaulted"
  | "createPayNowOrder"
  | "captureOrder"
  | "refundCapture"
  | "getOrder";

export interface MockResponseCall {
  op: GatewayOp;
  vaultId?: string;
  orderId?: string;
  captureId?: string;
  cart?: CartChargeInput;
}

/**
 * PayPal-Mock-Response (negative testing; must be switched ON for the sandbox business account).
 * A string applies to every call that supports it; a function picks per call. Return an issue code
 * such as "INSTRUMENT_DECLINED", or a full JSON header value starting with "{".
 */
export type MockResponseOption = string | ((call: MockResponseCall) => string | undefined);

export interface SandboxGatewayOptions {
  clientId: string;
  clientSecret: string;
  /** Needed only by verifyWebhook. */
  webhookId?: string;
  baseUrl?: string;
  /** Send stored_credential{MERCHANT, SUBSEQUENT} on vault_id orders. Acceptance is sandbox-UNVERIFIED. */
  storedCredential?: boolean;
  fetchImpl?: FetchLike;
  mockResponse?: MockResponseOption;
  /** Shown on the PayPal pages. */
  brandName?: string;
  /** Shown to the buyer on the save-wallet consent screen (max 128 chars). */
  setupDescription?: string;
  /** Send customer.merchant_customer_id derived from the buyer key on setup tokens. */
  linkMerchantCustomerId?: boolean;
  /** domains[] for the client token (only Fastlane needs it, per the v6 sample). */
  domains?: string[];
  retries?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Escape hatch for local stubs; the gateway refuses non-sandbox hosts by default. */
  allowNonSandboxBaseUrl?: boolean;
}

export interface SetupTokenDetails {
  setupTokenId: string;
  status: string;
  customerId?: string;
  /** PayPal-hosted approval page; the redirect alternative to the v6 popup. */
  approveUrl?: string;
}

export interface SandboxGateway extends PaymentsGateway {
  readonly mode: "sandbox";
  accessToken(force?: boolean): Promise<AccessToken>;
  createSetupTokenDetailed(input: { buyerKey: string; returnUrl: string; cancelUrl: string }): Promise<SetupTokenDetails>;
  getSetupToken(setupTokenId: string): Promise<SetupTokenDetails>;
  getOrder(orderId: string): Promise<OrderJson>;
  listWebhooks(): Promise<{ id: string; url: string; events: string[] }[]>;
  registerWebhook(url: string, events?: readonly string[]): Promise<{ id: string }>;
}

const SANDBOX_URL = "https://api-m.sandbox.paypal.com";
const NEGATIVE_TESTING_OPS: ReadonlySet<GatewayOp> = new Set(["chargeVaulted", "createPayNowOrder", "captureOrder", "refundCapture", "getOrder"]);

export function createSandboxGateway(opts: SandboxGatewayOptions): SandboxGateway {
  const baseUrl = opts.baseUrl ?? SANDBOX_URL;
  if (!opts.allowNonSandboxBaseUrl && !/^https:\/\/api(-m)?\.sandbox\.paypal\.com\/?$/.test(baseUrl)) {
    throw clientError(`refusing non-sandbox base URL ${baseUrl}`, "config");
  }
  if (!opts.clientId || !opts.clientSecret) throw clientError("clientId and clientSecret are required", "config");
  const http = createHttp({
    baseUrl,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const storedCredential = opts.storedCredential ?? true;

  function mockHeader(call: MockResponseCall): Record<string, string> {
    const m = opts.mockResponse;
    const code = typeof m === "function" ? m(call) : NEGATIVE_TESTING_OPS.has(call.op) ? m : undefined;
    if (!code) return {};
    const value = code.trim().startsWith("{") ? code : JSON.stringify({ mock_application_codes: code });
    return { "PayPal-Mock-Response": value };
  }

  async function createSetupTokenDetailed(input: { buyerKey: string; returnUrl: string; cancelUrl: string }): Promise<SetupTokenDetails> {
    const res = await http.call<SetupTokenJson>({
      op: "createSetupToken",
      method: "POST",
      path: "/v3/vault/setup-tokens",
      json: setupTokenBody(input, {
        ...(opts.setupDescription ? { description: opts.setupDescription } : {}),
        ...(opts.brandName ? { brandName: opts.brandName } : {}),
        ...(opts.linkMerchantCustomerId === false ? { linkMerchantCustomerId: false } : {}),
      }),
      headers: { "PayPal-Request-Id": uuid() },
      idempotent: true,
    });
    return setupDetails(res.body);
  }

  async function getOrder(orderId: string): Promise<OrderJson> {
    const res = await http.call<OrderJson>({
      op: "getOrder",
      method: "GET",
      path: `/v2/checkout/orders/${enc(orderId)}`,
      headers: mockHeader({ op: "getOrder", orderId }),
      idempotent: true,
    });
    return res.body;
  }

  return {
    mode: "sandbox",

    accessToken: (force?: boolean) => http.accessToken(force),

    async clientToken() {
      const fields: Record<string, string[]> = opts.domains?.length ? { "domains[]": opts.domains } : {};
      return (await http.clientToken(fields)).token;
    },

    createSetupTokenDetailed,

    async createSetupToken(input) {
      const { setupTokenId } = await createSetupTokenDetailed(input);
      return { setupTokenId };
    },

    async getSetupToken(setupTokenId) {
      const res = await http.call<SetupTokenJson>({
        op: "getSetupToken",
        method: "GET",
        path: `/v3/vault/setup-tokens/${enc(setupTokenId)}`,
        idempotent: true,
      });
      return setupDetails(res.body);
    },

    async createPaymentToken(setupTokenId) {
      const res = await http.call<{ id?: string; customer?: { id?: string } }>({
        op: "createPaymentToken",
        method: "POST",
        path: "/v3/vault/payment-tokens",
        json: paymentTokenBody(setupTokenId),
        headers: { "PayPal-Request-Id": uuid() },
        idempotent: true,
      });
      if (!res.body?.id) throw unexpected("createPaymentToken", res.status, res.debugId, "no payment token id");
      return { vaultId: res.body.id, customerId: res.body.customer?.id ?? "" };
    },

    async deletePaymentToken(vaultId) {
      try {
        await http.call({ op: "deletePaymentToken", method: "DELETE", path: `/v3/vault/payment-tokens/${enc(vaultId)}`, idempotent: true });
      } catch (e) {
        // Already gone is the outcome we wanted.
        if (e instanceof PayPalError && e.status === 404) return;
        throw e;
      }
    },

    async walletShipTo(vaultId): Promise<ShipTo | undefined> {
      try {
        const res = await http.call<PaymentTokenJson>({
          op: "getPaymentToken",
          method: "GET",
          path: `/v3/vault/payment-tokens/${enc(vaultId)}`,
          idempotent: true,
        });
        return shipToFrom(res.body?.payment_source?.paypal?.shipping);
      } catch {
        return undefined;
      }
    },

    async chargeVaulted(vaultId, cart): Promise<ChargeResult> {
      const json = vaultOrderBody(vaultId, cart, { storedCredential });
      try {
        const res = await http.call<OrderJson>({
          op: "chargeVaulted",
          method: "POST",
          path: "/v2/checkout/orders",
          json,
          headers: {
            "PayPal-Request-Id": cart.requestId,
            Prefer: "return=representation",
            ...mockHeader({ op: "chargeVaulted", vaultId, cart }),
          },
          idempotent: true,
        });
        return chargeFromOrder(res.body, res.debugId);
      } catch (e) {
        return chargeFromError(e);
      }
    },

    async createPayNowOrder(cart, urls): Promise<PayNowOrder> {
      const res = await http.call<OrderJson>({
        op: "createPayNowOrder",
        method: "POST",
        path: "/v2/checkout/orders",
        json: payNowOrderBody(cart, urls, opts.brandName),
        // Distinct from the vault charge's key, so a pay-now fallback after a decline is a new order.
        headers: { "PayPal-Request-Id": `${cart.requestId}-paynow`, ...mockHeader({ op: "createPayNowOrder", cart }) },
        idempotent: true,
      });
      const approveUrl = linkHref(res.body.links, "payer-action") ?? linkHref(res.body.links, "approve");
      if (!res.body.id || !approveUrl) throw unexpected("createPayNowOrder", res.status, res.debugId, "no order id or approval link");
      return { orderId: res.body.id, approveUrl };
    },

    async captureOrder(orderId) {
      try {
        const res = await http.call<OrderJson>({
          op: "captureOrder",
          method: "POST",
          path: `/v2/checkout/orders/${enc(orderId)}/capture`,
          headers: { "PayPal-Request-Id": uuid(), Prefer: "return=representation", ...mockHeader({ op: "captureOrder", orderId }) },
          idempotent: true,
        });
        return chargeFromOrder(res.body, res.debugId);
      } catch (e) {
        return chargeFromError(e, orderId);
      }
    },

    async refundCapture(captureId, amountCents, note, requestId) {
      const res = await http.call<{ id?: string; status?: string }>({
        op: "refundCapture",
        method: "POST",
        path: `/v2/payments/captures/${enc(captureId)}/refund`,
        json: refundBody(amountCents, "USD", note),
        headers: { "PayPal-Request-Id": requestId ?? uuid(), Prefer: "return=representation", ...mockHeader({ op: "refundCapture", captureId }) },
        idempotent: true,
      });
      if (!res.body?.id) throw unexpected("refundCapture", res.status, res.debugId, "no refund id");
      return { refundId: res.body.id, status: res.body.status ?? "PENDING" };
    },

    async addTracking(input) {
      const res = await http.call<OrderJson>({
        op: "addTracking",
        method: "POST",
        path: `/v2/checkout/orders/${enc(input.orderId)}/track`,
        json: trackerBody(input),
        // PayPal dedupes trackers on capture_id + tracking_number, so a replay is safe.
        idempotent: true,
      });
      return { trackerId: trackerIdFrom(res.body ?? {}, input.captureId, input.trackingNumber) };
    },

    async verifyWebhook(headers, rawBody) {
      if (!opts.webhookId) throw clientError("webhookId is not configured (PAYPAL_WEBHOOK_ID)", "verifyWebhook");
      const body = verifyWebhookBody(headers, rawBody, opts.webhookId);
      if (!body) return false;
      try {
        const res = await http.call<{ verification_status?: string }>({
          op: "verifyWebhook",
          method: "POST",
          path: "/v1/notifications/verify-webhook-signature",
          rawJson: body,
          idempotent: true,
        });
        return res.body?.verification_status === "SUCCESS";
      } catch (e) {
        // A 4xx means PayPal could not verify this delivery; outages and auth failures stay loud.
        if (e instanceof PayPalError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403 && e.status !== 429) return false;
        throw e;
      }
    },

    getOrder,

    async listWebhooks() {
      const res = await http.call<{ webhooks?: { id: string; url: string; event_types?: { name: string }[] }[] }>({
        op: "listWebhooks",
        method: "GET",
        path: "/v1/notifications/webhooks",
        idempotent: true,
      });
      return (res.body?.webhooks ?? []).map((w) => ({ id: w.id, url: w.url, events: (w.event_types ?? []).map((t) => t.name) }));
    },

    async registerWebhook(url, events = WEBHOOK_EVENTS) {
      const res = await http.call<{ id?: string }>({
        op: "registerWebhook",
        method: "POST",
        path: "/v1/notifications/webhooks",
        json: webhookBody(url, events),
        // Not idempotent: no request-id support on this endpoint, so a replay could register twice.
        idempotent: false,
      });
      if (!res.body?.id) throw unexpected("registerWebhook", res.status, res.debugId, "no webhook id");
      return { id: res.body.id };
    },
  };
}

interface SetupTokenJson {
  id?: string;
  status?: string;
  customer?: { id?: string };
  links?: { href?: string; rel?: string }[];
}

function setupDetails(b: SetupTokenJson): SetupTokenDetails {
  if (!b?.id) throw unexpected("createSetupToken", 200, undefined, "no setup token id");
  const approveUrl = linkHref(b.links, "approve");
  return {
    setupTokenId: b.id,
    status: b.status ?? "CREATED",
    ...(b.customer?.id ? { customerId: b.customer.id } : {}),
    ...(approveUrl ? { approveUrl } : {}),
  };
}

function unexpected(op: string, status: number, debugId: string | undefined, why: string): PayPalError {
  return new PayPalError({
    op,
    status,
    errorName: "UNEXPECTED_RESPONSE",
    message: `${op}: ${why}${debugId ? ` (debug_id ${debugId})` : ""}`,
    ...(debugId ? { debugId } : {}),
  });
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}
