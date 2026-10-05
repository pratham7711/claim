import type { Cart, CartChargeInput } from "@claim/core";
import { clientError } from "./errors.js";
import { assertCents, money } from "./money.js";

/** Pure request-body builders. Every shape here is checked against the OpenAPI specs in spec.test.ts. */

export const WEBHOOK_EVENTS = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "CHECKOUT.ORDER.APPROVED",
  "VAULT.PAYMENT-TOKEN.CREATED",
  "VAULT.PAYMENT-TOKEN.DELETED",
] as const;

/** Refuses carts PayPal would 422 (ITEM_TOTAL_MISMATCH, AMOUNT_MISMATCH, bad ids) before any call. */
export function validateCart(cart: CartChargeInput, op = "validate"): void {
  if (!cart.lines.length) throw clientError("cart has no lines", op);
  let itemTotal = 0;
  for (const l of cart.lines) {
    if (!Number.isSafeInteger(l.qty) || l.qty < 1) throw clientError(`line ${l.sku}: qty must be a positive integer`, op);
    assertCents(l.unitCents, `line ${l.sku} unitCents`);
    if (!l.name.trim()) throw clientError(`line ${l.sku}: name is empty`, op);
    itemTotal += l.qty * l.unitCents;
  }
  assertCents(cart.shippingCents, "shippingCents");
  assertCents(cart.totalCents, "totalCents");
  if (itemTotal + cart.shippingCents !== cart.totalCents) {
    throw clientError(`totalCents ${cart.totalCents} != items ${itemTotal} + shipping ${cart.shippingCents}`, op);
  }
  if (cart.totalCents <= 0) throw clientError("totalCents must be positive", op);
  if (!cart.invoiceId || cart.invoiceId.length > 127) throw clientError("invoiceId must be 1-127 chars", op);
  if (!cart.requestId) throw clientError("requestId is required (PayPal-Request-Id)", op);
  if (cart.customId !== undefined && (!cart.customId || cart.customId.length > 127)) {
    throw clientError("customId must be 1-127 chars", op);
  }
}

/** One purchase unit with an item_total + shipping breakdown; items are physical goods. */
export function purchaseUnit(cart: CartChargeInput) {
  const c = cart.currency;
  const itemTotal = cart.lines.reduce((a, l) => a + l.qty * l.unitCents, 0);
  return {
    invoice_id: cart.invoiceId,
    ...(cart.customId ? { custom_id: cart.customId } : {}),
    amount: {
      ...money(cart.totalCents, c),
      breakdown: { item_total: money(itemTotal, c), shipping: money(cart.shippingCents, c) },
    },
    items: cart.lines.map((l) => ({
      name: l.name.slice(0, 127),
      ...(l.sku ? { sku: l.sku.slice(0, 127) } : {}),
      quantity: String(l.qty),
      unit_amount: money(l.unitCents, c),
      category: "PHYSICAL_GOODS" as const,
    })),
  };
}

/** Merchant-initiated close-out against a saved wallet. stored_credential is sandbox-UNVERIFIED, hence the flag. */
export function vaultOrderBody(vaultId: string, cart: CartChargeInput, opts: { storedCredential: boolean }) {
  if (!/^[0-9a-zA-Z_-]{1,255}$/.test(vaultId)) throw clientError(`invalid vault id ${JSON.stringify(vaultId)}`, "chargeVaulted");
  validateCart(cart, "chargeVaulted");
  return {
    intent: "CAPTURE" as const,
    purchase_units: [purchaseUnit(cart)],
    payment_source: {
      paypal: {
        vault_id: vaultId,
        ...(opts.storedCredential
          ? { stored_credential: { payment_initiator: "MERCHANT" as const, usage: "SUBSEQUENT" as const } }
          : {}),
      },
    },
  };
}

export function payNowOrderBody(cart: CartChargeInput, urls: { returnUrl: string; cancelUrl: string }, brandName?: string) {
  validateCart(cart, "createPayNowOrder");
  return {
    intent: "CAPTURE" as const,
    purchase_units: [purchaseUnit(cart)],
    payment_source: {
      paypal: {
        experience_context: {
          ...(brandName ? { brand_name: brandName.slice(0, 127) } : {}),
          shipping_preference: "GET_FROM_FILE" as const,
          user_action: "PAY_NOW" as const,
          return_url: urls.returnUrl,
          cancel_url: urls.cancelUrl,
        },
      },
    },
  };
}

/** PayPal's merchant_customer_id allows [0-9a-zA-Z-_.^*$@#], max 64; buyer keys look like "twitch:123". */
export function merchantCustomerId(buyerKey: string): string {
  const clean = buyerKey.replace(/[^0-9a-zA-Z\-_.^*$@#]/g, ".");
  if (clean === buyerKey && clean.length <= 64 && clean) return clean;
  const suffix = fnv1a(buyerKey);
  return `${clean.slice(0, 64 - suffix.length - 1)}-${suffix}`;
}

/**
 * Claim Pass setup token. Fields follow the task brief plus the v6 sample's vault_instruction
 * (server/node/src/routes/vaultRouteHandler.ts).
 */
export function setupTokenBody(
  input: { buyerKey: string; returnUrl: string; cancelUrl: string },
  opts: { description?: string; brandName?: string; linkMerchantCustomerId?: boolean } = {},
) {
  return {
    ...(opts.linkMerchantCustomerId === false ? {} : { customer: { merchant_customer_id: merchantCustomerId(input.buyerKey) } }),
    payment_source: {
      paypal: {
        ...(opts.description ? { description: opts.description.slice(0, 128) } : {}),
        usage_type: "MERCHANT" as const,
        customer_type: "CONSUMER" as const,
        experience_context: {
          ...(opts.brandName ? { brand_name: opts.brandName.slice(0, 300) } : {}),
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          vault_instruction: "ON_PAYER_APPROVAL" as const,
        },
      },
    },
  };
}

export function paymentTokenBody(setupTokenId: string) {
  return { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" as const } } };
}

export function refundBody(amountCents: number, currency: string, note?: string) {
  if (amountCents <= 0) throw clientError("refund amount must be positive", "refundCapture");
  return {
    amount: money(amountCents, currency),
    ...(note ? { note_to_payer: note.slice(0, 255) } : {}),
  };
}

/** Carrier must be a PayPal enum value; anything that does not look like one goes as OTHER + its name. */
export function trackerBody(input: { captureId: string; trackingNumber: string; carrier: string; notifyPayer: boolean }) {
  const code = input.carrier.trim().toUpperCase();
  const known = /^[A-Z0-9_]+$/.test(code) && code !== "OTHER";
  return {
    capture_id: input.captureId,
    tracking_number: input.trackingNumber.slice(0, 64),
    carrier: known ? code : "OTHER",
    ...(known ? {} : { carrier_name_other: input.carrier.trim().slice(0, 64) }),
    notify_payer: input.notifyPayer,
  };
}

export const WEBHOOK_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

export function lowerHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === "string") out[k.toLowerCase()] = v;
  return out;
}

/**
 * Body for POST /v1/notifications/verify-webhook-signature, or undefined when the delivery cannot be
 * genuine (a header missing, a body that is not a JSON object). The raw event is spliced in verbatim
 * rather than re-serialised, so PayPal checks the exact bytes it signed.
 */
export function verifyWebhookBody(headers: Record<string, string | undefined>, rawBody: string, webhookId: string): string | undefined {
  const h = lowerHeaders(headers);
  const fields: Record<string, string> = {};
  for (const [field, header] of Object.entries(WEBHOOK_HEADERS)) {
    const v = h[header];
    if (!v) return undefined;
    fields[field] = v;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const head = JSON.stringify({ ...fields, webhook_id: webhookId });
  return `${head.slice(0, -1)},"webhook_event":${rawBody.trim()}}`;
}

export function webhookBody(url: string, events: readonly string[] = WEBHOOK_EVENTS) {
  return { url, event_types: events.map((name) => ({ name })) };
}

/**
 * Maps an engine cart to the charge input: unpaid units only (pay-now captures during the show
 * already covered the paid ones) plus the cart's shipping, so the total equals cart.dueCents.
 */
export function toChargeInput(cart: Cart): CartChargeInput {
  const lines = cart.lines
    .map((l) => {
      const paidUnits = l.unitCents > 0 ? Math.round(l.paidCents / l.unitCents) : 0;
      const label = [l.size, l.color].filter(Boolean).join(" / ");
      return {
        name: `#${l.itemCode} ${l.title}${label ? ` (${label})` : ""}`,
        sku: l.sku,
        qty: l.qty - paidUnits,
        unitCents: l.unitCents,
      };
    })
    .filter((l) => l.qty > 0);
  const itemTotal = lines.reduce((a, l) => a + l.qty * l.unitCents, 0);
  if (itemTotal + cart.shippingCents !== cart.dueCents) {
    throw clientError(`cart ${cart.cartId}: unpaid lines ${itemTotal} + shipping ${cart.shippingCents} != due ${cart.dueCents}`);
  }
  return {
    invoiceId: cart.invoiceId,
    requestId: cart.requestId,
    currency: "USD",
    lines,
    shippingCents: cart.shippingCents,
    totalCents: cart.dueCents,
    customId: cart.buyerKey.slice(0, 127),
  };
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
