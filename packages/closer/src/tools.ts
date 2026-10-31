import type { ToolSpec } from "@claim/llm";
import { usd } from "./format.js";
import { isOpenInvoice } from "./validate.js";
import type { Bill, CloserLedger } from "./types.js";

const ref = { type: "string", description: "The bill's ref from the ledger, e.g. c1" };
const why = { type: "string", description: "One short line the seller reads: why this action" };

/**
 * Closer's tools. Each one only queues a proposal for the seller to approve; nothing here moves money.
 * Amounts are never taken from the model except a refund's, and that one is checked to the cent.
 */
export const CLOSER_TOOLS: ToolSpec[] = [
  {
    name: "charge_claim_pass",
    description: "Queue charges on buyers' saved Claim Pass wallets, for bills marked pass:true with state due.",
    parameters: { type: "object", properties: { refs: { type: "array", items: { type: "string" }, description: "Bill refs to charge" }, why }, required: ["refs"] },
  },
  {
    name: "invoice_buyer",
    description: "Queue a PayPal invoice for a bill that is owed and has email:true. The note goes to the buyer.",
    parameters: { type: "object", properties: { ref, note: { type: "string", description: "Short, friendly note to the buyer" }, why }, required: ["ref", "note"] },
  },
  {
    name: "send_pay_link",
    description: "Queue a pay-now link for an owed bill with no email, so the seller can send it in chat.",
    parameters: { type: "object", properties: { ref, why }, required: ["ref"] },
  },
  {
    name: "send_reminder",
    description: "Queue a reminder for an open invoice. Keep the note warm and short, a heads-up, not a demand.",
    parameters: { type: "object", properties: { ref, note: { type: "string" }, why }, required: ["ref", "note"] },
  },
  {
    name: "refund",
    description: "Queue a refund on a paid bill. amount is in dollars, e.g. \"5.00\".",
    parameters: { type: "object", properties: { ref, amount: { type: "string" }, note: { type: "string", description: "Note to the buyer" }, why }, required: ["ref", "amount"] },
  },
  {
    name: "add_tracking",
    description: "Queue a tracking number on a paid bill's PayPal order.",
    parameters: {
      type: "object",
      properties: { ref, carrier: { type: "string", enum: ["USPS", "UPS", "FEDEX", "DHL"] }, tracking_number: { type: "string" }, why },
      required: ["ref", "carrier", "tracking_number"],
    },
  },
  {
    name: "release_hold",
    description: "Queue releasing an unpaid hold back to the waitlist. Only when the seller asked, or the hold has lapsed.",
    parameters: { type: "object", properties: { ref, why }, required: ["ref"] },
  },
  {
    name: "check_invoices",
    description: "Ask PayPal for the current status of every sent invoice. Use before answering who still owes, or before reminding.",
    parameters: { type: "object", properties: {} },
  },
];

export const CLOSER_SYSTEM = [
  "You are Closer, the close-out assistant for a live-shopping seller who sells through PayPal.",
  "You read the seller's instruction and the ledger, then queue actions with the tools. The seller approves each one before anything runs.",
  "Rules: act only on refs in the ledger. Charge bills with pass:true and state due. Invoice other owed bills that have email:true; send a pay-now link when email:false.",
  "Remind only open invoices. Refund or track only paid bills. Release a hold only if the seller asked.",
  "If a tool answers ok:false, read the error and fix the call or skip that bill. Do not repeat a failed call unchanged.",
  "Notes to buyers: one or two plain, friendly sentences. No pressure, no exclamation marks, no emojis.",
  "When you are done, reply with one short line and no tool calls.",
].join("\n");

function billLine(b: Bill, now: number): Record<string, unknown> {
  const inv = b.invoice;
  return {
    ref: b.ref,
    buyer: b.buyer,
    state: b.state,
    amount: usd(b.amountCents),
    items: b.lines.map((l) => `${l.name}${l.qty > 1 ? ` x${l.qty}` : ""}`).join("; "),
    pass: b.claimPass,
    ...(b.capRemainingCents !== undefined && b.claimPass ? { cap_left: usd(b.capRemainingCents) } : {}),
    email: Boolean(b.email),
    ...(b.declineCode ? { declined: b.declineCode } : {}),
    ...(b.openOrder ? { pay_link_out: true } : {}),
    ...(inv ? { invoice: { status: inv.status, sent_min_ago: Math.round((now - inv.sentAt) / 60_000), reminders: inv.reminders } } : {}),
    ...(b.state === "paid" ? { refundable: usd(b.amountCents - (b.refundedCents ?? 0)), ...(b.tracked?.length ? { tracked: b.tracked } : {}) } : {}),
  };
}

/** The ledger as the model sees it: one compact JSON object per line. Emails never leave the server, only whether one exists. */
export function ledgerDigest(ledger: CloserLedger): string {
  if (!ledger.bills.length) return "(no bills)";
  return ledger.bills.map((b) => JSON.stringify(billLine(b, ledger.now))).join("\n");
}

/** What check_invoices returns to the model. */
export function invoiceDigest(ledger: CloserLedger): Record<string, unknown> {
  const sent = ledger.bills.filter((b) => b.invoice);
  return {
    open: sent.filter((b) => isOpenInvoice(b.invoice!.status)).map((b) => ({ ref: b.ref, buyer: b.buyer, amount: usd(b.invoice!.amountCents), status: b.invoice!.status, reminders: b.invoice!.reminders })),
    paid: sent.filter((b) => b.state === "paid").map((b) => ({ ref: b.ref, buyer: b.buyer, amount: usd(b.amountCents) })),
    not_invoiced: ledger.bills.filter((b) => b.state !== "paid" && !b.invoice).map((b) => ({ ref: b.ref, buyer: b.buyer, amount: usd(b.amountCents), email: Boolean(b.email) })),
  };
}
