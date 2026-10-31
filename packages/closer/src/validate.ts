import { parseUsd, usd } from "./format.js";
import { OPEN_INVOICE_STATUSES, PAID_INVOICE_STATUSES, type Bill, type CloserLedger, type Draft, type ProposalDraft, type ProposalKind } from "./types.js";

export const CALL_LABEL: Record<ProposalKind, string> = {
  charge: "orders.create (vault)",
  invoice: "create_invoice → send_invoice",
  paylink: "orders.create (pay-now link)",
  reminder: "send_invoice_reminder",
  refund: "create_refund",
  tracking: "create_shipment_tracking",
  release: "none (back to the waitlist)",
};

export const isOpenInvoice = (status: string | undefined) => (OPEN_INVOICE_STATUSES as readonly string[]).includes(status ?? "");
export const isPaidInvoice = (status: string | undefined) => (PAID_INVOICE_STATUSES as readonly string[]).includes(status ?? "");

const NOTE_MAX = 400;
const TRACKING_NUMBER = /^[A-Za-z0-9-]{6,40}$/;

export interface ValidateContext {
  /** The seller asked in so many words to release holds, so a live hold may go. */
  sellerAskedRelease?: boolean;
  /** Proposals this plan already accepted. */
  queued?: ProposalDraft[];
}

export type Validation = { ok: true; proposal: ProposalDraft } | { ok: false; reason: string };

export function findBill(ledger: CloserLedger, ref: string): Bill | undefined {
  const r = ref.trim().toLowerCase().replace(/^@/, "");
  return ledger.bills.find((b) => b.ref === r || b.key === ref) ?? ledger.bills.find((b) => b.buyer.toLowerCase() === r && b.state !== "paid") ?? ledger.bills.find((b) => b.buyer.toLowerCase() === r);
}

const clean = (note: unknown): string | undefined => (typeof note === "string" && note.trim() ? note.trim().replace(/\s+/g, " ").slice(0, NOTE_MAX) : undefined);

/**
 * Checks one proposed action against the ledger. Amounts always come from the ledger; an amount the
 * planner wrote is only compared, and a refund's is parsed to the cent. A rejection says why in words
 * the model can act on, because it goes back to the model as the tool result.
 */
export function validateDraft(d: Draft, ledger: CloserLedger, ctx: ValidateContext = {}): Validation {
  const no = (reason: string): Validation => ({ ok: false, reason });
  const bill = typeof d.ref === "string" ? findBill(ledger, d.ref) : undefined;
  if (!bill) return no(`no bill "${String(d.ref ?? "").slice(0, 20)}"; use a ref from the ledger, like c1`);
  const who = bill.buyer;

  const queued = [...ledger.open, ...(ctx.queued ?? [])];
  const twin = queued.find((p) => p.kind === d.kind && p.billKey === bill.key);
  if (twin) return no(`a ${d.kind} for ${who} is already queued`);
  // One way to collect a bill at a time: a charge, an invoice and a pay-now link for the same items would bill twice.
  const COLLECT: ProposalKind[] = ["charge", "invoice", "paylink"];
  if (COLLECT.includes(d.kind)) {
    const other = queued.find((p) => COLLECT.includes(p.kind) && p.billKey === bill.key);
    if (other) return no(`${who} already has a ${other.kind} queued for the same items`);
  }

  const claimed = d.amount !== undefined && d.amount !== "" && d.kind !== "refund" ? parseUsd(d.amount) : undefined;
  if (claimed && claimed.ok && claimed.cents !== bill.amountCents && ["charge", "invoice", "paylink", "reminder"].includes(d.kind)) {
    return no(`${usd(claimed.cents)} does not match the ledger: ${who} owes ${usd(bill.amountCents)}`);
  }

  const base = {
    kind: d.kind,
    billKey: bill.key,
    buyerKey: bill.buyerKey,
    buyer: who,
    ...(bill.cartId ? { cartId: bill.cartId } : {}),
    ...(bill.unitIds?.length ? { unitIds: bill.unitIds } : {}),
    why: clean(d.why)?.slice(0, 200) ?? "",
    call: CALL_LABEL[d.kind],
  };
  const ok = (p: Partial<ProposalDraft> & { amountCents: number }): Validation => ({ ok: true, proposal: { ...base, ...p } });

  switch (d.kind) {
    case "charge": {
      if (bill.state === "paid") return no(`${who} already paid ${usd(bill.amountCents)}`);
      if (bill.state === "unpaid") return no(`${who} has no cart to charge: the items are on a pay-now hold${bill.declineCode ? ` after a ${bill.declineCode} decline` : ""}; invoice them or send a pay-now link`);
      if (bill.chargeMode !== "vault" || !bill.claimPass) return no(`${who} has no live Claim Pass, so there is no saved wallet to charge`);
      if (bill.amountCents <= 0) return no(`nothing is due from ${who}`);
      if (bill.capRemainingCents !== undefined && bill.amountCents > bill.capRemainingCents) {
        return no(`${usd(bill.amountCents)} is over ${who}'s Claim Pass cap (${usd(bill.capRemainingCents)} left); invoice them instead`);
      }
      return ok({ amountCents: bill.amountCents });
    }
    case "invoice": {
      if (bill.state === "paid") return no(`${who} already paid ${usd(bill.amountCents)}`);
      if (bill.amountCents <= 0) return no(`nothing is due from ${who}`);
      if (!bill.email) return no(`${who} has no email on file, so PayPal cannot send an invoice; send a pay-now link instead`);
      if (bill.invoice && (isOpenInvoice(bill.invoice.status) || isPaidInvoice(bill.invoice.status))) return no(`invoice ${bill.invoice.invoiceId} for ${who} is already ${bill.invoice.status.toLowerCase()}`);
      if (bill.openOrder) return no(`a pay-now link is already out for ${who}`);
      return ok({ amountCents: bill.amountCents, ...(clean(d.note) ? { note: clean(d.note) } : {}) });
    }
    case "paylink": {
      if (bill.state === "paid") return no(`${who} already paid ${usd(bill.amountCents)}`);
      if (bill.amountCents <= 0) return no(`nothing is due from ${who}`);
      if (bill.openOrder) return no(`a pay-now link is already out for ${who}`);
      if (bill.invoice && isOpenInvoice(bill.invoice.status)) return no(`invoice ${bill.invoice.invoiceId} is open for ${who}; send a reminder instead`);
      return ok({ amountCents: bill.amountCents });
    }
    case "reminder": {
      const inv = bill.invoice;
      if (!inv) return no(`no invoice has gone to ${who} yet`);
      if (isPaidInvoice(inv.status)) return no(`${who} already paid invoice ${inv.invoiceId}`);
      if (!isOpenInvoice(inv.status)) return no(`invoice ${inv.invoiceId} is ${inv.status.toLowerCase()}, not waiting for payment`);
      const last = inv.remindedAt ?? inv.sentAt;
      const wait = last + ledger.reminderGapMs - ledger.now;
      if (wait > 0) return no(`${who} was ${inv.remindedAt ? "reminded" : "invoiced"} ${Math.max(1, Math.round((ledger.now - last) / 1000))}s ago; wait ${Math.ceil(wait / 1000)}s more between nudges`);
      return ok({ amountCents: inv.amountCents, invoiceId: inv.invoiceId, ...(clean(d.note) ? { note: clean(d.note) } : {}) });
    }
    case "refund": {
      if (bill.state !== "paid" || !bill.captureId) return no(`${who} has no captured payment to refund`);
      const amt = parseUsd(d.amount);
      if (!amt.ok) return no(`refund amount: ${amt.reason}`);
      if (amt.cents <= 0) return no("a refund must be more than $0");
      const left = bill.amountCents - (bill.refundedCents ?? 0);
      if (amt.cents > left) return no(`refund larger than the charge: ${usd(amt.cents)} asked, ${usd(left)} left of ${who}'s ${usd(bill.amountCents)}`);
      return ok({ amountCents: amt.cents, ...(clean(d.note) ? { note: clean(d.note)!.slice(0, 255) } : {}) });
    }
    case "tracking": {
      if (bill.state !== "paid" || !bill.captureId) return no(`charge ${who} before adding tracking`);
      const carrier = typeof d.carrier === "string" ? d.carrier.trim().toUpperCase() : "";
      if (!ledger.carriers.includes(carrier)) return no(`carrier must be one of ${ledger.carriers.join(", ")}`);
      const number = typeof d.trackingNumber === "string" ? d.trackingNumber.trim() : "";
      if (!TRACKING_NUMBER.test(number)) return no("a tracking number is 6 to 40 letters, digits or dashes");
      if (bill.tracked?.includes(number)) return no(`${number} is already on ${who}'s order`);
      return ok({ amountCents: bill.amountCents, carrier, trackingNumber: number });
    }
    case "release": {
      if (bill.state !== "unpaid" || !bill.unitIds?.length) return no(`${who} has no unpaid hold to release`);
      if (bill.invoice && isOpenInvoice(bill.invoice.status)) return no(`invoice ${bill.invoice.invoiceId} for these items is still open`);
      const lapsed = bill.holdUntil !== undefined && bill.holdUntil <= ledger.now;
      if (!lapsed && !ctx.sellerAskedRelease) return no(`${who}'s hold has not lapsed and the seller did not ask to release it`);
      return ok({ amountCents: bill.amountCents });
    }
    default:
      return no(`unknown action ${String((d as { kind?: unknown }).kind)}`);
  }
}
