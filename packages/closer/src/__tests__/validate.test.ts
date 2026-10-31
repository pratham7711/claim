import { describe, expect, it } from "vitest";
import { parseUsd, usd } from "../format.js";
import { owesAnswer, readInstruction, rulePlan } from "../rules.js";
import { summarize } from "../summary.js";
import { validateDraft } from "../validate.js";
import type { Proposal } from "../types.js";
import { ledger, T0, withInvoice } from "./fixtures.js";

const reason = (v: ReturnType<typeof validateDraft>) => (v.ok ? "ok" : v.reason);

describe("amounts", () => {
  it("parses dollars to the cent and refuses what it cannot read exactly", () => {
    expect(parseUsd("5")).toEqual({ ok: true, cents: 500 });
    expect(parseUsd("$5.5")).toEqual({ ok: true, cents: 550 });
    expect(parseUsd(12.34)).toEqual({ ok: true, cents: 1234 });
    expect(parseUsd("5.00 USD")).toEqual({ ok: true, cents: 500 });
    expect(parseUsd("5.005").ok).toBe(false);
    expect(parseUsd("-5").ok).toBe(false);
    expect(parseUsd("five").ok).toBe(false);
    expect(parseUsd(undefined).ok).toBe(false);
    expect([usd(4200), usd(550), usd(5)]).toEqual(["$42", "$5.50", "$0.05"]);
  });
});

describe("validateDraft", () => {
  it("charges a Claim Pass cart that is due and fits the cap, with the amount from the ledger", () => {
    const v = validateDraft({ kind: "charge", ref: "c1", why: "pass on file" }, ledger());
    expect(v).toEqual({
      ok: true,
      proposal: expect.objectContaining({ kind: "charge", buyer: "ava", amountCents: 4200, cartId: "show-x-simulator:ava", call: "orders.create (vault)", why: "pass on file" }),
    });
  });

  it("refuses a charge with no cart, no pass, over the cap, already paid, or a wrong amount", () => {
    const l = ledger();
    expect(reason(validateDraft({ kind: "charge", ref: "c2" }, l))).toMatch(/dana has no cart to charge.*INSTRUMENT_DECLINED/);
    expect(reason(validateDraft({ kind: "charge", ref: "c5" }, l))).toMatch(/already paid/);
    const capped = { ...l, bills: l.bills.map((b) => (b.ref === "c3" ? { ...b, capRemainingCents: 10_000 } : b)) };
    expect(reason(validateDraft({ kind: "charge", ref: "c3" }, capped))).toMatch(/\$111 is over nora's Claim Pass cap \(\$100 left\)/);
    const noPass = { ...l, bills: l.bills.map((b) => (b.ref === "c1" ? { ...b, claimPass: false } : b)) };
    expect(reason(validateDraft({ kind: "charge", ref: "c1" }, noPass))).toMatch(/no live Claim Pass/);
    expect(reason(validateDraft({ kind: "charge", ref: "c1", amount: "40" }, l))).toMatch(/\$40 does not match the ledger: ava owes \$42/);
    expect(reason(validateDraft({ kind: "charge", ref: "c9" }, l))).toMatch(/no bill "c9"/);
  });

  it("invoices an owed bill with an email, and turns away one without", () => {
    const l = ledger();
    const v = validateDraft({ kind: "invoice", ref: "dana", note: "  Thanks   for shopping. " }, l);
    expect(v.ok && v.proposal).toMatchObject({ kind: "invoice", buyer: "dana", amountCents: 4200, note: "Thanks for shopping.", unitIds: ["u2"], call: "create_invoice → send_invoice" });
    expect(reason(validateDraft({ kind: "invoice", ref: "c4" }, l))).toBe("hal has no email on file, so PayPal cannot send an invoice; send a pay-now link instead");
    expect(reason(validateDraft({ kind: "invoice", ref: "c2" }, withInvoice(l, "c2")))).toMatch(/invoice INV2-AAAA-1111 for dana is already sent/);
    const linkOut = { ...l, bills: l.bills.map((b) => (b.ref === "c2" ? { ...b, openOrder: true } : b)) };
    expect(reason(validateDraft({ kind: "invoice", ref: "c2" }, linkOut))).toMatch(/pay-now link is already out/);
  });

  it("does not queue two ways to collect the same bill", () => {
    const l = ledger();
    const first = validateDraft({ kind: "charge", ref: "c1" }, l);
    if (!first.ok) throw new Error(first.reason);
    expect(reason(validateDraft({ kind: "invoice", ref: "c1" }, l, { queued: [first.proposal] }))).toBe("ava already has a charge queued for the same items");
    const open: Proposal = { ...first.proposal, id: "show-x-cl1", planId: "p1", source: "closer", status: "approved", createdAt: T0 };
    expect(reason(validateDraft({ kind: "charge", ref: "c1" }, { ...l, open: [open] }))).toBe("a charge for ava is already queued");
  });

  it("reminds an open invoice only after the gap since the last nudge", () => {
    const l = withInvoice(ledger(), "c2", { sentAt: T0 - 30_000 });
    expect(reason(validateDraft({ kind: "reminder", ref: "c2" }, l))).toMatch(/dana was invoiced 30s ago; wait 30s more/);
    const later = { ...l, now: T0 + 31_000 };
    const v = validateDraft({ kind: "reminder", ref: "c2", note: "hey, just a heads-up" }, later);
    expect(v.ok && v.proposal).toMatchObject({ kind: "reminder", invoiceId: "INV2-AAAA-1111", amountCents: 4200, call: "send_invoice_reminder" });
    expect(reason(validateDraft({ kind: "reminder", ref: "c2" }, withInvoice(later, "c2", { status: "PAID" })))).toMatch(/already paid/);
    expect(reason(validateDraft({ kind: "reminder", ref: "c1" }, later))).toBe("no invoice has gone to ava yet");
    expect(reason(validateDraft({ kind: "reminder", ref: "c2" }, withInvoice(later, "c2", { status: "CANCELLED" })))).toMatch(/is cancelled, not waiting/);
  });

  it("refunds up to what was captured less what was refunded, parsed to the cent", () => {
    const l = ledger();
    expect(validateDraft({ kind: "refund", ref: "c5", amount: "5", note: "pulled thread" }, l)).toMatchObject({ ok: true, proposal: { amountCents: 500, note: "pulled thread", call: "create_refund" } });
    expect(reason(validateDraft({ kind: "refund", ref: "c5", amount: "500" }, l))).toBe("refund larger than the charge: $500 asked, $42 left of cleo's $42");
    const part = { ...l, bills: l.bills.map((b) => (b.ref === "c5" ? { ...b, refundedCents: 4000 } : b)) };
    expect(reason(validateDraft({ kind: "refund", ref: "c5", amount: "2.01" }, part))).toMatch(/\$2.01 asked, \$2 left/);
    expect(reason(validateDraft({ kind: "refund", ref: "c5", amount: "1.999" }, l))).toMatch(/more than two decimals/);
    expect(reason(validateDraft({ kind: "refund", ref: "c5", amount: "0" }, l))).toMatch(/more than \$0/);
    expect(reason(validateDraft({ kind: "refund", ref: "c5" }, l))).toMatch(/say how much/);
    expect(reason(validateDraft({ kind: "refund", ref: "c1", amount: "5" }, l))).toMatch(/no captured payment/);
  });

  it("tracks a paid order with a known carrier and a plausible number", () => {
    const l = ledger();
    expect(validateDraft({ kind: "tracking", ref: "c5", carrier: "usps", trackingNumber: "9400111202" }, l)).toMatchObject({ ok: true, proposal: { carrier: "USPS", trackingNumber: "9400111202" } });
    expect(reason(validateDraft({ kind: "tracking", ref: "c5", carrier: "Pigeon", trackingNumber: "9400111202" }, l))).toBe("carrier must be one of USPS, UPS, FEDEX, DHL");
    expect(reason(validateDraft({ kind: "tracking", ref: "c5", carrier: "UPS", trackingNumber: "12" }, l))).toMatch(/6 to 40/);
    expect(reason(validateDraft({ kind: "tracking", ref: "c1", carrier: "UPS", trackingNumber: "1Z999AA10123" }, l))).toBe("charge ava before adding tracking");
  });

  it("releases a hold only when it lapsed or the seller asked, and never under an open invoice", () => {
    const l = ledger();
    expect(reason(validateDraft({ kind: "release", ref: "c4" }, l))).toMatch(/has not lapsed/);
    expect(validateDraft({ kind: "release", ref: "c4" }, l, { sellerAskedRelease: true }).ok).toBe(true);
    expect(validateDraft({ kind: "release", ref: "c4" }, { ...l, now: T0 + 6 * 60_000 }).ok).toBe(true);
    expect(reason(validateDraft({ kind: "release", ref: "c2" }, withInvoice(l, "c2"), { sellerAskedRelease: true }))).toMatch(/still open/);
    expect(reason(validateDraft({ kind: "release", ref: "c1" }, l, { sellerAskedRelease: true }))).toMatch(/no unpaid hold/);
  });
});

describe("rule planner", () => {
  it("reads the three chips", () => {
    expect(readInstruction("Charge every Claim Pass, invoice everyone else")).toMatchObject({ all: false, charge: true, invoice: true, remind: false });
    expect(readInstruction("Who still owes me? Nudge them, nicely")).toMatchObject({ all: false, owes: true, remind: true, charge: false });
    expect(readInstruction("Refund nora $5, the cardigan had a pulled thread").refund).toEqual({ name: "nora", amount: "5", reason: "the cardigan had a pulled thread" });
    expect(readInstruction("").all).toBe(true);
    expect(readInstruction("sort it out please").all).toBe(true);
  });

  it("plans the whole close-out: charge passes, invoice with an email, pay-now link without", () => {
    const { drafts } = rulePlan(ledger(), "");
    expect(drafts.map((d) => `${d.kind}:${d.ref}`)).toEqual(["charge:c1", "invoice:c2", "charge:c3", "paylink:c4"]);
    expect(drafts.find((d) => d.kind === "invoice")!.note).toBe("Thanks for shopping Juniper & Thread live. This covers #14 Blue dress · M plus combined shipping. Pay with PayPal or a card whenever suits you.");
  });

  it("invoices a Claim Pass cart that is over its cap instead of charging it", () => {
    const l = ledger();
    const capped = { ...l, bills: l.bills.map((b) => (b.ref === "c3" ? { ...b, capRemainingCents: 10_000 } : b)) };
    expect(rulePlan(capped, "").drafts.map((d) => `${d.kind}:${d.ref}`)).toEqual(["charge:c1", "invoice:c2", "invoice:c3", "paylink:c4"]);
  });

  it("nudges open invoices past the gap with a warm note, and answers who owes in one line", () => {
    const l = { ...withInvoice(ledger(), "c2"), now: T0 };
    const { drafts } = rulePlan(l, "Who still owes me? Nudge them, nicely");
    expect(drafts).toEqual([expect.objectContaining({ kind: "reminder", ref: "c2" })]);
    expect(drafts[0]!.note).toMatch(/^Hi dana, just a heads-up that your Juniper & Thread invoice for \$42 is still open\. No rush/);
    expect(owesAnswer(l)).toBe("4 unpaid: ava $42, dana $42, nora $111, hal $56.");
  });

  it("refunds the named buyer from the instruction", () => {
    const l = ledger();
    const named = { ...l, bills: l.bills.map((b) => (b.ref === "c5" ? { ...b, buyer: "nora", buyerKey: "simulator:nora" } : b)) };
    const { drafts } = rulePlan(named, "Refund nora $5, the cardigan had a pulled thread");
    expect(drafts).toEqual([expect.objectContaining({ kind: "refund", ref: "c5", amount: "5", note: "Refund from Juniper & Thread: the cardigan had a pulled thread. Sorry about that." })]);
  });

  it("summarizes the queue in one line and counts what was dropped", () => {
    const l = ledger();
    const ps = (["c1", "c3"] as const).map((r) => validateDraft({ kind: "charge", ref: r }, l)).flatMap((v) => (v.ok ? [v.proposal] : []));
    const inv = validateDraft({ kind: "invoice", ref: "c2" }, l);
    const ref = validateDraft({ kind: "refund", ref: "c5", amount: "5" }, l);
    if (!inv.ok || !ref.ok) throw new Error("fixture");
    expect(summarize([...ps, inv.proposal, ref.proposal], [{ reason: "refund larger than the charge" }])).toBe(
      "4 actions: charge 2 Claim Pass carts, invoice 1 buyer, refund $5 to cleo. 1 proposal dropped: refund larger than the charge",
    );
    expect(summarize([])).toMatch(/^Nothing to do/);
  });
});
