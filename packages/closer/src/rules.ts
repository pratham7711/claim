import { itemsText, usd } from "./format.js";
import { isOpenInvoice, validateDraft, type ValidateContext } from "./validate.js";
import type { Bill, CloserLedger, Draft, ProposalDraft } from "./types.js";

/** What the seller asked for, read with plain patterns. The rule planner acts on it; the model gets the words. */
export interface Ask {
  /** Nothing specific: plan the whole close-out. */
  all: boolean;
  charge: boolean;
  invoice: boolean;
  remind: boolean;
  /** "Who still owes me?": check invoices and answer in one line. */
  owes: boolean;
  release: boolean;
  refund?: { name: string; amount: string; reason?: string };
  tracking?: { name: string; carrier: string; number: string };
}

export function readInstruction(text: string): Ask {
  const t = text.trim();
  const refund = /\brefund\s+@?([\w.-]+)\s+\$?(\d+(?:\.\d+)?)(?:\s*(?:,|because|for|as|-|–|—)\s*(.+))?/i.exec(t);
  const track = /\btrack(?:ing)?\s+(?:for\s+)?@?([\w.-]+)\W+(USPS|UPS|FEDEX|DHL)\s+([A-Za-z0-9-]{6,40})/i.exec(t);
  const ask: Ask = {
    all: false,
    charge: /\bcharge|\bclaim pass/i.test(t),
    invoice: /\binvoice|\bbill\b|everyone else/i.test(t),
    remind: /\bnudge|\bremind|\bchase|follow[- ]?up/i.test(t),
    owes: /\bowe|\bunpaid|\boutstanding|\bwho\b.*\bpaid\b|\bwho\b.*\bpay\b/i.test(t),
    release: /\brelease|\blet (?:it|them|the items?) go\b/i.test(t),
    ...(refund ? { refund: { name: refund[1]!, amount: refund[2]!, ...(refund[3] ? { reason: refund[3].trim().replace(/[.!]+$/, "") } : {}) } } : {}),
    ...(track ? { tracking: { name: track[1]!, carrier: track[2]!.toUpperCase(), number: track[3]! } } : {}),
  };
  if (ask.owes) ask.remind = true;
  ask.all = !t || /\b(close[- ]?out|everything|wrap (?:it )?up|all of it)\b/i.test(t) || !(ask.charge || ask.invoice || ask.remind || ask.release || ask.refund || ask.tracking);
  return ask;
}

// ---------- template notes: plain, friendly, no pressure ----------

export function invoiceNote(bill: Bill, shopName: string): string {
  return `Thanks for shopping ${shopName} live. This covers ${itemsText(bill.lines)}${bill.shippingCents ? " plus combined shipping" : ""}. Pay with PayPal or a card whenever suits you.`;
}

export function reminderNote(bill: Bill, shopName: string): string {
  const amount = usd(bill.invoice?.amountCents ?? bill.amountCents);
  return `Hi ${bill.buyer}, just a heads-up that your ${shopName} invoice for ${amount} is still open. No rush, and thanks again for shopping the show.`;
}

export function refundNote(reason: string | undefined, shopName: string): string {
  return reason ? `Refund from ${shopName}: ${reason}. Sorry about that.` : `Refund from ${shopName}.`;
}

const owing = (b: Bill) => b.state !== "paid" && b.amountCents > 0;

/** "2 unpaid: dana $42, hal $56". Status comes from the ledger (and PayPal, after a check), never from a model. */
export function owesAnswer(ledger: CloserLedger, paidSinceCheck: Bill[] = []): string {
  const owed = ledger.bills.filter(owing);
  const head = owed.length ? `${owed.length} unpaid: ${owed.map((b) => `${b.buyer} ${usd(b.amountCents)}`).join(", ")}` : "Nobody owes you anything";
  const paid = paidSinceCheck.length ? `; paid since the last check: ${paidSinceCheck.map((b) => `${b.buyer} ${usd(b.amountCents)}`).join(", ")}` : "";
  return `${head}${paid}.`;
}

/**
 * The deterministic plan, used when no model is configured or it is busy: charge every Claim Pass cart
 * that fits its cap, invoice every other bill that has an email (a pay-now link when it does not), and
 * remind every open invoice past the gap. Each draft is checked as it is chosen, so this plan drops nothing.
 */
export function rulePlan(ledger: CloserLedger, instruction: string): { drafts: Draft[]; ask: Ask } {
  const ask = readInstruction(instruction);
  const drafts: Draft[] = [];
  const queued: ProposalDraft[] = [];
  const ctx = (): ValidateContext => ({ queued, sellerAskedRelease: ask.release });
  const take = (d: Draft): boolean => {
    const v = validateDraft(d, ledger, ctx());
    if (!v.ok) return false;
    drafts.push(d);
    queued.push(v.proposal);
    return true;
  };
  const shop = ledger.shopName;
  const owed = ledger.bills.filter(owing);
  const collect = ask.all || ask.charge || ask.invoice;

  for (const b of owed) {
    if (!collect || (b.invoice && isOpenInvoice(b.invoice.status))) continue;
    if ((ask.all || ask.charge) && b.claimPass && b.state === "due" && take({ kind: "charge", ref: b.ref, why: `Claim Pass on file; ${usd(b.amountCents)} due` })) continue;
    if (!(ask.all || ask.invoice)) continue;
    const declined = b.declineCode ? `Claim Pass declined (${b.declineCode}); ` : "";
    if (b.email && take({ kind: "invoice", ref: b.ref, note: invoiceNote(b, shop), why: `${declined}${usd(b.amountCents)} owed, email on file` })) continue;
    if (!b.email) take({ kind: "paylink", ref: b.ref, why: `${declined}${usd(b.amountCents)} owed, no email on file for an invoice` });
  }

  if (ask.all || ask.remind) {
    for (const b of ledger.bills) {
      if (b.invoice && isOpenInvoice(b.invoice.status)) take({ kind: "reminder", ref: b.ref, note: reminderNote(b, shop), why: `invoice ${b.invoice.invoiceId} still open` });
    }
  }

  const byName = (name: string, paid: boolean) => ledger.bills.find((b) => b.buyer.toLowerCase() === name.toLowerCase() && (b.state === "paid") === paid);
  if (ask.refund) {
    const b = byName(ask.refund.name, true);
    if (b) take({ kind: "refund", ref: b.ref, amount: ask.refund.amount, note: refundNote(ask.refund.reason, shop), why: ask.refund.reason ? `seller asked: ${ask.refund.reason}` : "seller asked for a refund" });
  }
  if (ask.tracking) {
    const b = byName(ask.tracking.name, true);
    if (b) take({ kind: "tracking", ref: b.ref, carrier: ask.tracking.carrier, trackingNumber: ask.tracking.number, why: "seller gave the tracking number" });
  }
  if (ask.release) {
    for (const b of ledger.bills) {
      if (b.state === "unpaid" && new RegExp(`\\b${b.buyer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(instruction)) take({ kind: "release", ref: b.ref, why: "seller asked to release the hold" });
    }
  }
  return { drafts, ask };
}
