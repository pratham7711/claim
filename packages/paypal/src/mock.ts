import type { CartChargeInput, ChargeResult, PayNowOrder, PaymentsGateway, ShipTo } from "@claim/core";
import { fnv1a, lowerHeaders, validateCart, verifyWebhookBody } from "./bodies.js";
import { PayPalError } from "./errors.js";
import { chargeFromError } from "./parse.js";

export interface MockDeclineCall {
  op: "chargeVaulted" | "captureOrder";
  buyerKey?: string;
  vaultId?: string;
  orderId?: string;
  cart: CartChargeInput;
}

export interface MockGatewayOptions {
  /** Same seed and same call sequence give the same ids. */
  seed?: string;
  /** Charges for these buyer keys fail with `declineCode` (vault charges, and pay-now captures via customId). */
  declineBuyerKeys?: string[];
  declineCode?: string;
  /** Full control: return an issue code (e.g. "INSTRUMENT_DECLINED", "PAYER_ACTION_REQUIRED") to fail the call. */
  decline?: (call: MockDeclineCall) => string | undefined;
  /** When false, setup tokens and pay-now orders need approveSetupToken / approveOrder first. Default true. */
  autoApprove?: boolean;
  /** Webhook id that signWebhook/verifyWebhook use; PayPal's simulator uses the literal "WEBHOOK_ID". */
  webhookId?: string;
}

interface SetupToken {
  id: string;
  buyerKey: string;
  approved: boolean;
  vaultId?: string;
}

interface Vault {
  id: string;
  buyerKey: string;
  customerId: string;
  deleted: boolean;
}

export interface MockOrder {
  id: string;
  kind: "vault" | "pay-now";
  invoiceId: string;
  totalCents: number;
  status: "CREATED" | "APPROVED" | "COMPLETED";
  buyerKey?: string;
  captureId?: string;
  refundedCents: number;
  trackers: string[];
  cart: CartChargeInput;
}

export interface MockGateway extends PaymentsGateway {
  readonly mode: "mock";
  approveSetupToken(setupTokenId: string): void;
  approveOrder(orderId: string): void;
  /** Headers that make verifyWebhook accept this exact body, for simulating deliveries. */
  signWebhook(rawBody: string, transmissionId?: string): Record<string, string>;
  orders(): MockOrder[];
}

const UPPER = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Deterministic in-memory gateway for demos and tests. Models PayPal's idempotency and duplicate-invoice rules. */
export function createMockGateway(opts: MockGatewayOptions = {}): MockGateway {
  const seed = opts.seed ?? "claim";
  const autoApprove = opts.autoApprove ?? true;
  const webhookId = opts.webhookId ?? "WEBHOOK_ID";
  const declineBuyers = new Set(opts.declineBuyerKeys ?? []);
  const declineCode = opts.declineCode ?? "INSTRUMENT_DECLINED";

  let n = 0;
  const id = (alphabet: string, len: number) => {
    n += 1;
    let h = parseInt(fnv1a(`${seed}:${n}`), 36) || 1;
    let out = "";
    while (out.length < len) {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      h >>>= 0;
      out += alphabet[h % alphabet.length];
    }
    return out;
  };
  const debugId = () => id("0123456789abcdef", 13);

  const setupTokens = new Map<string, SetupToken>();
  const vaults = new Map<string, Vault>();
  const customers = new Map<string, string>();
  const orders = new Map<string, MockOrder>();
  const byRequestId = new Map<string, { result?: ChargeResult; order?: PayNowOrder; error?: PayPalError }>();
  const refundsByRequestId = new Map<string, { refundId: string; status: string }>();
  const captures = new Map<string, string>();
  const consumedInvoices = new Set<string>();

  function fail(op: string, status: number, issue: string, description = issue): PayPalError {
    const d = debugId();
    const errorName = status === 404 ? "RESOURCE_NOT_FOUND" : status === 422 ? "UNPROCESSABLE_ENTITY" : "INVALID_REQUEST";
    return new PayPalError({
      op,
      status,
      errorName,
      message: `${op}: ${status} ${errorName} ${issue} - ${description} (debug_id ${d})`,
      debugId: d,
      details: [{ issue, description }],
    });
  }

  function scriptedDecline(call: MockDeclineCall): string | undefined {
    const custom = opts.decline?.(call);
    if (custom) return custom;
    return call.buyerKey && declineBuyers.has(call.buyerKey) ? declineCode : undefined;
  }

  function capture(order: MockOrder, op: string): void {
    if (consumedInvoices.has(order.invoiceId)) {
      throw fail(op, 422, "DUPLICATE_INVOICE_ID", "Duplicate Invoice ID detected. To avoid a potential duplicate transaction your account setting requires that Invoice Id be unique for each transaction.");
    }
    order.status = "COMPLETED";
    order.captureId = id(UPPER, 17);
    captures.set(order.captureId, order.id);
    consumedInvoices.add(order.invoiceId);
  }

  function getOrder(op: string, orderId: string): MockOrder {
    const o = orders.get(orderId);
    if (!o) throw fail(op, 404, "INVALID_RESOURCE_ID", `order ${orderId} not found`);
    return o;
  }

  function newOrder(kind: MockOrder["kind"], cart: CartChargeInput, buyerKey?: string): MockOrder {
    const order: MockOrder = {
      id: id(UPPER, 17),
      kind,
      invoiceId: cart.invoiceId,
      totalCents: cart.totalCents,
      status: "CREATED",
      ...(buyerKey ? { buyerKey } : {}),
      refundedCents: 0,
      trackers: [],
      cart,
    };
    orders.set(order.id, order);
    return order;
  }

  function sign(transmissionId: string, time: string, rawBody: string): string {
    return `mock-${fnv1a(`${transmissionId}|${time}|${webhookId}|${rawBody}`)}`;
  }

  return {
    mode: "mock",

    async clientToken() {
      return "MOCK-CLIENT-TOKEN";
    },

    async createSetupToken({ buyerKey }) {
      const t: SetupToken = { id: id(UPPER, 17), buyerKey, approved: autoApprove };
      setupTokens.set(t.id, t);
      return { setupTokenId: t.id };
    },

    approveSetupToken(setupTokenId) {
      const t = setupTokens.get(setupTokenId);
      if (!t) throw fail("approveSetupToken", 404, "INVALID_RESOURCE_ID");
      t.approved = true;
    },

    async createPaymentToken(setupTokenId) {
      const t = setupTokens.get(setupTokenId);
      if (!t) throw fail("createPaymentToken", 404, "INVALID_RESOURCE_ID", `setup token ${setupTokenId} not found`);
      if (!t.approved) throw fail("createPaymentToken", 422, "PAYER_ACTION_REQUIRED", "setup token is not approved");
      if (!t.vaultId) {
        let customerId = customers.get(t.buyerKey);
        if (!customerId) {
          customerId = `customer_${id("0123456789", 10)}`;
          customers.set(t.buyerKey, customerId);
        }
        const v: Vault = { id: id(LOWER, 7), buyerKey: t.buyerKey, customerId, deleted: false };
        vaults.set(v.id, v);
        t.vaultId = v.id;
      }
      const v = vaults.get(t.vaultId)!;
      return { vaultId: v.id, customerId: v.customerId };
    },

    async walletShipTo(vaultId) {
      const v = vaults.get(vaultId);
      return v && !v.deleted ? mockShipTo(v.buyerKey) : undefined;
    },

    async deletePaymentToken(vaultId) {
      const v = vaults.get(vaultId);
      if (v) v.deleted = true;
    },

    async chargeVaulted(vaultId, cart) {
      validateCart(cart, "chargeVaulted");
      const replay = byRequestId.get(cart.requestId);
      if (replay) {
        if (replay.error) throw replay.error;
        if (replay.result) return replay.result;
      }
      const v = vaults.get(vaultId);
      if (!v || v.deleted) throw fail("chargeVaulted", 404, "INVALID_RESOURCE_ID", `vault ${vaultId} not found`);
      if (consumedInvoices.has(cart.invoiceId)) {
        throw fail("chargeVaulted", 422, "DUPLICATE_INVOICE_ID", "Duplicate Invoice ID detected.");
      }
      let result: ChargeResult;
      const scripted = scriptedDecline({ op: "chargeVaulted", buyerKey: v.buyerKey, vaultId, cart });
      try {
        if (scripted) throw fail("chargeVaulted", 422, scripted);
        const order = newOrder("vault", cart, v.buyerKey);
        capture(order, "chargeVaulted");
        result = { orderId: order.id, captureId: order.captureId!, status: "COMPLETED", debugId: debugId(), ...(cart.shipTo ? { shipTo: cart.shipTo } : {}) };
      } catch (e) {
        try {
          result = chargeFromError(e);
        } catch (thrown) {
          if (thrown instanceof PayPalError) byRequestId.set(cart.requestId, { error: thrown });
          throw thrown;
        }
      }
      byRequestId.set(cart.requestId, { result });
      return result;
    },

    async createPayNowOrder(cart, urls) {
      validateCart(cart, "createPayNowOrder");
      const key = `${cart.requestId}-paynow`;
      const replay = byRequestId.get(key)?.order;
      if (replay) return replay;
      if (consumedInvoices.has(cart.invoiceId)) {
        throw fail("createPayNowOrder", 422, "DUPLICATE_INVOICE_ID", "Duplicate Invoice ID detected.");
      }
      const order = newOrder("pay-now", cart, cart.customId);
      if (autoApprove) order.status = "APPROVED";
      // The demo skips PayPal's page: "approving" lands on the return URL the way PayPal redirects back.
      const sep = urls.returnUrl.includes("?") ? "&" : "?";
      const result = { orderId: order.id, approveUrl: `${urls.returnUrl}${sep}token=${order.id}&PayerID=MOCKPAYER` };
      byRequestId.set(key, { order: result });
      return result;
    },

    approveOrder(orderId) {
      const o = getOrder("approveOrder", orderId);
      if (o.status === "CREATED") o.status = "APPROVED";
    },

    async captureOrder(orderId) {
      const o = getOrder("captureOrder", orderId);
      if (o.status === "COMPLETED") throw fail("captureOrder", 422, "ORDER_ALREADY_CAPTURED", "Order already captured.");
      try {
        if (o.status !== "APPROVED") throw fail("captureOrder", 422, "ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.");
        const scripted = scriptedDecline({ op: "captureOrder", ...(o.buyerKey ? { buyerKey: o.buyerKey } : {}), orderId, cart: o.cart });
        if (scripted) throw fail("captureOrder", 422, scripted);
        capture(o, "captureOrder");
        return { orderId, captureId: o.captureId!, status: "COMPLETED", debugId: debugId(), ...(o.buyerKey ? { shipTo: mockShipTo(o.buyerKey) } : {}) };
      } catch (e) {
        return chargeFromError(e, orderId);
      }
    },

    async refundCapture(captureId, amountCents, _note, requestId) {
      const prior = requestId ? refundsByRequestId.get(requestId) : undefined;
      if (prior) return prior;
      const orderId = captures.get(captureId);
      if (!orderId) throw fail("refundCapture", 404, "INVALID_RESOURCE_ID", `capture ${captureId} not found`);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw fail("refundCapture", 422, "REFUND_AMOUNT_TOO_LOW");
      const o = orders.get(orderId)!;
      if (o.refundedCents + amountCents > o.totalCents) {
        throw fail("refundCapture", 422, "REFUND_AMOUNT_EXCEEDED", "The refund amount must be less than or equal to the capture amount that has not yet been refunded.");
      }
      o.refundedCents += amountCents;
      const refund = { refundId: id(UPPER, 17), status: "COMPLETED" };
      if (requestId) refundsByRequestId.set(requestId, refund);
      return refund;
    },

    async addTracking(input) {
      const o = getOrder("addTracking", input.orderId);
      if (o.captureId !== input.captureId) throw fail("addTracking", 422, "INVALID_PARAMETER_VALUE", "capture_id does not belong to this order");
      const trackerId = `${input.captureId}-${input.trackingNumber.slice(0, 64)}`;
      if (!o.trackers.includes(trackerId)) o.trackers.push(trackerId);
      return { trackerId };
    },

    async verifyWebhook(headers, rawBody) {
      if (!verifyWebhookBody(headers, rawBody, webhookId)) return false;
      const h = lowerHeaders(headers);
      return h["paypal-transmission-sig"] === sign(h["paypal-transmission-id"]!, h["paypal-transmission-time"]!, rawBody);
    },

    signWebhook(rawBody, transmissionId = `mock-${id(LOWER, 12)}`) {
      const time = new Date(Date.UTC(2026, 9, 5)).toISOString();
      return {
        "paypal-auth-algo": "MOCKFNV1A",
        "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/MOCK",
        "paypal-transmission-id": transmissionId,
        "paypal-transmission-sig": sign(transmissionId, time, rawBody),
        "paypal-transmission-time": time,
      };
    },

    orders: () => [...orders.values()].map((o) => ({ ...o, trackers: [...o.trackers] })),
  };
}

/** The sandbox personal account's default address, with the street number and name taken from the buyer key. */
export function mockShipTo(buyerKey: string): ShipTo {
  // Room keys end in a random tag ("room:jess-5vsg8"); a label wants the handle without it.
  const handle =
    buyerKey
      .slice(buyerKey.lastIndexOf(":") + 1)
      .replace(/-(?=[a-z0-9]*\d)[a-z0-9]{4,}$/i, "")
      .replace(/[-_.]+/g, " ")
      .trim() || "Buyer";
  const name = handle.replace(/\b\w/g, (c) => c.toUpperCase());
  const number = 100 + (parseInt(fnv1a(buyerKey), 36) % 900);
  return { name, line1: `${number} Main St`, city: "San Jose", state: "CA", postalCode: "95131", countryCode: "US" };
}
