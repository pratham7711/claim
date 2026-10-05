import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mockShipTo, type MockGateway } from "@claim/paypal";
import { afterEach, describe, expect, it } from "vitest";
import { selectGateway } from "./payments";
import { createShowService, type ShowService } from "./service";
import { createFileStore, createMemoryStore, type ShowStore } from "./store";
import type { ShowView } from "./types";

const T0 = Date.UTC(2026, 9, 6, 18, 0, 0);

let services: ShowService[] = [];
afterEach(() => {
  for (const s of services) s.dispose();
  services = [];
});

/** The mock gateway, with the vault ids it hands out recorded per buyer so a test can name a wallet. */
function setup(store: ShowStore = createMemoryStore()) {
  const selected = selectGateway({});
  const gw = selected.gateway as MockGateway;
  const buyerOf = new Map<string, string>();
  const vaultOf = new Map<string, string>();
  const createSetupToken = gw.createSetupToken.bind(gw);
  const createPaymentToken = gw.createPaymentToken.bind(gw);
  gw.createSetupToken = async (input) => {
    const r = await createSetupToken(input);
    buyerOf.set(r.setupTokenId, input.buyerKey);
    return r;
  };
  gw.createPaymentToken = async (setupTokenId) => {
    const r = await createPaymentToken(setupTokenId);
    vaultOf.set(buyerOf.get(setupTokenId)!, r.vaultId);
    return r;
  };
  const svc = createShowService({ store, gateway: selected, now: () => T0, tickMs: false, broadcastMs: 0 });
  services.push(svc);
  return { svc, gw, vaultOf };
}

async function closedOut(svc: ShowService) {
  const id = await svc.create({ seed: true });
  await svc.runScenario(id, "race", { instant: true });
  await svc.act(id, { action: "end" });
  expect(await svc.act(id, { action: "chargeAll" })).toMatchObject({ ok: true, data: { charged: 1, declined: 1 } });
  return id;
}

function deliver(svc: ShowService, gw: MockGateway, event: Record<string, unknown>, sign = true) {
  const raw = JSON.stringify(event);
  return svc.webhook(sign ? gw.signWebhook(raw) : {}, raw);
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("ship-to addresses", () => {
  it("charges the saved wallet's address and records it on the completed charge", async () => {
    const { svc } = setup();
    const id = await closedOut(svc);
    const seller = svc.view(id, "seller")!;
    const done = seller.charges.find((c) => c.status === "COMPLETED")!;
    const buyerKey = seller.carts.find((b) => b.finalized.some((c) => c.cartId === done.cartId))!.buyerKey;
    expect(done.shipTo).toEqual(mockShipTo(buyerKey));
    expect(seller.charges.find((c) => c.status === "DECLINED")!.shipTo).toBeUndefined();
  });

  it("keeps every address out of the public view that buyer rooms get", async () => {
    const { svc } = setup();
    const id = await closedOut(svc);
    const pub = svc.view(id)!;
    expect(pub.charges.length).toBeGreaterThan(0);
    expect(pub.charges.every((c) => !("shipTo" in c))).toBe(true);
    expect(JSON.stringify(pub)).not.toMatch(/Main St|95131/);
    expect(JSON.stringify(svc.view(id, "seller"))).toMatch(/Main St/);
  });

  it("streams addresses to seller subscribers only", async () => {
    const { svc } = setup();
    const id = await closedOut(svc);
    const got: Record<string, ShowView[]> = { public: [], seller: [] };
    const offPub = svc.subscribe(id, (v) => got.public!.push(v))!;
    const offSeller = svc.subscribe(id, (v) => got.seller!.push(v), "seller")!;
    await svc.act(id, { action: "chargeAll" });
    await flush();
    offPub();
    offSeller();
    expect(got.public!.length).toBeGreaterThan(0);
    expect(got.seller!.length).toBeGreaterThan(0);
    expect(JSON.stringify(got.public)).not.toMatch(/Main St/);
    expect(JSON.stringify(got.seller!.at(-1))).toMatch(/Main St/);
  });

  it("keeps the address through a restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claim-ship-"));
    try {
      const first = setup(createFileStore(dir));
      const id = await closedOut(first.svc);
      const before = first.svc.view(id, "seller")!.charges;
      first.svc.dispose();
      const second = setup(createFileStore(dir));
      expect(second.svc.view(id, "seller")!.charges).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PayPal webhooks", () => {
  it("records a verified capture event on the cart it belongs to, once", async () => {
    const { svc, gw } = setup();
    const id = await closedOut(svc);
    const charge = svc.view(id)!.charges.find((c) => c.status === "COMPLETED")!;
    const event = {
      id: "WH-CAP-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource_type: "capture",
      resource: { id: charge.captureId, status: "COMPLETED", supplementary_data: { related_ids: { order_id: charge.orderId } } },
    };
    expect(await deliver(svc, gw, event)).toEqual({ status: 200, body: { ok: true, event: "PAYMENT.CAPTURE.COMPLETED", matched: 1 } });
    expect(await deliver(svc, gw, event)).toEqual({ status: 200, body: { ok: true, event: "PAYMENT.CAPTURE.COMPLETED", duplicate: true } });
    const hooks = svc.view(id)!.webhooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ eventId: "WH-CAP-1", captureId: charge.captureId, orderId: charge.orderId, summary: "PayPal confirmed the payment" });
  });

  it("matches a refund event to its capture through the 'up' link", async () => {
    const { svc, gw } = setup();
    const id = await closedOut(svc);
    const charge = svc.view(id)!.charges.find((c) => c.status === "COMPLETED")!;
    const r = await deliver(svc, gw, {
      id: "WH-REF-1",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource_type: "refund",
      resource: { id: "REFUND1", links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${charge.captureId}` }] },
    });
    expect(r.body).toMatchObject({ matched: 1 });
    expect(svc.view(id)!.webhooks[0]).toMatchObject({ refundId: "REFUND1", captureId: charge.captureId, summary: "PayPal confirmed the refund" });
  });

  it("refuses an unsigned or altered delivery with 401 and changes nothing", async () => {
    const { svc, gw } = setup();
    const id = await closedOut(svc);
    const event = { id: "WH-BAD", event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: svc.view(id)!.charges[0]!.captureId } };
    expect((await deliver(svc, gw, event, false)).status).toBe(401);
    const raw = JSON.stringify(event);
    const headers = gw.signWebhook(raw);
    expect((await svc.webhook(headers, raw.replace("REVERSED", "COMPLETED"))).status).toBe(401);
    expect(svc.view(id)!.webhooks).toEqual([]);
  });

  it("answers 400 for a signed body that is not an event, and 200 with no match for another app's capture", async () => {
    const { svc, gw } = setup();
    await closedOut(svc);
    expect((await deliver(svc, gw, { hello: "world" })).status).toBe(400);
    expect(await deliver(svc, gw, { id: "WH-OTHER", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "NOT-OURS" } })).toEqual({
      status: 200,
      body: { ok: true, event: "PAYMENT.CAPTURE.COMPLETED", matched: 0 },
    });
  });

  it("revokes the Claim Pass when the buyer deletes the wallet in PayPal, and it stays revoked after a restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claim-hook-"));
    try {
      const first = setup(createFileStore(dir));
      const id = await first.svc.create({ seed: true });
      await first.svc.runScenario(id, "race", { instant: true });
      const holder = first.svc.view(id)!.buyers.find((b) => b.vaulted && first.vaultOf.has(b.buyerKey))!;
      const r = await deliver(first.svc, first.gw, { id: "WH-VAULT-DEL", event_type: "VAULT.PAYMENT-TOKEN.DELETED", resource: { id: first.vaultOf.get(holder.buyerKey) } });
      expect(r.body).toMatchObject({ matched: 1 });

      const v = first.svc.view(id)!;
      expect(v.buyers.find((b) => b.buyerKey === holder.buyerKey)).toMatchObject({ vaulted: false, hasPass: false });
      expect(v.audit.some((a) => /revoked the Claim Pass/.test(a.reason))).toBe(true);
      expect(v.webhooks[0]).toMatchObject({ type: "VAULT.PAYMENT-TOKEN.DELETED", summary: expect.stringMatching(/Claim Pass is revoked/) });
      first.svc.dispose();

      const second = setup(createFileStore(dir));
      const after = second.svc.view(id)!;
      expect(after.buyers.find((b) => b.buyerKey === holder.buyerKey)).toMatchObject({ vaulted: false, hasPass: false });
      expect(after.webhooks).toHaveLength(1);
      expect(await deliver(second.svc, second.gw, { id: "WH-VAULT-DEL", event_type: "VAULT.PAYMENT-TOKEN.DELETED", resource: { id: "x" } })).toMatchObject({
        body: { matched: 0 },
      });
      await second.svc.act(id, { action: "end" });
      const charged = await second.svc.act(id, { action: "chargeAll" });
      expect(charged.ok).toBe(true);
      const holderCarts = second.svc.view(id)!.carts.find((b) => b.buyerKey === holder.buyerKey)!.finalized;
      expect(holderCarts.every((c) => c.status !== "charged")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says plainly when the sandbox has no webhook id configured", async () => {
    const selected = selectGateway({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" });
    const svc = createShowService({ store: createMemoryStore(), gateway: selected, now: () => T0, tickMs: false });
    services.push(svc);
    const raw = JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "C1" } });
    const r = await svc.webhook({}, raw);
    expect(r.status).toBe(503);
    expect(String(r.body.error)).toMatch(/PAYPAL_WEBHOOK_ID/);
  });
});
