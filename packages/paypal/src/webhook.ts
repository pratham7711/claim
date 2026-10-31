/** A verified PayPal webhook event, reduced to the ids the app matches on. */
export interface WebhookEvent {
  id: string;
  type: string;
  captureId?: string;
  refundId?: string;
  orderId?: string;
  vaultId?: string;
  /** INVOICING.INVOICE.* events: the invoice, its status and the transaction that paid it. */
  invoiceId?: string;
  invoiceStatus?: string;
  paymentId?: string;
  /** status_details.reason, e.g. why a capture is PENDING. */
  reason?: string;
}

interface WebhookEventJson {
  id?: unknown;
  event_type?: unknown;
  resource?: {
    id?: unknown;
    status_details?: { reason?: unknown };
    links?: { href?: unknown; rel?: unknown }[];
    supplementary_data?: { related_ids?: { order_id?: unknown } };
    invoice?: { id?: unknown; status?: unknown; payments?: { transactions?: { payment_id?: unknown }[] } };
  };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Reads the ids out of a webhook body. Capture events carry the capture as the resource; refund and
 * reversal events carry the refund and link "up" to the capture it came from. Returns undefined for a
 * body that is not an event, so the route can answer 400.
 */
export function readWebhookEvent(rawBody: string): WebhookEvent | undefined {
  let j: WebhookEventJson;
  try {
    j = JSON.parse(rawBody) as WebhookEventJson;
  } catch {
    return undefined;
  }
  const id = str(j?.id);
  const type = str(j?.event_type);
  if (!id || !type) return undefined;
  const r = j.resource ?? {};
  const resourceId = str(r.id);
  const upCapture = r.links
    ?.filter((l) => l.rel === "up")
    .map((l) => str(l.href)?.match(/\/v2\/payments\/captures\/([^/?#]+)/)?.[1])
    .find(Boolean);
  const out: WebhookEvent = { id, type };
  if (type.startsWith("PAYMENT.CAPTURE.")) {
    if (upCapture) {
      out.captureId = upCapture;
      if (resourceId) out.refundId = resourceId;
    } else if (resourceId) out.captureId = resourceId;
  }
  const orderId = str(r.supplementary_data?.related_ids?.order_id) ?? (type.startsWith("CHECKOUT.ORDER.") ? resourceId : undefined);
  if (orderId) out.orderId = orderId;
  if (type.startsWith("VAULT.PAYMENT-TOKEN.") && resourceId) out.vaultId = resourceId;
  if (type.startsWith("INVOICING.INVOICE.")) {
    // The invoice sits under resource.invoice; older payloads put it at the top of the resource.
    const inv = r.invoice ?? (r as { status?: unknown; payments?: { transactions?: { payment_id?: unknown }[] } });
    const invoiceId = str(r.invoice?.id) ?? resourceId;
    if (invoiceId) out.invoiceId = invoiceId;
    const status = str(inv.status);
    if (status) out.invoiceStatus = status;
    const paymentId = inv.payments?.transactions?.map((t) => str(t.payment_id)).find(Boolean);
    if (paymentId) out.paymentId = paymentId;
  }
  const reason = str(r.status_details?.reason);
  if (reason) out.reason = reason;
  return out;
}
