import type { Bill, CloserLedger, InvoiceRecord } from "../types.js";

export const T0 = Date.UTC(2026, 9, 31, 18, 0, 0);

export function bill(over: Partial<Bill> & Pick<Bill, "ref" | "buyer" | "state">): Bill {
  const buyerKey = over.buyerKey ?? `simulator:${over.buyer}`;
  return {
    key: over.cartId ? `cart:${over.cartId}` : `holds:${buyerKey}`,
    buyerKey,
    claimPass: false,
    lines: [{ name: "#14 Blue dress · M", qty: 1, unitCents: 3500 }],
    shippingCents: 700,
    amountCents: 4200,
    ...over,
  };
}

export function invoice(b: Bill, over: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    invoiceId: "INV2-AAAA-1111",
    proposalId: "show-x-cl1",
    billKey: b.key,
    buyerKey: b.buyerKey,
    buyer: b.buyer,
    email: b.email ?? "x@buyers.example.com",
    amountCents: b.amountCents,
    shippingCents: b.shippingCents,
    status: "SENT",
    sentAt: T0 - 5 * 60_000,
    reminders: 0,
    ...over,
  };
}

/**
 * The race + bundle close-out: ava and nora on a Claim Pass with carts due, dana back on a hold after
 * her pass declined, hal a pay-now buyer with no email, and cleo paid.
 */
export function ledger(over: Partial<CloserLedger> = {}): CloserLedger {
  const bills: Bill[] = [
    bill({ ref: "c1", buyer: "ava", state: "due", cartId: "show-x-simulator:ava", chargeMode: "vault", claimPass: true, capRemainingCents: 50_000, email: "ava@buyers.example.com" }),
    bill({ ref: "c2", buyer: "dana", state: "unpaid", unitIds: ["u2"], email: "dana@buyers.example.com", declineCode: "INSTRUMENT_DECLINED", holdUntil: T0 + 15 * 60_000 }),
    bill({
      ref: "c3",
      buyer: "nora",
      state: "due",
      cartId: "show-x-simulator:nora",
      chargeMode: "vault",
      claimPass: true,
      email: "nora@buyers.example.com",
      lines: [
        { name: "#14 Blue dress · M", qty: 1, unitCents: 3500 },
        { name: "#15 Cream cardigan · S", qty: 1, unitCents: 4800 },
        { name: "#16 Wool scarf", qty: 1, unitCents: 2800 },
      ],
      shippingCents: 0,
      amountCents: 11_100,
    }),
    bill({ ref: "c4", buyer: "hal", state: "unpaid", unitIds: ["u4"], amountCents: 5600, holdUntil: T0 + 5 * 60_000 }),
    bill({ ref: "c5", buyer: "cleo", state: "paid", cartId: "show-x-simulator:cleo", chargeMode: "vault", claimPass: true, email: "cleo@buyers.example.com", captureId: "CAP123456789012345", paidVia: "vault", refundedCents: 0 }),
  ];
  return {
    showId: "show-x",
    shopName: "Juniper & Thread",
    currency: "USD",
    now: T0,
    bills,
    invoices: bills.flatMap((b) => (b.invoice ? [b.invoice] : [])),
    open: [],
    carriers: ["USPS", "UPS", "FEDEX", "DHL"],
    reminderGapMs: 60_000,
    ...over,
  };
}

/** Puts an invoice on a bill and on the ledger's list. */
export function withInvoice(l: CloserLedger, ref: string, over: Partial<InvoiceRecord> = {}): CloserLedger {
  const bills = l.bills.map((b) => (b.ref === ref ? { ...b, invoice: invoice(b, over) } : b));
  return { ...l, bills, invoices: bills.flatMap((b) => (b.invoice ? [b.invoice] : [])) };
}
