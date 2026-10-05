import type { ChargeResult } from "@claim/core";
import { DECLINE_ISSUES, PAYER_ACTION_ISSUES, PayPalError } from "./errors.js";

interface Link {
  href?: string;
  rel?: string;
}

interface Capture {
  id?: string;
  status?: string;
  status_details?: { reason?: string };
}

export interface OrderJson {
  id?: string;
  status?: string;
  links?: Link[];
  purchase_units?: { payments?: { captures?: Capture[] }; shipping?: { trackers?: { id?: string }[] } }[];
}

export function linkHref(links: Link[] | undefined, rel: string): string | undefined {
  return links?.find((l) => l.rel === rel)?.href;
}

/**
 * Reads an Orders v2 response (create with a vault_id, or capture). A COMPLETED order can still
 * carry a DECLINED or PENDING capture, so the capture status wins over the order status.
 */
export function chargeFromOrder(order: OrderJson, debugId?: string): ChargeResult {
  const orderId = order.id ?? "";
  const extra = debugId ? { debugId } : {};
  if (order.status === "PAYER_ACTION_REQUIRED") return { orderId, status: "PAYER_ACTION_REQUIRED", ...extra };
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (capture?.id) {
    const captureId = capture.id;
    switch (capture.status) {
      case "COMPLETED":
      case "PARTIALLY_REFUNDED":
      case "REFUNDED":
        return { orderId, captureId, status: "COMPLETED", ...extra };
      case "DECLINED":
      case "FAILED":
        return { orderId, captureId, status: "DECLINED", declineCode: capture.status_details?.reason ?? capture.status, ...extra };
      default:
        return { orderId, captureId, status: "PENDING", ...extra };
    }
  }
  if (order.status === "VOIDED") return { orderId, status: "DECLINED", declineCode: "ORDER_VOIDED", ...extra };
  return { orderId, status: "PENDING", ...extra };
}

/**
 * A 422 decline is a result, not an exception: the engine moves the cart to a pay-now link.
 * Everything else (DUPLICATE_INVOICE_ID, validation, auth, outages) is rethrown.
 */
export function chargeFromError(e: unknown, orderId?: string): ChargeResult {
  if (e instanceof PayPalError && e.status === 422 && e.issue) {
    const extra = { ...(orderId ? { orderId } : {}), ...(e.debugId ? { debugId: e.debugId } : {}) };
    if (DECLINE_ISSUES.has(e.issue)) return { status: "DECLINED", declineCode: e.issue, ...extra };
    if (PAYER_ACTION_ISSUES.has(e.issue)) return { status: "PAYER_ACTION_REQUIRED", declineCode: e.issue, ...extra };
  }
  throw e;
}

/** Tracker ids are `<capture_id>-<tracking_number>`; prefer the one PayPal echoes back. */
export function trackerIdFrom(order: OrderJson, captureId: string, trackingNumber: string): string {
  const fallback = `${captureId}-${trackingNumber}`;
  const trackers = (order.purchase_units ?? []).flatMap((pu) => pu.shipping?.trackers ?? []);
  return trackers.find((t) => t.id === fallback)?.id ?? trackers.find((t) => t.id?.endsWith(`-${trackingNumber}`))?.id ?? fallback;
}
