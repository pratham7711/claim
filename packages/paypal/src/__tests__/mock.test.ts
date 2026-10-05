import { describe, expect, it } from "vitest";
import { PayPalError } from "../errors.js";
import { createMockGateway, type MockGateway } from "../mock.js";
import { URLS, cart } from "./fixtures.js";

async function vault(gw: MockGateway, buyerKey = "twitch:111") {
  const { setupTokenId } = await gw.createSetupToken({ buyerKey, ...URLS });
  return gw.createPaymentToken(setupTokenId);
}

async function rejection(p: Promise<unknown>): Promise<PayPalError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PayPalError) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("mock gateway", () => {
  it("runs the Claim Pass flow with plausible, deterministic ids", async () => {
    const run = async () => {
      const gw = createMockGateway({ seed: "demo" });
      const v = await vault(gw);
      const charge = await gw.chargeVaulted(v.vaultId, cart());
      return { v, charge, mode: gw.mode, clientToken: await gw.clientToken() };
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a.mode).toBe("mock");
    expect(a.v.vaultId).toMatch(/^[0-9a-z]{7}$/);
    expect(a.v.customerId).toMatch(/^customer_\d{10}$/);
    expect(a.charge.status).toBe("COMPLETED");
    expect(a.charge.orderId).toMatch(/^[0-9A-Z]{17}$/);
    expect(a.charge.captureId).toMatch(/^[0-9A-Z]{17}$/);
    expect(a.charge.debugId).toMatch(/^[0-9a-f]{13}$/);
    expect(a.clientToken).toBeTruthy();
  });

  it("gives a different seed different ids, and one customer per buyer", async () => {
    const x = await vault(createMockGateway({ seed: "x" }));
    const y = await vault(createMockGateway({ seed: "y" }));
    expect(x.vaultId).not.toBe(y.vaultId);
    const gw = createMockGateway();
    const first = await vault(gw, "room:ana");
    const second = await vault(gw, "room:ana");
    expect(second.customerId).toBe(first.customerId);
    expect(second.vaultId).not.toBe(first.vaultId);
  });

  it("replays the same order for the same requestId", async () => {
    const gw = createMockGateway();
    const v = await vault(gw);
    const first = await gw.chargeVaulted(v.vaultId, cart());
    const again = await gw.chargeVaulted(v.vaultId, cart());
    expect(again).toEqual(first);
    expect(gw.orders()).toHaveLength(1);
  });

  it("refuses a duplicate invoiceId under a new requestId like PayPal", async () => {
    const gw = createMockGateway();
    const v = await vault(gw);
    await gw.chargeVaulted(v.vaultId, cart());
    const err = await rejection(gw.chargeVaulted(v.vaultId, cart({ requestId: "retry-2" })));
    expect(err).toMatchObject({ status: 422, errorName: "UNPROCESSABLE_ENTITY", issue: "DUPLICATE_INVOICE_ID" });
    expect(err.debugId).toMatch(/^[0-9a-f]{13}$/);
    await expect(gw.createPayNowOrder(cart({ requestId: "pn" }), URLS)).rejects.toThrow(/DUPLICATE_INVOICE_ID/);
  });

  it("declines scripted buyers, and a decline leaves the invoice free for the pay-now fallback", async () => {
    const gw = createMockGateway({ declineBuyerKeys: ["twitch:111"] });
    const v = await vault(gw);
    const res = await gw.chargeVaulted(v.vaultId, cart());
    expect(res).toMatchObject({ status: "DECLINED", declineCode: "INSTRUMENT_DECLINED" });
    expect(res.orderId).toBeUndefined();
    expect(await gw.chargeVaulted(v.vaultId, cart())).toEqual(res);

    const ok = await vault(gw, "twitch:222");
    expect((await gw.chargeVaulted(ok.vaultId, cart({ invoiceId: "inv-222", requestId: "inv-222", customId: "twitch:222" }))).status).toBe("COMPLETED");

    const pn = await gw.createPayNowOrder(cart({ customId: "twitch:999" }), URLS);
    expect(pn.approveUrl).toBe(`${URLS.returnUrl}?token=${pn.orderId}&PayerID=MOCKPAYER`);
    expect((await gw.captureOrder(pn.orderId)).status).toBe("COMPLETED");
  });

  it("supports a custom decline script, including PAYER_ACTION_REQUIRED and thrown errors", async () => {
    const gw = createMockGateway({
      decline: (c) => (c.cart.totalCents > 10_000 ? "PAYER_ACTION_REQUIRED" : c.cart.invoiceId === "boom" ? "INVALID_PARAMETER_VALUE" : undefined),
    });
    const v = await vault(gw);
    const big = cart({ lines: [{ name: "Coat", sku: "c", qty: 1, unitCents: 20_000 }], shippingCents: 0, totalCents: 20_000 });
    expect(await gw.chargeVaulted(v.vaultId, big)).toMatchObject({ status: "PAYER_ACTION_REQUIRED", declineCode: "PAYER_ACTION_REQUIRED" });
    const err = await rejection(gw.chargeVaulted(v.vaultId, cart({ invoiceId: "boom", requestId: "boom" })));
    expect(err.issue).toBe("INVALID_PARAMETER_VALUE");
    await expect(gw.chargeVaulted(v.vaultId, cart({ invoiceId: "boom", requestId: "boom" }))).rejects.toBe(err);
  });

  it("declines a pay-now capture for a scripted buyer via customId", async () => {
    const gw = createMockGateway({ declineBuyerKeys: ["twitch:111"], declineCode: "TRANSACTION_REFUSED" });
    const pn = await gw.createPayNowOrder(cart(), URLS);
    expect(await gw.captureOrder(pn.orderId)).toMatchObject({ orderId: pn.orderId, status: "DECLINED", declineCode: "TRANSACTION_REFUSED" });
  });

  it("requires approval when autoApprove is off", async () => {
    const gw = createMockGateway({ autoApprove: false });
    const { setupTokenId } = await gw.createSetupToken({ buyerKey: "b", ...URLS });
    expect((await rejection(gw.createPaymentToken(setupTokenId))).issue).toBe("PAYER_ACTION_REQUIRED");
    gw.approveSetupToken(setupTokenId);
    const first = await gw.createPaymentToken(setupTokenId);
    expect(await gw.createPaymentToken(setupTokenId)).toEqual(first);

    const pn = await gw.createPayNowOrder(cart(), URLS);
    expect(await gw.captureOrder(pn.orderId)).toMatchObject({ status: "PAYER_ACTION_REQUIRED", declineCode: "ORDER_NOT_APPROVED" });
    gw.approveOrder(pn.orderId);
    expect((await gw.captureOrder(pn.orderId)).status).toBe("COMPLETED");
    expect((await rejection(gw.captureOrder(pn.orderId))).issue).toBe("ORDER_ALREADY_CAPTURED");
  });

  it("replays a pay-now order for the same cart and refuses unknown ids", async () => {
    const gw = createMockGateway();
    const a = await gw.createPayNowOrder(cart(), URLS);
    expect(await gw.createPayNowOrder(cart(), URLS)).toEqual(a);
    expect((await rejection(gw.captureOrder("NOPE"))).status).toBe(404);
    expect((await rejection(gw.createPaymentToken("NOPE"))).status).toBe(404);
  });

  it("stops charging a deleted vault", async () => {
    const gw = createMockGateway();
    const v = await vault(gw);
    await gw.deletePaymentToken(v.vaultId);
    await gw.deletePaymentToken(v.vaultId);
    expect((await rejection(gw.chargeVaulted(v.vaultId, cart()))).issue).toBe("INVALID_RESOURCE_ID");
  });

  it("validates carts exactly like the sandbox gateway", async () => {
    const gw = createMockGateway();
    const v = await vault(gw);
    expect((await rejection(gw.chargeVaulted(v.vaultId, cart({ totalCents: 5 })))).errorName).toBe("CLIENT_VALIDATION");
  });

  it("refunds up to the captured amount", async () => {
    const gw = createMockGateway();
    const v = await vault(gw);
    const c = await gw.chargeVaulted(v.vaultId, cart());
    const r = await gw.refundCapture(c.captureId!, 3400, "sold out");
    expect(r.status).toBe("COMPLETED");
    expect(r.refundId).toMatch(/^[0-9A-Z]{17}$/);
    expect((await rejection(gw.refundCapture(c.captureId!, cart().totalCents))).issue).toBe("REFUND_AMOUNT_EXCEEDED");
    expect((await rejection(gw.refundCapture("NOPE", 1))).status).toBe(404);
  });

  it("replays a refund with the same request id instead of refunding twice", async () => {
    const gw = createMockGateway();
    const v = await vault(gw);
    const c = await gw.chargeVaulted(v.vaultId, cart());
    const first = await gw.refundCapture(c.captureId!, cart().totalCents, undefined, "inv-1-r0");
    expect(await gw.refundCapture(c.captureId!, cart().totalCents, undefined, "inv-1-r0")).toEqual(first);
    expect((await rejection(gw.refundCapture(c.captureId!, 1, undefined, "inv-1-r1"))).issue).toBe("REFUND_AMOUNT_EXCEEDED");
  });

  it("adds tracking idempotently and checks the capture belongs to the order", async () => {
    const gw = createMockGateway();
    const v = await vault(gw);
    const c = await gw.chargeVaulted(v.vaultId, cart());
    const input = { orderId: c.orderId!, captureId: c.captureId!, trackingNumber: "9400111899223", carrier: "USPS", notifyPayer: true };
    expect(await gw.addTracking(input)).toEqual({ trackerId: `${c.captureId}-9400111899223` });
    await gw.addTracking(input);
    expect(gw.orders()[0]!.trackers).toEqual([`${c.captureId}-9400111899223`]);
    expect((await rejection(gw.addTracking({ ...input, captureId: "OTHER" }))).issue).toBe("INVALID_PARAMETER_VALUE");
  });

  it("verifies webhooks it signed and rejects tampering", async () => {
    const gw = createMockGateway();
    const raw = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED"}';
    const headers = gw.signWebhook(raw);
    expect(await gw.verifyWebhook(headers, raw)).toBe(true);
    expect(await gw.verifyWebhook(headers, raw.replace("WH-1", "WH-2"))).toBe(false);
    expect(await gw.verifyWebhook({ ...headers, "paypal-transmission-sig": "forged" }, raw)).toBe(false);
    expect(await gw.verifyWebhook({}, raw)).toBe(false);
  });
});
