/** What Closer can propose. Each maps to one PayPal call (or none, for a release). */
export type ProposalKind = "charge" | "invoice" | "paylink" | "reminder" | "refund" | "tracking" | "release";

/** "superseded" rows were still waiting when a newer plan replaced them; the grid leaves them out. */
export type ProposalStatus = "proposed" | "approved" | "running" | "done" | "failed" | "rejected" | "superseded";

export type ProposalSource = "closer" | "rules";

/** A validated action, before the service gives it an id. Every amount here came from the ledger. */
export interface ProposalDraft {
  kind: ProposalKind;
  /** The bill it acts on: `cart:<cartId>` or `holds:<buyerKey>`. */
  billKey: string;
  buyerKey: string;
  buyer: string;
  cartId?: string;
  unitIds?: string[];
  /** The PayPal invoice a reminder goes out for. */
  invoiceId?: string;
  amountCents: number;
  /** What the buyer reads: the invoice note, reminder note or refund note. */
  note?: string;
  /** The planner's one-line reason. */
  why: string;
  /** The PayPal call it makes, as the grid shows it. */
  call: string;
  carrier?: string;
  trackingNumber?: string;
}

export interface ProposalResult {
  at: number;
  ok: boolean;
  /** The id PayPal returned: invoice, refund, order or tracker. */
  id?: string;
  /** A second id or a count, e.g. the capture id. */
  detail?: string;
  /** PayPal's payer view of an invoice, or a pay-now link. */
  url?: string;
  /** Decline code or HTTP status of a failure. */
  code?: string;
  message?: string;
}

export interface Proposal extends ProposalDraft {
  id: string;
  planId: string;
  source: ProposalSource;
  status: ProposalStatus;
  createdAt: number;
  decidedAt?: number;
  result?: ProposalResult;
}

/** PayPal invoice statuses that still expect a payment. */
export const OPEN_INVOICE_STATUSES = ["SENT", "UNPAID", "SCHEDULED", "PARTIALLY_PAID", "PAYMENT_PENDING"] as const;
export const PAID_INVOICE_STATUSES = ["PAID", "MARKED_AS_PAID"] as const;

export interface InvoiceRecord {
  /** PayPal's id, INV2-…; the mock uses INV2-MOCK-…. */
  invoiceId: string;
  proposalId: string;
  billKey: string;
  buyerKey: string;
  buyer: string;
  email: string;
  cartId?: string;
  unitIds?: string[];
  amountCents: number;
  shippingCents: number;
  /** As PayPal last reported it. */
  status: string;
  payerViewUrl?: string;
  sentAt: number;
  remindedAt?: number;
  reminders: number;
  checkedAt?: number;
  paidAt?: number;
  /** Set when PayPal says paid but the items were no longer held for the buyer. */
  problem?: string;
}

export interface PlanRecord {
  id: string;
  at: number;
  instruction: string;
  source: ProposalSource;
  /** "Rule-based plan (AI busy)" and the like; absent for a model plan. */
  label?: string;
  /** Why the model was not used, for the audit. */
  fallbackReason?: string;
  /** Built from the queued proposals, never from the model's text. */
  summary: string;
  /** "2 unpaid: dana $42.00, hal $56.00", when the plan checked invoices or the seller asked who owes. */
  answer?: string;
  proposalIds: string[];
  dropped: { kind: string; ref: string; reason: string }[];
  /** The model's own last line, kept for the audit. */
  modelText?: string;
  usage?: { model?: string; turns: number; inputTokens: number; outputTokens: number; latencyMs: number };
}

/** One line in the Audit drawer: who proposed, what the seller decided, what PayPal returned. */
export interface CloserLogEntry {
  at: number;
  type: "plan" | "proposed" | "approved" | "rejected" | "done" | "failed" | "check" | "invoice";
  reason: string;
  buyerKey?: string;
  proposalId?: string;
}

// ---------- the ledger snapshot ----------

export interface BillLine {
  name: string;
  qty: number;
  unitCents: number;
}

/**
 * What one buyer owes or paid, as Closer sees it:
 * - `due`: a finalized cart not yet paid (a Claim Pass cart, or a pay-now balance);
 * - `unpaid`: pay-now holds, either never on a Claim Pass or back on hold after a declined charge;
 * - `paid`: a cart PayPal captured.
 */
export interface Bill {
  /** Short handle the model uses: c1, c2, … */
  ref: string;
  key: string;
  state: "due" | "unpaid" | "paid";
  buyerKey: string;
  buyer: string;
  cartId?: string;
  unitIds?: string[];
  chargeMode?: "vault" | "pay-now";
  /** The buyer holds a live Claim Pass with a saved wallet. */
  claimPass: boolean;
  capRemainingCents?: number;
  lines: BillLine[];
  shippingCents: number;
  /** Owed (due, unpaid) or captured (paid), in cents. */
  amountCents: number;
  email?: string;
  /** The buyer's last Claim Pass charge declined with this code. */
  declineCode?: string;
  /** Earliest lease end on unpaid holds. */
  holdUntil?: number;
  /** A pay-now link is out for this bill. */
  openOrder?: boolean;
  captureId?: string;
  orderId?: string;
  refundedCents?: number;
  paidVia?: "vault" | "pay-now" | "invoice";
  tracked?: string[];
  /** The open (or last) invoice for this bill. */
  invoice?: InvoiceRecord;
}

export interface CloserLedger {
  showId: string;
  shopName: string;
  currency: "USD";
  now: number;
  bills: Bill[];
  invoices: InvoiceRecord[];
  /** Proposals still waiting or running, so a plan does not queue the same action twice. */
  open: Proposal[];
  carriers: readonly string[];
  /** A reminder waits at least this long after the invoice or the last reminder. */
  reminderGapMs: number;
}

/** What a planner (model or rules) asks for, before validation. Amounts are strings as the model wrote them. */
export interface Draft {
  kind: ProposalKind;
  ref: string;
  why?: string;
  note?: string;
  amount?: string | number;
  carrier?: string;
  trackingNumber?: string;
}
