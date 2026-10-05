import type { ShipTo } from "@claim/core";
import { describe, expect, it } from "vitest";
import { paypalShipping, purchaseUnit, validateCart, vaultOrderBody } from "../bodies.js";
import { createMockGateway, mockShipTo } from "../mock.js";
import { chargeFromOrder, shipToFrom } from "../parse.js";
import { createSandboxGateway } from "../sandbox.js";
import { URLS, cart } from "./fixtures.js";
import { findOperation, loadSpec, requestSchema, validate } from "./openapi.js";

const HOME: ShipTo = { name: "Jess Lee", line1: "1 Main St", city: "San Jose", state: "CA", postalCode: "95131", countryCode: "US" };

const TOKEN_SHIPPING = {
  name: { full_name: "Jess Lee" },
  address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
};

describe("shipToFrom", () => {
  it("reads PayPal's shipping_detail into a ShipTo", () => {
    expect(shipToFrom(TOKEN_SHIPPING)).toEqual(HOME);
  });

  it("needs a street line and a country, since a label is useless without them", () => {
    expect(shipToFrom(undefined)).toBeUndefined();
    expect(shipToFrom({ name: { full_name: "Jess" } })).toBeUndefined();
    expect(shipToFrom({ address: { address_line_1: "1 Main St" } })).toBeUndefined();
    expect(shipToFrom({ address: { address_line_1: "   ", country_code: "US" } })).toBeUndefined();
  });

  it("trims, upper-cases the country and drops blank optional fields", () => {
    expect(shipToFrom({ address: { address_line_1: " 9 Elm Rd ", address_line_2: " ", admin_area_2: "", country_code: "gb" } })).toEqual({
      line1: "9 Elm Rd",
      countryCode: "GB",
    });
  });
});

describe("order bodies with a ship-to address", () => {
  it("maps a ShipTo onto Orders v2 shipping and back without loss", () => {
    const sent = paypalShipping({ ...HOME, line2: "Apt 4" });
    expect(sent).toEqual({
      name: { full_name: "Jess Lee" },
      address: { address_line_1: "1 Main St", address_line_2: "Apt 4", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
    });
    expect(shipToFrom(sent)).toEqual({ ...HOME, line2: "Apt 4" });
  });

  it("cuts fields to the spec's maximum lengths", () => {
    const s = paypalShipping({ line1: "x".repeat(400), city: "c".repeat(200), postalCode: "9".repeat(80), countryCode: "US" });
    expect(s.address.address_line_1).toHaveLength(300);
    expect(s.address).toMatchObject({ admin_area_2: "c".repeat(120), postal_code: "9".repeat(60) });
    expect(s).not.toHaveProperty("name");
  });

  it("adds shipping to the purchase unit only when the cart has an address", () => {
    expect(purchaseUnit(cart())).not.toHaveProperty("shipping");
    expect(purchaseUnit(cart({ shipTo: HOME })).shipping).toEqual(paypalShipping(HOME));
  });

  it("refuses an address PayPal would reject", () => {
    expect(() => validateCart(cart({ shipTo: { ...HOME, countryCode: "usa" } }))).toThrow(/countryCode/);
    expect(() => validateCart(cart({ shipTo: { ...HOME, line1: " " } }))).toThrow(/line1/);
  });

  const orders = loadSpec("checkout_orders_v2.json");
  it.skipIf(!orders)("a vault order with an address matches the Orders v2 create schema", () => {
    const found = findOperation(orders!, "POST", "/v2/checkout/orders")!;
    const body = vaultOrderBody("8kk8451t", cart({ shipTo: { ...HOME, line2: "Apt 4" } }), { storedCredential: true });
    expect(validate(orders!, requestSchema(found.op)!, body)).toEqual([]);
  });
});

describe("charge results carry the order's address", () => {
  it("reads purchase_units[0].shipping on a completed capture", () => {
    const r = chargeFromOrder({
      id: "O1",
      status: "COMPLETED",
      purchase_units: [{ shipping: TOKEN_SHIPPING, payments: { captures: [{ id: "C1", status: "COMPLETED" }] } }],
    });
    expect(r).toEqual({ orderId: "O1", captureId: "C1", status: "COMPLETED", shipTo: HOME });
  });

  it("leaves shipTo off when the order has no address", () => {
    const r = chargeFromOrder({ id: "O1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "C1", status: "COMPLETED" }] } }] });
    expect(r).not.toHaveProperty("shipTo");
  });
});

describe("mock gateway addresses", () => {
  async function savedPass(buyerKey: string) {
    const gw = createMockGateway({ autoApprove: true });
    const { setupTokenId } = await gw.createSetupToken({ buyerKey, ...URLS });
    const { vaultId } = await gw.createPaymentToken(setupTokenId);
    return { gw, vaultId };
  }

  it("gives a saved wallet a stable address named after the buyer", async () => {
    const { gw, vaultId } = await savedPass("room:jess-l");
    const a = await gw.walletShipTo(vaultId);
    expect(a).toEqual(mockShipTo("room:jess-l"));
    expect(a).toMatchObject({ name: "Jess L", city: "San Jose", countryCode: "US" });
    expect(await gw.walletShipTo(vaultId)).toEqual(a);
    expect(mockShipTo("room:maya").line1).not.toBe(mockShipTo("room:jess-l").line1);
    expect(mockShipTo("room:jess-5vsg8").name).toBe("Jess");
    expect(mockShipTo("twitch:aunt_carol").name).toBe("Aunt Carol");
    expect(mockShipTo("").name).toBe("Buyer");
  });

  it("has no address for an unknown or deleted wallet", async () => {
    const { gw, vaultId } = await savedPass("room:jess");
    expect(await gw.walletShipTo("nope")).toBeUndefined();
    await gw.deletePaymentToken(vaultId);
    expect(await gw.walletShipTo(vaultId)).toBeUndefined();
  });

  it("echoes the address it was sent on a vault charge, and none when none was sent", async () => {
    const { gw, vaultId } = await savedPass("room:jess");
    expect((await gw.chargeVaulted(vaultId, cart({ shipTo: HOME }))).shipTo).toEqual(HOME);
    expect(await gw.chargeVaulted(vaultId, cart({ invoiceId: "INV-2", requestId: "req-2" }))).not.toHaveProperty("shipTo");
  });

  it("returns the buyer's address on a captured pay-now order, as GET_FROM_FILE does", async () => {
    const gw = createMockGateway({ autoApprove: true });
    const { orderId } = await gw.createPayNowOrder(cart({ customId: "room:maya" }), URLS);
    expect((await gw.captureOrder(orderId)).shipTo).toEqual(mockShipTo("room:maya"));
  });
});

describe("sandbox walletShipTo", () => {
  function gateway(token: (path: string) => Response) {
    const calls: string[] = [];
    const gw = createSandboxGateway({
      clientId: "id",
      clientSecret: "secret",
      retries: 0,
      sleep: async () => {},
      fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path === "/v1/oauth2/token") return Response.json({ access_token: "A", expires_in: 3600, token_type: "Bearer" });
        return token(path);
      },
    });
    return { gw, calls };
  }

  it("reads payment_source.paypal.shipping off the saved payment token", async () => {
    const { gw, calls } = gateway(() => Response.json({ id: "8kk8451t", payment_source: { paypal: { shipping: TOKEN_SHIPPING } } }));
    expect(await gw.walletShipTo("8kk8451t")).toEqual(HOME);
    expect(calls).toContain("/v3/vault/payment-tokens/8kk8451t");
  });

  it("never throws: a missing token or an outage means no address, not a failed charge", async () => {
    const gone = gateway(() => Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 }));
    expect(await gone.gw.walletShipTo("8kk8451t")).toBeUndefined();
    const down = gateway(() => new Response("", { status: 503 }));
    expect(await down.gw.walletShipTo("8kk8451t")).toBeUndefined();
    const bare = gateway(() => Response.json({ id: "8kk8451t", payment_source: { paypal: {} } }));
    expect(await bare.gw.walletShipTo("8kk8451t")).toBeUndefined();
  });

  it("encodes the vault id into the path", async () => {
    const { gw, calls } = gateway(() => Response.json({}));
    await gw.walletShipTo("a/b");
    expect(calls).toContain("/v3/vault/payment-tokens/a%2Fb");
  });
});
