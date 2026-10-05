import type { CartChargeInput } from "@claim/core";

export function cart(over: Partial<CartChargeInput> = {}): CartChargeInput {
  return {
    invoiceId: "show-1-twitch:111",
    requestId: "show-1-twitch:111",
    currency: "USD",
    lines: [
      { name: "#12 Linen wrap dress (M / black)", sku: "12-M-BLK", qty: 2, unitCents: 3400 },
      { name: "#7 Silk scarf", sku: "7-OS", qty: 1, unitCents: 1999 },
    ],
    shippingCents: 650,
    totalCents: 3400 * 2 + 1999 + 650,
    customId: "twitch:111",
    ...over,
  };
}

export const URLS = { returnUrl: "https://claim.example/pay/return", cancelUrl: "https://claim.example/pay/cancel" };
