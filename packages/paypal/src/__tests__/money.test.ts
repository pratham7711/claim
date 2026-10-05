import { describe, expect, it } from "vitest";
import type { Cart } from "@claim/core";
import { PayPalError } from "../errors.js";
import { toCents, toValue } from "../money.js";
import { merchantCustomerId, toChargeInput, trackerBody, validateCart, verifyWebhookBody } from "../bodies.js";
import { cart } from "./fixtures.js";

describe("money", () => {
  it("formats integer cents without float math", () => {
    expect(toValue(0)).toBe("0.00");
    expect(toValue(5)).toBe("0.05");
    expect(toValue(99)).toBe("0.99");
    expect(toValue(1999)).toBe("19.99");
    expect(toValue(100000)).toBe("1000.00");
    expect(toValue(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91");
    expect(toValue(1234, "JPY")).toBe("1234");
  });

  it("refuses fractional, negative and unsafe amounts", () => {
    for (const bad of [0.1, -1, 19.99, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => toValue(bad)).toThrow(PayPalError);
    }
  });

  it("parses PayPal decimal strings back to cents", () => {
    expect(toCents("19.99")).toBe(1999);
    expect(toCents("19.9")).toBe(1990);
    expect(toCents("19")).toBe(1900);
    expect(toCents("0.07")).toBe(7);
    expect(toCents("1234", "JPY")).toBe(1234);
    expect(() => toCents("1.234")).toThrow(/decimals/);
    expect(() => toCents("-1.00")).toThrow(PayPalError);
    expect(() => toCents("1e3")).toThrow(PayPalError);
    expect(() => toCents("12.5", "JPY")).toThrow(PayPalError);
  });

  it("round-trips every cent value in a range", () => {
    for (let c = 0; c < 2000; c++) expect(toCents(toValue(c))).toBe(c);
  });
});

describe("cart validation", () => {
  it("accepts a consistent cart", () => {
    expect(() => validateCart(cart())).not.toThrow();
  });

  it.each([
    ["total mismatch", { totalCents: 1 }],
    ["fractional unit", { lines: [{ name: "x", sku: "x", qty: 1, unitCents: 10.5 }], shippingCents: 0, totalCents: 10.5 }],
    ["zero qty", { lines: [{ name: "x", sku: "x", qty: 0, unitCents: 100 }], shippingCents: 0, totalCents: 0 }],
    ["no lines", { lines: [], shippingCents: 0, totalCents: 0 }],
    ["empty request id", { requestId: "" }],
    ["long invoice id", { invoiceId: "x".repeat(128) }],
    ["empty name", { lines: [{ name: " ", sku: "x", qty: 1, unitCents: 100 }], shippingCents: 0, totalCents: 100 }],
  ])("refuses %s", (_label, over) => {
    const err = (() => {
      try {
        validateCart(cart(over));
      } catch (e) {
        return e as PayPalError;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(PayPalError);
    expect(err?.errorName).toBe("CLIENT_VALIDATION");
    expect(err?.status).toBe(0);
  });
});

describe("toChargeInput", () => {
  const engineCart = (over: Partial<Cart> = {}): Cart => ({
    cartId: "show-1-twitch:111",
    showId: "show-1",
    buyerKey: "twitch:111",
    displayName: "Ana",
    seq: 1,
    invoiceId: "show-1-twitch:111",
    requestId: "show-1-twitch:111",
    chargeMode: "vault",
    lines: [
      { itemCode: "12", sku: "12-M-BLK", title: "Linen wrap dress", size: "M", color: "black", qty: 3, unitCents: 3400, lineCents: 10200, paidCents: 3400, unitIds: ["u1", "u2", "u3"] },
      { itemCode: "7", sku: "7-OS", title: "Silk scarf", qty: 1, unitCents: 1999, lineCents: 1999, paidCents: 1999, unitIds: ["u4"] },
    ],
    units: 4,
    subtotalCents: 12199,
    shippingCents: 900,
    totalCents: 13099,
    paidCents: 5399,
    dueCents: 7700,
    flags: [],
    status: "pending",
    createdAt: 0,
    ...over,
  });

  it("bills only unpaid units plus shipping, so the total is dueCents", () => {
    const input = toChargeInput(engineCart());
    expect(input.lines).toEqual([{ name: "#12 Linen wrap dress (M / black)", sku: "12-M-BLK", qty: 2, unitCents: 3400 }]);
    expect(input.totalCents).toBe(7700);
    expect(input.shippingCents).toBe(900);
    expect(input.invoiceId).toBe("show-1-twitch:111");
    expect(input.requestId).toBe("show-1-twitch:111");
    expect(input.customId).toBe("twitch:111");
    expect(() => validateCart(input)).not.toThrow();
  });

  it("refuses a cart whose due amount does not reconcile", () => {
    expect(() => toChargeInput(engineCart({ dueCents: 7701 }))).toThrow(/due/);
  });
});

describe("small builders", () => {
  it("derives a spec-valid merchant_customer_id from a buyer key", () => {
    expect(merchantCustomerId("room_ana")).toBe("room_ana");
    const id = merchantCustomerId("twitch:12345");
    expect(id).toMatch(/^[0-9a-zA-Z\-_.^*$@#]{1,64}$/);
    expect(id).not.toBe(merchantCustomerId("twitch.12345"));
    expect(merchantCustomerId("youtube:" + "x".repeat(100)).length).toBeLessThanOrEqual(64);
  });

  it("maps carriers onto the PayPal enum or OTHER", () => {
    expect(trackerBody({ captureId: "C1", trackingNumber: "9400", carrier: "usps", notifyPayer: true })).toEqual({
      capture_id: "C1",
      tracking_number: "9400",
      carrier: "USPS",
      notify_payer: true,
    });
    expect(trackerBody({ captureId: "C1", trackingNumber: "9400", carrier: "Royal Mail Tracked", notifyPayer: false })).toMatchObject({
      carrier: "OTHER",
      carrier_name_other: "Royal Mail Tracked",
    });
  });

  it("refuses webhook deliveries that cannot be genuine before any network call", () => {
    const headers = {
      "PAYPAL-AUTH-ALGO": "SHA256withRSA",
      "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      "PAYPAL-TRANSMISSION-ID": "abc-1",
      "PAYPAL-TRANSMISSION-SIG": "sig==",
      "PAYPAL-TRANSMISSION-TIME": "2026-10-05T10:00:00Z",
    };
    expect(verifyWebhookBody(headers, "{}", "WH1")).toBeDefined();
    expect(verifyWebhookBody({ ...headers, "PAYPAL-TRANSMISSION-SIG": undefined }, "{}", "WH1")).toBeUndefined();
    expect(verifyWebhookBody(headers, "not json", "WH1")).toBeUndefined();
    expect(verifyWebhookBody(headers, "[1]", "WH1")).toBeUndefined();
    expect(verifyWebhookBody(headers, '{"a":1}, "x": 2', "WH1")).toBeUndefined();
  });
});
