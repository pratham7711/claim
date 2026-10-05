import { describe, expect, it } from "vitest";
import { createGateway } from "../env.js";
import { fakeFetch, orderJson } from "./fake-fetch.js";
import { cart } from "./fixtures.js";

describe("createGateway", () => {
  it("falls back to the mock without credentials", () => {
    expect(createGateway({}).mode).toBe("mock");
    expect(createGateway({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: " " }).mode).toBe("mock");
  });

  it("uses the sandbox when both credentials are set, unless forced to mock", () => {
    expect(createGateway({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s" }).mode).toBe("sandbox");
    expect(createGateway({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s", PAYPAL_GATEWAY: "mock" }).mode).toBe("mock");
  });

  it("passes the webhook id and the stored_credential switch through", async () => {
    const ff = fakeFetch();
    ff.on("POST /v2/checkout/orders", { status: 201, body: orderJson() });
    ff.on("POST /v1/notifications/verify-webhook-signature", { status: 200, body: { verification_status: "SUCCESS" } });
    const gw = createGateway(
      { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s", PAYPAL_WEBHOOK_ID: "WH9", PAYPAL_STORED_CREDENTIAL: "false" },
      { fetchImpl: ff.fetchImpl },
    );
    await gw.chargeVaulted("v1", cart());
    expect((ff.api()[0]!.json as { payment_source: unknown }).payment_source).toEqual({ paypal: { vault_id: "v1" } });
    const headers = {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/C",
      "paypal-transmission-id": "t1",
      "paypal-transmission-sig": "s1",
      "paypal-transmission-time": "2026-10-05T10:00:00Z",
    };
    expect(await gw.verifyWebhook(headers, "{}")).toBe(true);
    expect((ff.api()[1]!.json as { webhook_id: string }).webhook_id).toBe("WH9");
  });

  it("refuses a non-sandbox PAYPAL_BASE_URL", () => {
    expect(() => createGateway({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s", PAYPAL_BASE_URL: "https://api-m.paypal.com" })).toThrow(/non-sandbox/);
  });

  it("forwards mock options", async () => {
    const gw = createGateway({}, { mock: { declineBuyerKeys: ["b1"] } });
    const { setupTokenId } = await gw.createSetupToken({ buyerKey: "b1", returnUrl: "https://x/r", cancelUrl: "https://x/c" });
    const { vaultId } = await gw.createPaymentToken(setupTokenId);
    expect((await gw.chargeVaulted(vaultId, cart())).status).toBe("DECLINED");
  });
});
