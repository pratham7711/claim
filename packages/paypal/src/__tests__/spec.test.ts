import { describe, expect, it } from "vitest";
import { setupTokenBody, trackerBody, vaultOrderBody, payNowOrderBody, refundBody, paymentTokenBody, webhookBody } from "../bodies.js";
import { createSandboxGateway } from "../sandbox.js";
import { fakeFetch, noSleep, orderJson, type RecordedCall } from "./fake-fetch.js";
import { URLS, cart } from "./fixtures.js";
import { SPEC_DIR, findOperation, loadSpec, requestSchema, validate, type Spec } from "./openapi.js";

const specs = {
  orders: loadSpec("checkout_orders_v2.json"),
  vault: loadSpec("vault_payment_tokens_v3.json"),
  payments: loadSpec("payments_payment_v2.json"),
  webhooks: loadSpec("notifications_webhooks_v1.json"),
};
const missing = Object.entries(specs)
  .filter(([, s]) => !s)
  .map(([k]) => k);

function specFor(path: string): Spec | undefined {
  if (path.startsWith("/v2/checkout/orders")) return specs.orders;
  if (path.startsWith("/v3/vault")) return specs.vault;
  if (path.startsWith("/v2/payments")) return specs.payments;
  if (path.startsWith("/v1/notifications")) return specs.webhooks;
  return undefined;
}

function schemaErrors(spec: Spec, method: string, path: string, body: unknown, opaque: string[] = []): string[] {
  const found = findOperation(spec, method, path);
  if (!found) return [`${method} ${path}: no such operation in ${spec.file}`];
  const schema = requestSchema(found.op);
  if (!schema) return body === undefined ? [] : [`${method} ${found.template}: spec defines no JSON body`];
  if (body === undefined) return [];
  return validate(spec, schema, body, "$", new Set(opaque)).map((e) => `${method} ${found.template} ${e}`);
}

/** Header names the operation declares, lower-cased. */
function declaredHeaders(spec: Spec, method: string, path: string): Set<string> {
  const found = findOperation(spec, method, path)!;
  const params = (found.op.parameters as { $ref?: string; name?: string; in?: string }[] | undefined) ?? [];
  const out = new Set<string>();
  for (const p of params) {
    const r = p.$ref ? (spec.doc.components.parameters?.[p.$ref.split("/").pop()!] as { name?: string; in?: string }) : p;
    if (r?.in === "header" && r.name) out.add(r.name.toLowerCase());
  }
  return out;
}

/** Drives every gateway method against a fake PayPal and returns what was sent. */
async function recordEverything(): Promise<RecordedCall[]> {
  const ff = fakeFetch();
  ff.on("POST /v3/vault/setup-tokens", { status: 201, body: { id: "ST1", status: "PAYER_ACTION_REQUIRED", links: [] } });
  ff.on("GET /v3/vault/setup-tokens", { status: 200, body: { id: "ST1", status: "APPROVED" } });
  ff.on("POST /v3/vault/payment-tokens", { status: 201, body: { id: "jwgvx42", customer: { id: "customer_1" } } });
  ff.on("DELETE /v3/vault/payment-tokens", { status: 204 });
  ff.on("POST /v2/checkout/orders/O1/capture", { status: 201, body: orderJson({ id: "O1" }) });
  ff.on("POST /v2/checkout/orders/O1/track", { status: 201, body: { id: "O1" } });
  ff.on("GET /v2/checkout/orders", { status: 200, body: orderJson({ id: "O1" }) });
  ff.on("POST /v2/checkout/orders", { status: 201, body: { id: "O1", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=O1" }] } });
  ff.on("POST /v2/payments/captures/C1/refund", { status: 201, body: { id: "R1", status: "COMPLETED" } });
  ff.on("POST /v1/notifications/verify-webhook-signature", { status: 200, body: { verification_status: "SUCCESS" } });
  ff.on("GET /v1/notifications/webhooks", { status: 200, body: { webhooks: [] } });
  ff.on("POST /v1/notifications/webhooks", { status: 201, body: { id: "WH1" } });

  const base = { clientId: "CID", clientSecret: "S", webhookId: "WH123", fetchImpl: ff.fetchImpl, sleep: noSleep };
  const gw = createSandboxGateway({ ...base, brandName: "Juniper Boutique", setupDescription: "Claim Pass", mockResponse: "INSTRUMENT_DECLINED" });
  const plain = createSandboxGateway({ ...base, storedCredential: false, linkMerchantCustomerId: false });

  await gw.createSetupToken({ buyerKey: "twitch:111", ...URLS });
  await plain.createSetupToken({ buyerKey: "room_ana", ...URLS });
  await gw.getSetupToken("ST1");
  await gw.createPaymentToken("ST1");
  await gw.deletePaymentToken("jwgvx42");
  await gw.chargeVaulted("jwgvx42", cart());
  await plain.chargeVaulted("jwgvx42", cart({ customId: undefined }));
  await gw.createPayNowOrder(cart(), URLS);
  await gw.captureOrder("O1");
  await gw.getOrder("O1");
  await gw.refundCapture("C1", 3400, "Sold out");
  await gw.refundCapture("C1", 100);
  await gw.addTracking({ orderId: "O1", captureId: "C1", trackingNumber: "9400111899223", carrier: "USPS", notifyPayer: true });
  await gw.addTracking({ orderId: "O1", captureId: "C1", trackingNumber: "RM123", carrier: "Royal Mail", notifyPayer: false });
  await gw.verifyWebhook(
    {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42",
      "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
      "paypal-transmission-sig": "lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz==",
      "paypal-transmission-time": "2026-10-05T10:00:00Z",
    },
    '{"id":"WH-58D329510W468432D-8HN650336L201105X","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"C1"}}',
  );
  await gw.listWebhooks();
  await gw.registerWebhook("https://claim.example/api/paypal/webhook");
  return ff.api();
}

describe.skipIf(missing.length > 0)(`OpenAPI conformance (${SPEC_DIR})`, () => {
  it("every request the sandbox gateway sends matches its operation's schema", async () => {
    const calls = await recordEverything();
    expect(calls.length).toBe(17);
    const errors = calls.flatMap((c) => {
      const spec = specFor(c.path);
      if (!spec) return [`${c.method} ${c.path}: no spec mapped`];
      const opaque = c.path === "/v1/notifications/verify-webhook-signature" ? ["$.webhook_event"] : [];
      return schemaErrors(spec, c.method, c.path, c.json, opaque);
    });
    expect(errors).toEqual([]);
  });

  it("sends only headers the operation declares (plus the negative-testing header)", async () => {
    const calls = await recordEverything();
    const generic = new Set(["accept", "content-type", "authorization", "paypal-mock-response"]);
    const errors = calls.flatMap((c) => {
      const declared = declaredHeaders(specFor(c.path)!, c.method, c.path);
      return Object.keys(c.headers)
        .filter((h) => !generic.has(h) && !declared.has(h))
        .map((h) => `${c.method} ${c.path}: header ${h} is not declared`);
    });
    expect(errors).toEqual([]);
  });

  it("sends PayPal-Request-Id on every create the spec makes idempotent", async () => {
    const calls = await recordEverything();
    for (const c of calls) {
      const declared = declaredHeaders(specFor(c.path)!, c.method, c.path);
      if (c.method === "POST" && declared.has("paypal-request-id")) expect(c.headers["paypal-request-id"], `${c.path}`).toBeTruthy();
    }
  });

  it("the setup token body has the required fields and valid enums", () => {
    const body = setupTokenBody({ buyerKey: "youtube:UC-" + "x".repeat(80), ...URLS }, { description: "d".repeat(200), brandName: "B" });
    expect(schemaErrors(specs.vault!, "POST", "/v3/vault/setup-tokens", body)).toEqual([]);
    expect(schemaErrors(specs.vault!, "POST", "/v3/vault/payment-tokens", paymentTokenBody("4G4976650J0948357"))).toEqual([]);
  });

  it("order bodies conform with and without stored_credential, and at the limits", () => {
    const long = cart({
      lines: [{ name: "n".repeat(500), sku: "s".repeat(300), qty: 3, unitCents: 1 }],
      shippingCents: 0,
      totalCents: 3,
      invoiceId: "i".repeat(127),
    });
    for (const body of [
      vaultOrderBody("jwgvx42", cart(), { storedCredential: true }),
      vaultOrderBody("jwgvx42", long, { storedCredential: false }),
      payNowOrderBody(cart(), URLS, "b".repeat(200)),
    ]) {
      expect(schemaErrors(specs.orders!, "POST", "/v2/checkout/orders", body)).toEqual([]);
    }
  });

  it("refund, tracker and webhook bodies conform, including the OTHER carrier path", () => {
    expect(schemaErrors(specs.payments!, "POST", "/v2/payments/captures/C1/refund", refundBody(1, "USD", "x".repeat(400)))).toEqual([]);
    for (const carrier of ["FEDEX", "dhl", "La Poste Colissimo", "other"]) {
      const body = trackerBody({ captureId: "8MC585209K746392H", trackingNumber: "t".repeat(80), carrier, notifyPayer: true });
      expect(schemaErrors(specs.orders!, "POST", "/v2/checkout/orders/O1/track", body), carrier).toEqual([]);
    }
    expect(schemaErrors(specs.webhooks!, "POST", "/v1/notifications/webhooks", webhookBody("https://claim.example/hook"))).toEqual([]);
  });

  it("the validator itself catches the mistakes it exists for", () => {
    const body = vaultOrderBody("jwgvx42", cart(), { storedCredential: true }) as Record<string, unknown>;
    const bad = structuredClone(body) as { intent: string; purchase_units: Record<string, unknown>[]; payment_source: { paypal: Record<string, unknown> } };
    bad.intent = "SALE";
    bad.purchase_units[0]!.invoiceId = "camelCase";
    (bad.purchase_units[0]!.items as Record<string, unknown>[])[0]!.category = "PHYSICAL";
    (bad.purchase_units[0]!.items as Record<string, unknown>[])[0]!.quantity = "0";
    bad.payment_source.paypal.stored_credential = { usage: "SUBSEQUENT" };
    const errors = schemaErrors(specs.orders!, "POST", "/v2/checkout/orders", bad).join("\n");
    expect(errors).toMatch(/intent: "SALE" not in enum/);
    expect(errors).toMatch(/unknown property "invoiceId"/);
    expect(errors).toMatch(/category: "PHYSICAL" not in enum/);
    expect(errors).toMatch(/quantity: "0" does not match/);
    expect(errors).toMatch(/missing required "payment_initiator"/);
    expect(schemaErrors(specs.orders!, "POST", "/v2/checkout/orders/O1/track", { capture_id: "C1", carrier: "NOT_A_CARRIER" })).toEqual(
      expect.arrayContaining([expect.stringMatching(/missing required "tracking_number"/), expect.stringMatching(/not in enum/)]),
    );
  });
});

if (missing.length > 0) {
  describe("OpenAPI conformance", () => {
    it.skip(`skipped: spec files missing under ${SPEC_DIR}: ${missing.join(", ")}`, () => {});
  });
}
