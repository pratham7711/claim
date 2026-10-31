import { describe, expect, it } from "vitest";
import { createMockGateway } from "../mock.js";
import { readWebhookEvent } from "../webhook.js";

const body = (o: unknown) => JSON.stringify(o);

describe("readWebhookEvent", () => {
  it("takes the capture and its order from a capture event", () => {
    const e = readWebhookEvent(
      body({
        id: "WH-1",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource_type: "capture",
        resource: {
          id: "8G519028VL643194V",
          status: "COMPLETED",
          supplementary_data: { related_ids: { order_id: "4SK18946KA017831G" } },
          links: [{ href: "https://api.sandbox.paypal.com/v2/checkout/orders/4SK18946KA017831G", rel: "up" }],
        },
      }),
    );
    expect(e).toEqual({ id: "WH-1", type: "PAYMENT.CAPTURE.COMPLETED", captureId: "8G519028VL643194V", orderId: "4SK18946KA017831G" });
  });

  it("takes the refund and follows the 'up' link to its capture on a refund event", () => {
    const e = readWebhookEvent(
      body({
        id: "WH-2",
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        resource_type: "refund",
        resource: {
          id: "1JU08902781691411",
          links: [
            { href: "https://api.sandbox.paypal.com/v2/payments/refunds/1JU08902781691411", rel: "self" },
            { href: "https://api.sandbox.paypal.com/v2/payments/captures/8G519028VL643194V", rel: "up" },
          ],
        },
      }),
    );
    expect(e).toEqual({ id: "WH-2", type: "PAYMENT.CAPTURE.REFUNDED", captureId: "8G519028VL643194V", refundId: "1JU08902781691411" });
  });

  it("keeps the reason on a pending capture", () => {
    const e = readWebhookEvent(body({ id: "WH-3", event_type: "PAYMENT.CAPTURE.PENDING", resource: { id: "C1", status_details: { reason: "PENDING_REVIEW" } } }));
    expect(e).toMatchObject({ captureId: "C1", reason: "PENDING_REVIEW" });
  });

  it("reads the wallet on vault events and the order on checkout events", () => {
    expect(readWebhookEvent(body({ id: "WH-4", event_type: "VAULT.PAYMENT-TOKEN.DELETED", resource: { id: "8kk8451t" } }))).toEqual({
      id: "WH-4",
      type: "VAULT.PAYMENT-TOKEN.DELETED",
      vaultId: "8kk8451t",
    });
    expect(readWebhookEvent(body({ id: "WH-5", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "5O190127TN364715T" } }))).toEqual({
      id: "WH-5",
      type: "CHECKOUT.ORDER.APPROVED",
      orderId: "5O190127TN364715T",
    });
  });

  it("takes the invoice, its status and the paying transaction from an invoice event", () => {
    const paid = {
      id: "WH-8",
      event_type: "INVOICING.INVOICE.PAID",
      resource: { invoice: { id: "INV2-ABCD-EFGH", status: "PAID", payments: { transactions: [{ payment_id: "7AB12345CD678901E" }] } } },
    };
    expect(readWebhookEvent(body(paid))).toEqual({ id: "WH-8", type: "INVOICING.INVOICE.PAID", invoiceId: "INV2-ABCD-EFGH", invoiceStatus: "PAID", paymentId: "7AB12345CD678901E" });
    expect(readWebhookEvent(body({ id: "WH-9", event_type: "INVOICING.INVOICE.PAID", resource: { id: "INV2-TOP", status: "MARKED_AS_PAID" } }))).toEqual({
      id: "WH-9",
      type: "INVOICING.INVOICE.PAID",
      invoiceId: "INV2-TOP",
      invoiceStatus: "MARKED_AS_PAID",
    });
  });

  it("refuses bodies that are not events", () => {
    for (const raw of ["", "not json", "[]", "null", body({ id: "WH-6" }), body({ event_type: "PAYMENT.CAPTURE.COMPLETED" }), body({ id: 7, event_type: "X" })]) {
      expect(readWebhookEvent(raw)).toBeUndefined();
    }
  });

  it("ignores ids of the wrong type instead of trusting them", () => {
    const e = readWebhookEvent(body({ id: "WH-7", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: 42, links: [{ rel: "up", href: 5 }] } }));
    expect(e).toEqual({ id: "WH-7", type: "PAYMENT.CAPTURE.COMPLETED" });
  });
});

describe("mock webhook signatures", () => {
  it("verifies exactly the body it signed", async () => {
    const gw = createMockGateway();
    const raw = body({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "C1" } });
    const headers = gw.signWebhook(raw);
    expect(await gw.verifyWebhook(headers, raw)).toBe(true);
    expect(await gw.verifyWebhook(headers, raw.replace("C1", "C2"))).toBe(false);
    expect(await gw.verifyWebhook({}, raw)).toBe(false);
  });
});
