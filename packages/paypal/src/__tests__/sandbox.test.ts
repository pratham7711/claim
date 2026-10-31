import { describe, expect, it } from "vitest";
import { PayPalError } from "../errors.js";
import { createSandboxGateway, type SandboxGatewayOptions } from "../sandbox.js";
import { fakeFetch, issue422, noSleep, orderJson } from "./fake-fetch.js";
import { URLS, cart } from "./fixtures.js";

const BASE = "https://api-m.sandbox.paypal.com";

function setup(over: Partial<SandboxGatewayOptions> = {}) {
  const ff = fakeFetch();
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const gw = createSandboxGateway({
    clientId: "CID",
    clientSecret: "SECRET",
    webhookId: "WH-123",
    fetchImpl: ff.fetchImpl,
    sleep: noSleep,
    now: clock.now,
    ...over,
  });
  return { ff, gw, clock };
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

describe("config", () => {
  it("refuses a live base URL and missing credentials", () => {
    expect(() => createSandboxGateway({ clientId: "a", clientSecret: "b", baseUrl: "https://api-m.paypal.com" })).toThrow(/non-sandbox/);
    expect(() => createSandboxGateway({ clientId: "", clientSecret: "b" })).toThrow(/required/);
    expect(createSandboxGateway({ clientId: "a", clientSecret: "b", baseUrl: "https://api.sandbox.paypal.com" }).mode).toBe("sandbox");
  });
});

describe("OAuth token cache", () => {
  it("fetches a client-credentials token with Basic auth and reuses it", async () => {
    const { ff, gw } = setup();
    ff.on("DELETE /v3/vault/payment-tokens", { status: 204 });
    await gw.deletePaymentToken("abc");
    await gw.deletePaymentToken("def");
    const tokenCalls = ff.calls.filter((c) => c.path === "/v1/oauth2/token");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.headers.authorization).toBe(`Basic ${btoa("CID:SECRET")}`);
    expect(tokenCalls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenCalls[0]!.body).toBe("grant_type=client_credentials");
    expect(ff.api().map((c) => c.headers.authorization)).toEqual(["Bearer access-1", "Bearer access-1"]);
  });

  it("refreshes after expiry (minus a skew) and shares one in-flight fetch", async () => {
    const { ff, gw, clock } = setup();
    ff.on("DELETE /v3/vault/payment-tokens", { status: 204 });
    await Promise.all([gw.deletePaymentToken("a"), gw.deletePaymentToken("b"), gw.deletePaymentToken("c")]);
    expect(ff.calls.filter((c) => c.path === "/v1/oauth2/token")).toHaveLength(1);
    clock.advance(32400 * 1000 - 59_000);
    await gw.deletePaymentToken("d");
    expect(ff.api().at(-1)!.headers.authorization).toBe("Bearer access-2");
  });

  it("refreshes once on a 401 and retries the call", async () => {
    const { ff, gw } = setup();
    ff.once("DELETE /v3/vault/payment-tokens", { status: 401, body: { error: "invalid_token", error_description: "Token signature verification failed" } });
    ff.on("DELETE /v3/vault/payment-tokens", { status: 204 });
    await gw.deletePaymentToken("abc");
    expect(ff.api().map((c) => c.headers.authorization)).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  it("gives up after a second 401", async () => {
    const { ff, gw } = setup();
    ff.on("DELETE /v3/vault/payment-tokens", { status: 401, body: { error: "invalid_token", error_description: "nope" } });
    const err = await rejection(gw.deletePaymentToken("abc"));
    expect(err.status).toBe(401);
    expect(err.errorName).toBe("invalid_token");
    expect(ff.api()).toHaveLength(2);
  });

  it("surfaces bad credentials as a typed OAuth error", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v1/oauth2/token", { status: 401, body: { error: "invalid_client", error_description: "Client Authentication failed" } });
    const err = await rejection(gw.accessToken());
    expect(err).toMatchObject({ op: "oauth", status: 401, errorName: "invalid_client" });
    expect(err.message).toMatch(/Client Authentication failed/);
  });
});

describe("clientToken", () => {
  it("requests response_type=client_token exactly like the v6 sample, uncached", async () => {
    const { ff, gw } = setup();
    expect(await gw.clientToken()).toBe("client-1");
    expect(await gw.clientToken()).toBe("client-2");
    const c = ff.calls[0]!;
    expect(c.path).toBe("/v1/oauth2/token");
    expect(c.headers.authorization).toBe(`Basic ${btoa("CID:SECRET")}`);
    expect(new URLSearchParams(c.body).get("grant_type")).toBe("client_credentials");
    expect(new URLSearchParams(c.body).get("response_type")).toBe("client_token");
  });

  it("adds domains[] when configured", async () => {
    const { ff, gw } = setup({ domains: ["claim.example", "www.claim.example"] });
    await gw.clientToken();
    expect(new URLSearchParams(ff.calls[0]!.body).getAll("domains[]")).toEqual(["claim.example", "www.claim.example"]);
  });
});

describe("vault: setup and payment tokens", () => {
  const setupReply = {
    status: 201,
    body: {
      id: "4G4976650J0948357",
      customer: { id: "customer_4029352051" },
      status: "PAYER_ACTION_REQUIRED",
      links: [
        { href: `${BASE}/v3/vault/setup-tokens/4G4976650J0948357`, rel: "self", method: "GET" },
        { href: "https://sandbox.paypal.com/agreements/approve?approval_session_id=4G4976650J0948357", rel: "approve", method: "GET" },
      ],
    },
  };

  it("creates a setup token with MERCHANT/CONSUMER usage and the experience URLs", async () => {
    const { ff, gw } = setup({ setupDescription: "Claim Pass: pay after the show", brandName: "Juniper Boutique" });
    ff.on("POST /v3/vault/setup-tokens", setupReply);
    const res = await gw.createSetupToken({ buyerKey: "twitch:111", ...URLS });
    expect(res).toEqual({ setupTokenId: "4G4976650J0948357" });
    const c = ff.api()[0]!;
    expect(c.url).toBe(`${BASE}/v3/vault/setup-tokens`);
    expect(c.headers.authorization).toBe("Bearer access-1");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.headers["paypal-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.json).toEqual({
      customer: { merchant_customer_id: expect.stringMatching(/^twitch\.111-/) },
      payment_source: {
        paypal: {
          description: "Claim Pass: pay after the show",
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          experience_context: {
            brand_name: "Juniper Boutique",
            return_url: URLS.returnUrl,
            cancel_url: URLS.cancelUrl,
            vault_instruction: "ON_PAYER_APPROVAL",
          },
        },
      },
    });
  });

  it("returns the approval link and status from the detailed call", async () => {
    const { ff, gw } = setup({ linkMerchantCustomerId: false });
    ff.on("POST /v3/vault/setup-tokens", setupReply);
    const d = await gw.createSetupTokenDetailed({ buyerKey: "room:ana", ...URLS });
    expect(d).toEqual({
      setupTokenId: "4G4976650J0948357",
      status: "PAYER_ACTION_REQUIRED",
      customerId: "customer_4029352051",
      approveUrl: "https://sandbox.paypal.com/agreements/approve?approval_session_id=4G4976650J0948357",
    });
    expect(ff.api()[0]!.json).not.toHaveProperty("customer");
  });

  it("keeps one PayPal-Request-Id across retries of the same create", async () => {
    const { ff, gw } = setup();
    ff.once("POST /v3/vault/setup-tokens", { status: 503, body: { name: "SERVICE_UNAVAILABLE", message: "down", debug_id: "d1" } });
    ff.on("POST /v3/vault/setup-tokens", setupReply);
    await gw.createSetupToken({ buyerKey: "b", ...URLS });
    const ids = ff.api().map((c) => c.headers["paypal-request-id"]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("exchanges an approved setup token for a vault id", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v3/vault/payment-tokens", { status: 201, body: { id: "jwgvx42", customer: { id: "customer_4029352051" } } });
    expect(await gw.createPaymentToken("4G4976650J0948357")).toEqual({ vaultId: "jwgvx42", customerId: "customer_4029352051" });
    const c = ff.api()[0]!;
    expect(c.json).toEqual({ payment_source: { token: { id: "4G4976650J0948357", type: "SETUP_TOKEN" } } });
    expect(c.headers["paypal-request-id"]).toBeTruthy();
  });

  it("keeps the payer's email from the vault response, for invoices", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v3/vault/payment-tokens", { status: 201, body: { id: "v1", customer: { id: "c1" }, payment_source: { paypal: { email_address: "buyer@example.com" } } } });
    expect(await gw.createPaymentToken("ST1")).toEqual({ vaultId: "v1", customerId: "c1", email: "buyer@example.com" });
  });

  it("throws a typed error when the buyer has not approved", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v3/vault/payment-tokens", issue422("PAYER_ACTION_REQUIRED", "dbg-vault"));
    const err = await rejection(gw.createPaymentToken("ST1"));
    expect(err).toMatchObject({ op: "createPaymentToken", status: 422, errorName: "UNPROCESSABLE_ENTITY", issue: "PAYER_ACTION_REQUIRED", debugId: "dbg-vault" });
  });

  it("reads a setup token's status", async () => {
    const { ff, gw } = setup();
    ff.on("GET /v3/vault/setup-tokens", { status: 200, body: { id: "ST1", status: "APPROVED" } });
    expect(await gw.getSetupToken("ST1")).toEqual({ setupTokenId: "ST1", status: "APPROVED" });
    expect(ff.api()[0]!.path).toBe("/v3/vault/setup-tokens/ST1");
  });

  it("deletes a payment token and treats 404 as already deleted", async () => {
    const { ff, gw } = setup();
    ff.once("DELETE /v3/vault/payment-tokens", { status: 204 });
    ff.once("DELETE /v3/vault/payment-tokens", { status: 404, body: { name: "RESOURCE_NOT_FOUND", message: "gone", debug_id: "x" } });
    await gw.deletePaymentToken("jwgvx42");
    await gw.deletePaymentToken("jwgvx42");
    expect(ff.api().map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /v3/vault/payment-tokens/jwgvx42", "DELETE /v3/vault/payment-tokens/jwgvx42"]);
  });
});

describe("chargeVaulted", () => {
  it("sends one purchase unit with breakdown, physical items, ids and stored_credential", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v2/checkout/orders", { status: 201, body: orderJson(), headers: { "paypal-debug-id": "hdr-debug" } });
    const res = await gw.chargeVaulted("jwgvx42", cart());
    expect(res).toEqual({ orderId: "4TH21426N05692944", captureId: "3B017991HX624902V", status: "COMPLETED", debugId: "hdr-debug" });
    const c = ff.api()[0]!;
    expect(c.headers["paypal-request-id"]).toBe("show-1-twitch:111");
    expect(c.headers.prefer).toBe("return=representation");
    expect(c.headers["paypal-mock-response"]).toBeUndefined();
    expect(c.json).toEqual({
      intent: "CAPTURE",
      purchase_units: [
        {
          invoice_id: "show-1-twitch:111",
          custom_id: "twitch:111",
          amount: {
            currency_code: "USD",
            value: "94.49",
            breakdown: { item_total: { currency_code: "USD", value: "87.99" }, shipping: { currency_code: "USD", value: "6.50" } },
          },
          items: [
            { name: "#12 Linen wrap dress (M / black)", sku: "12-M-BLK", quantity: "2", unit_amount: { currency_code: "USD", value: "34.00" }, category: "PHYSICAL_GOODS" },
            { name: "#7 Silk scarf", sku: "7-OS", quantity: "1", unit_amount: { currency_code: "USD", value: "19.99" }, category: "PHYSICAL_GOODS" },
          ],
        },
      ],
      payment_source: { paypal: { vault_id: "jwgvx42", stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT" } } },
    });
  });

  it("omits stored_credential when the flag is off", async () => {
    const { ff, gw } = setup({ storedCredential: false });
    ff.on("POST /v2/checkout/orders", { status: 201, body: orderJson() });
    await gw.chargeVaulted("jwgvx42", cart());
    expect((ff.api()[0]!.json as { payment_source: unknown }).payment_source).toEqual({ paypal: { vault_id: "jwgvx42" } });
  });

  it("refuses an inconsistent cart before calling PayPal", async () => {
    const { ff, gw } = setup();
    const err = await rejection(gw.chargeVaulted("jwgvx42", cart({ totalCents: 100 })));
    expect(err.errorName).toBe("CLIENT_VALIDATION");
    expect(ff.calls).toHaveLength(0);
    await expect(gw.chargeVaulted("bad id!", cart())).rejects.toThrow(/vault id/);
  });

  it("maps a 422 INSTRUMENT_DECLINED to a DECLINED result with the debug id", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v2/checkout/orders", issue422("INSTRUMENT_DECLINED", "dbg-422"));
    expect(await gw.chargeVaulted("jwgvx42", cart())).toEqual({ status: "DECLINED", declineCode: "INSTRUMENT_DECLINED", debugId: "dbg-422" });
    expect(ff.api()).toHaveLength(1);
  });

  it("maps a 422 PAYER_ACTION_REQUIRED and a PAYER_ACTION_REQUIRED order", async () => {
    const a = setup();
    a.ff.on("POST /v2/checkout/orders", issue422("PAYER_ACTION_REQUIRED"));
    expect(await a.gw.chargeVaulted("v1", cart())).toMatchObject({ status: "PAYER_ACTION_REQUIRED", declineCode: "PAYER_ACTION_REQUIRED" });
    const b = setup();
    b.ff.on("POST /v2/checkout/orders", { status: 201, body: orderJson({ id: "O2", status: "PAYER_ACTION_REQUIRED", capture: null }) });
    expect(await b.gw.chargeVaulted("v1", cart())).toEqual({ orderId: "O2", status: "PAYER_ACTION_REQUIRED" });
  });

  it("reads a DECLINED or PENDING capture inside a COMPLETED order", async () => {
    const a = setup();
    a.ff.on("POST /v2/checkout/orders", { status: 201, body: orderJson({ capture: { id: "C9", status: "DECLINED", reason: "DECLINED_BY_RISK_FRAUD_FILTERS" } }) });
    expect(await a.gw.chargeVaulted("v1", cart())).toMatchObject({ status: "DECLINED", captureId: "C9", declineCode: "DECLINED_BY_RISK_FRAUD_FILTERS" });
    const b = setup();
    b.ff.on("POST /v2/checkout/orders", { status: 201, body: orderJson({ capture: { id: "C8", status: "PENDING", reason: "PENDING_REVIEW" } }) });
    expect(await b.gw.chargeVaulted("v1", cart())).toMatchObject({ status: "PENDING", captureId: "C8" });
  });

  it("throws DUPLICATE_INVOICE_ID instead of reporting a decline", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v2/checkout/orders", issue422("DUPLICATE_INVOICE_ID", "dbg-dup"));
    const err = await rejection(gw.chargeVaulted("v1", cart()));
    expect(err).toMatchObject({ status: 422, issue: "DUPLICATE_INVOICE_ID", debugId: "dbg-dup", op: "chargeVaulted" });
    expect(err.details[0]!.description).toBe("DUPLICATE_INVOICE_ID description");
  });

  it("retries 5xx and network errors with the same PayPal-Request-Id", async () => {
    const { ff, gw } = setup();
    ff.once("POST /v2/checkout/orders", { status: 500, body: { name: "INTERNAL_SERVER_ERROR", message: "boom", debug_id: "d500" } });
    ff.once("POST /v2/checkout/orders", { throws: new TypeError("fetch failed") });
    ff.on("POST /v2/checkout/orders", { status: 200, body: orderJson() });
    const res = await gw.chargeVaulted("v1", cart());
    expect(res.status).toBe("COMPLETED");
    const calls = ff.api();
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.headers["paypal-request-id"]))).toEqual(new Set(["show-1-twitch:111"]));
    expect(new Set(calls.map((c) => c.body)).size).toBe(1);
  });

  it("retries a PREVIOUS_REQUEST_IN_PROGRESS conflict", async () => {
    const { ff, gw } = setup();
    ff.once("POST /v2/checkout/orders", { status: 409, body: { name: "RESOURCE_CONFLICT", details: [{ issue: "PREVIOUS_REQUEST_IN_PROGRESS" }], debug_id: "d409" } });
    ff.on("POST /v2/checkout/orders", { status: 201, body: orderJson() });
    expect((await gw.chargeVaulted("v1", cart())).status).toBe("COMPLETED");
    expect(ff.api()).toHaveLength(2);
  });

  it("does not retry a 400 and stops after the retry budget", async () => {
    const a = setup();
    a.ff.on("POST /v2/checkout/orders", { status: 400, body: { name: "INVALID_REQUEST", details: [{ issue: "INVALID_PARAMETER_VALUE", field: "/purchase_units/0/amount" }], debug_id: "d400" } });
    const e400 = await rejection(a.gw.chargeVaulted("v1", cart()));
    expect(e400).toMatchObject({ status: 400, errorName: "INVALID_REQUEST", issue: "INVALID_PARAMETER_VALUE" });
    expect(a.ff.api()).toHaveLength(1);

    const b = setup({ retries: 2 });
    b.ff.on("POST /v2/checkout/orders", { status: 503, body: { name: "SERVICE_UNAVAILABLE", debug_id: "d503" } });
    const e503 = await rejection(b.gw.chargeVaulted("v1", cart()));
    expect(e503.status).toBe(503);
    expect(b.ff.api()).toHaveLength(3);
  });

  it("reports a timeout as a typed network error", async () => {
    const { ff, gw } = setup({ retries: 0 });
    ff.on("POST /v2/checkout/orders", { throws: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) });
    const err = await rejection(gw.chargeVaulted("v1", cart()));
    expect(err).toMatchObject({ status: 0, errorName: "TIMEOUT", op: "chargeVaulted" });
  });
});

describe("negative testing header", () => {
  it("a function picks the call and sets PayPal-Mock-Response", async () => {
    const { ff, gw } = setup({ mockResponse: (c) => (c.op === "chargeVaulted" && c.vaultId === "declineme" ? "INSTRUMENT_DECLINED" : undefined) });
    ff.on("POST /v2/checkout/orders", (call) => (call.headers["paypal-mock-response"] ? issue422("INSTRUMENT_DECLINED") : { status: 201, body: orderJson() }));
    expect((await gw.chargeVaulted("declineme", cart())).status).toBe("DECLINED");
    expect((await gw.chargeVaulted("okay", cart({ requestId: "r2", invoiceId: "i2" }))).status).toBe("COMPLETED");
    expect(ff.api()[0]!.headers["paypal-mock-response"]).toBe('{"mock_application_codes":"INSTRUMENT_DECLINED"}');
    expect(ff.api()[1]!.headers["paypal-mock-response"]).toBeUndefined();
  });

  it("a string applies to orders/payments calls only, and full JSON passes through", async () => {
    const { ff, gw } = setup({ mockResponse: '{"mock_application_codes":"TRANSACTION_REFUSED"}' });
    ff.on("POST /v2/checkout/orders", { status: 201, body: orderJson() });
    ff.on("POST /v3/vault/payment-tokens", { status: 201, body: { id: "v", customer: { id: "c" } } });
    await gw.chargeVaulted("v1", cart());
    await gw.createPaymentToken("ST");
    const [order, vault] = ff.api();
    expect(order!.headers["paypal-mock-response"]).toBe('{"mock_application_codes":"TRANSACTION_REFUSED"}');
    expect(vault!.headers["paypal-mock-response"]).toBeUndefined();
  });
});

describe("pay-now", () => {
  const created = {
    status: 200,
    body: {
      id: "5O190127TN364715T",
      status: "PAYER_ACTION_REQUIRED",
      links: [
        { href: `${BASE}/v2/checkout/orders/5O190127TN364715T`, rel: "self", method: "GET" },
        { href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T", rel: "payer-action", method: "GET" },
      ],
    },
  };

  it("creates a CAPTURE order with PAY_NOW experience URLs and its own request id", async () => {
    const { ff, gw } = setup({ brandName: "Juniper" });
    ff.on("POST /v2/checkout/orders", created);
    expect(await gw.createPayNowOrder(cart(), URLS)).toEqual({
      orderId: "5O190127TN364715T",
      approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
    });
    const c = ff.api()[0]!;
    expect(c.headers["paypal-request-id"]).toBe("show-1-twitch:111-paynow");
    const body = c.json as { intent: string; payment_source: unknown; purchase_units: { invoice_id: string }[] };
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0]!.invoice_id).toBe("show-1-twitch:111");
    expect(body.payment_source).toEqual({
      paypal: {
        experience_context: {
          brand_name: "Juniper",
          shipping_preference: "GET_FROM_FILE",
          user_action: "PAY_NOW",
          return_url: URLS.returnUrl,
          cancel_url: URLS.cancelUrl,
        },
      },
    });
  });

  it("falls back to the approve link and fails loudly without one", async () => {
    const a = setup();
    a.ff.on("POST /v2/checkout/orders", { status: 201, body: { id: "O1", links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=O1", rel: "approve" }] } });
    expect((await a.gw.createPayNowOrder(cart(), URLS)).approveUrl).toBe("https://www.sandbox.paypal.com/checkoutnow?token=O1");
    const b = setup();
    b.ff.on("POST /v2/checkout/orders", { status: 201, body: { id: "O1", links: [] } });
    expect((await rejection(b.gw.createPayNowOrder(cart(), URLS))).errorName).toBe("UNEXPECTED_RESPONSE");
  });

  it("captures with a request id and parses the outcome", async () => {
    const { ff, gw } = setup();
    ff.once("POST /v2/checkout/orders/5O190127TN364715T/capture", { status: 201, body: orderJson({ id: "5O190127TN364715T" }) });
    expect(await gw.captureOrder("5O190127TN364715T")).toMatchObject({ orderId: "5O190127TN364715T", captureId: "3B017991HX624902V", status: "COMPLETED" });
    const c = ff.api()[0]!;
    expect(c.method).toBe("POST");
    expect(c.headers["paypal-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.headers.prefer).toBe("return=representation");
    expect(c.body).toBeUndefined();
  });

  it("maps capture declines and unapproved orders, keeping the order id", async () => {
    const { ff, gw } = setup();
    ff.once("POST /v2/checkout/orders/O1/capture", issue422("INSTRUMENT_DECLINED", "dcap"));
    ff.once("POST /v2/checkout/orders/O1/capture", issue422("ORDER_NOT_APPROVED"));
    expect(await gw.captureOrder("O1")).toEqual({ orderId: "O1", status: "DECLINED", declineCode: "INSTRUMENT_DECLINED", debugId: "dcap" });
    expect(await gw.captureOrder("O1")).toMatchObject({ orderId: "O1", status: "PAYER_ACTION_REQUIRED", declineCode: "ORDER_NOT_APPROVED" });
  });

  it("throws ORDER_ALREADY_CAPTURED rather than reporting a decline", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v2/checkout/orders/O1/capture", issue422("ORDER_ALREADY_CAPTURED"));
    expect((await rejection(gw.captureOrder("O1"))).issue).toBe("ORDER_ALREADY_CAPTURED");
  });
});

describe("refunds and tracking", () => {
  it("refunds an amount with a note and a stable request id across retries", async () => {
    const { ff, gw } = setup();
    ff.once("POST /v2/payments/captures/3B017991HX624902V/refund", { status: 502, body: "bad gateway" });
    ff.on("POST /v2/payments/captures/3B017991HX624902V/refund", { status: 201, body: { id: "1JU08902781691411", status: "COMPLETED" } });
    expect(await gw.refundCapture("3B017991HX624902V", 3400, "Sold out after you claimed it")).toEqual({ refundId: "1JU08902781691411", status: "COMPLETED" });
    const calls = ff.api();
    expect(calls[1]!.json).toEqual({ amount: { currency_code: "USD", value: "34.00" }, note_to_payer: "Sold out after you claimed it" });
    expect(calls[0]!.headers["paypal-request-id"]).toBe(calls[1]!.headers["paypal-request-id"]);
  });

  it("each refund call gets its own request id", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v2/payments/captures/C1/refund", { status: 201, body: { id: "R", status: "PENDING" } });
    await gw.refundCapture("C1", 100);
    await gw.refundCapture("C1", 100);
    const [a, b] = ff.api();
    expect(a!.headers["paypal-request-id"]).not.toBe(b!.headers["paypal-request-id"]);
    expect(a!.json).toEqual({ amount: { currency_code: "USD", value: "1.00" } });
    await expect(gw.refundCapture("C1", 0)).rejects.toThrow(/positive/);
  });

  it("adds tracking with notify_payer and returns the tracker id", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v2/checkout/orders/O1/track", {
      status: 201,
      body: { id: "O1", purchase_units: [{ shipping: { trackers: [{ id: "C1-9400111899223" }] } }] },
    });
    const res = await gw.addTracking({ orderId: "O1", captureId: "C1", trackingNumber: "9400111899223", carrier: "USPS", notifyPayer: true });
    expect(res).toEqual({ trackerId: "C1-9400111899223" });
    expect(ff.api()[0]!.json).toEqual({ capture_id: "C1", tracking_number: "9400111899223", carrier: "USPS", notify_payer: true });
  });

  it("falls back to the documented tracker id format", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v2/checkout/orders/O1/track", { status: 200, body: { id: "O1" } });
    expect((await gw.addTracking({ orderId: "O1", captureId: "C1", trackingNumber: "T1", carrier: "UPS", notifyPayer: false })).trackerId).toBe("C1-T1");
  });
});

describe("verifyWebhook", () => {
  const raw = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"currency_code":"USD","value":"1.00"}} }';
  const headers = {
    "Paypal-Auth-Algo": "SHA256withRSA",
    "Paypal-Cert-Url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270",
    "Paypal-Transmission-Id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
    "Paypal-Transmission-Sig": "lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==",
    "Paypal-Transmission-Time": "2026-10-05T10:00:00Z",
  };

  it("posts the headers, webhook id and the raw event verbatim", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v1/notifications/verify-webhook-signature", { status: 200, body: { verification_status: "SUCCESS" } });
    expect(await gw.verifyWebhook(headers, raw)).toBe(true);
    const c = ff.api()[0]!;
    expect(c.body).toContain(`"webhook_event":${raw.trim()}}`);
    expect(c.json).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: headers["Paypal-Cert-Url"],
      transmission_id: headers["Paypal-Transmission-Id"],
      transmission_sig: headers["Paypal-Transmission-Sig"],
      transmission_time: "2026-10-05T10:00:00Z",
      webhook_id: "WH-123",
      webhook_event: JSON.parse(raw),
    });
  });

  it("returns false on FAILURE, on a 400, and for malformed deliveries without calling PayPal", async () => {
    const { ff, gw } = setup();
    ff.once("POST /v1/notifications/verify-webhook-signature", { status: 200, body: { verification_status: "FAILURE" } });
    ff.once("POST /v1/notifications/verify-webhook-signature", { status: 400, body: { name: "VALIDATION_ERROR", debug_id: "d" } });
    expect(await gw.verifyWebhook(headers, raw)).toBe(false);
    expect(await gw.verifyWebhook(headers, raw)).toBe(false);
    expect(await gw.verifyWebhook({ ...headers, "Paypal-Transmission-Sig": undefined }, raw)).toBe(false);
    expect(await gw.verifyWebhook(headers, "garbage")).toBe(false);
    expect(ff.api()).toHaveLength(2);
  });

  it("throws on outages and when no webhook id is configured", async () => {
    const a = setup({ retries: 0 });
    a.ff.on("POST /v1/notifications/verify-webhook-signature", { status: 500, body: { name: "INTERNAL_SERVER_ERROR", debug_id: "d" } });
    await expect(a.gw.verifyWebhook(headers, raw)).rejects.toThrow(PayPalError);
    const b = setup({ webhookId: undefined as unknown as string });
    await expect(b.gw.verifyWebhook(headers, raw)).rejects.toThrow(/webhookId/);
  });
});

describe("webhook management extras", () => {
  it("lists and registers webhooks", async () => {
    const { ff, gw } = setup();
    ff.on("GET /v1/notifications/webhooks", { status: 200, body: { webhooks: [{ id: "WH1", url: "https://x.example/pp", event_types: [{ name: "PAYMENT.CAPTURE.COMPLETED" }] }] } });
    ff.on("POST /v1/notifications/webhooks", { status: 201, body: { id: "WH2" } });
    expect(await gw.listWebhooks()).toEqual([{ id: "WH1", url: "https://x.example/pp", events: ["PAYMENT.CAPTURE.COMPLETED"] }]);
    expect(await gw.registerWebhook("https://claim.example/api/paypal/webhook")).toEqual({ id: "WH2" });
    const reg = ff.api()[1]!.json as { url: string; event_types: { name: string }[] };
    expect(reg.url).toBe("https://claim.example/api/paypal/webhook");
    expect(reg.event_types.map((e) => e.name)).toContain("VAULT.PAYMENT-TOKEN.CREATED");
  });

  it("never retries the non-idempotent webhook registration", async () => {
    const { ff, gw } = setup();
    ff.on("POST /v1/notifications/webhooks", { status: 503, body: { name: "SERVICE_UNAVAILABLE", debug_id: "d" } });
    await expect(gw.registerWebhook("https://claim.example/hook")).rejects.toThrow(PayPalError);
    expect(ff.api()).toHaveLength(1);
  });
});
