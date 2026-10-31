import {
  isOpenInvoice,
  type Bill,
  type BillLine,
  type CloserLedger,
  type CloserLogEntry,
  type InvoiceRecord,
  type Proposal,
} from "@claim/closer";
import { effectiveCapCents, type Cart, type CartChargeInput } from "@claim/core";
import type { ShowRecord } from "./store";
import type { CloserView } from "./types";
import type { CloserState, ShowData } from "./view";

export const CARRIERS = ["USPS", "UPS", "FEDEX", "DHL"] as const;
/** A reminder waits at least this long after the invoice or the last reminder. Short, for a demo. */
export const REMINDER_GAP_MS = 60_000;
/** How long holds stay with a buyer once an invoice for them is out. */
export const INVOICE_HOLD_MS = 24 * 60 * 60_000;
export const CHIPS = ["Charge every Claim Pass, invoice everyone else", "Who still owes me? Nudge them, nicely"] as const;

export function blankCloser(): CloserState {
  return { plans: [], proposals: new Map(), invoices: new Map(), log: [], seq: 0 };
}

/** Folds one Closer record into the state; the service applies the same record when it writes it. */
export function foldCloser(c: CloserState, r: ShowRecord): void {
  switch (r.k) {
    case "closerPlan":
      c.plans.push(r.plan);
      return;
    case "proposal": {
      c.proposals.set(r.proposal.id, { ...r.proposal });
      const n = Number(/-cl(\d+)$/.exec(r.proposal.id)?.[1]);
      if (Number.isFinite(n)) c.seq = Math.max(c.seq, n);
      return;
    }
    case "decision": {
      const p = c.proposals.get(r.proposalId);
      if (!p) return;
      if (r.decision === "edited") {
        if (r.note !== undefined) p.note = r.note;
        return;
      }
      p.status = r.decision;
      p.decidedAt = r.at;
      if (r.note !== undefined) p.note = r.note;
      return;
    }
    case "result": {
      const p = c.proposals.get(r.proposalId);
      if (!p) return;
      p.status = r.status;
      if (r.result) p.result = r.result;
      return;
    }
    case "invoice":
      c.invoices.set(r.invoice.invoiceId, { ...r.invoice });
      return;
    case "closerLog":
      c.log.push(r.entry);
      return;
  }
}

/** A restart can interrupt a call: a proposal left running goes back to approved, so approving it again retries under the same request ids. */
export function settleAfterRestart(c: CloserState): void {
  for (const p of c.proposals.values()) if (p.status === "running") p.status = "approved";
}

export interface LedgerDeps {
  now: number;
  emailFor(buyerKey: string): string | undefined;
  /** What is still owed on a cart, as PayPal line items (the same input a charge or a pay-now order sends). */
  cartInput(cart: Cart): CartChargeInput;
  /** The pay-now input for a buyer's unpaid holds, or undefined when there are none. */
  holdsInput(buyerKey: string): { input: CartChargeInput; unitIds: string[] } | undefined;
  /** Proposals the plan must not repeat: approved and running ones. */
  open: Proposal[];
}

const toLines = (input: CartChargeInput): BillLine[] => input.lines.map((l) => ({ name: l.name, qty: l.qty, unitCents: l.unitCents }));

/**
 * The show's money as Closer sees it: a bill per finalized cart (due or paid) and one per buyer's unpaid
 * holds. Refs follow the order buyers first claimed, so they stay put while a plan runs.
 */
export function buildLedger(show: ShowData, deps: LedgerDeps): CloserLedger {
  const s = show.engine.state;
  const invoices = [...show.closer.invoices.values()];
  const orders = [...show.orders.values()].filter((o) => o.status === "open");
  const buyerOrder = new Map<string, number>();
  for (const id of s.unitOrder) {
    const bk = s.units[id]!.buyerKey;
    if (!buyerOrder.has(bk)) buyerOrder.set(bk, buyerOrder.size);
  }
  const name = (bk: string) => s.buyers[bk]?.buyer.displayName ?? bk;
  const livePass = (bk: string) => Boolean(s.buyers[bk]?.pass && show.passes.has(bk));
  const chargedTotal = (bk: string) => s.cartOrder.map((id) => s.carts[id]!).filter((c) => c.buyerKey === bk && c.status === "charged").reduce((a, c) => a + c.totalCents, 0);
  const lastDecline = (bk: string) => {
    const carts = new Set(s.cartOrder.filter((id) => s.carts[id]!.buyerKey === bk));
    return [...show.charges].reverse().find((c) => carts.has(c.cartId) && c.status === "DECLINED")?.declineCode;
  };
  const invoiceFor = (key: string, cartId?: string): InvoiceRecord | undefined =>
    [...invoices].reverse().find((i) => i.billKey === key || (cartId !== undefined && i.cartId === cartId));

  const bills: (Omit<Bill, "ref"> & { order: number })[] = [];
  for (const id of s.cartOrder) {
    const cart = s.carts[id]!;
    if (cart.status === "declined") continue;
    const key = `cart:${cart.cartId}`;
    const email = deps.emailFor(cart.buyerKey);
    const invoice = invoiceFor(key, cart.cartId);
    const common = {
      key,
      buyerKey: cart.buyerKey,
      buyer: cart.displayName,
      cartId: cart.cartId,
      chargeMode: cart.chargeMode,
      claimPass: livePass(cart.buyerKey),
      ...(email ? { email } : {}),
      ...(invoice ? { invoice } : {}),
      order: (buyerOrder.get(cart.buyerKey) ?? 999) * 100 + cart.seq,
    };
    if (cart.status === "pending") {
      const input = deps.cartInput(cart);
      const cap = effectiveCapCents(s, cart.buyerKey);
      const decline = lastDecline(cart.buyerKey);
      bills.push({
        ...common,
        state: "due",
        lines: toLines(input),
        shippingCents: input.shippingCents,
        amountCents: input.totalCents,
        ...(cap !== undefined ? { capRemainingCents: Math.max(0, cap - chargedTotal(cart.buyerKey)) } : {}),
        ...(decline ? { declineCode: decline } : {}),
        ...(orders.some((o) => o.cartId === cart.cartId) ? { openOrder: true } : {}),
      });
      continue;
    }
    const charge = [...show.charges].reverse().find((c) => c.cartId === cart.cartId && c.status === "COMPLETED");
    const refunded = show.refunds.filter((r) => r.cartId === cart.cartId).reduce((a, r) => a + r.amountCents, 0);
    const tracked = show.tracking.filter((t) => t.cartId === cart.cartId).map((t) => t.trackingNumber);
    bills.push({
      ...common,
      state: "paid",
      lines: cart.lines.map((l) => ({ name: l.title, qty: l.qty, unitCents: l.unitCents })),
      shippingCents: cart.shippingCents,
      amountCents: charge?.amountCents ?? cart.dueCents,
      ...(charge?.captureId ? { captureId: charge.captureId } : {}),
      ...(charge?.orderId ? { orderId: charge.orderId } : {}),
      refundedCents: refunded,
      ...(charge ? { paidVia: charge.via } : {}),
      ...(tracked.length ? { tracked } : {}),
    });
  }

  const heldBuyers = new Set(s.unitOrder.map((id) => s.units[id]!).filter((u) => u.status === "held" && !u.paid && !u.cartId).map((u) => u.buyerKey));
  for (const bk of heldBuyers) {
    const h = deps.holdsInput(bk);
    if (!h) continue;
    const key = `holds:${bk}`;
    const email = deps.emailFor(bk);
    const invoice = invoiceFor(key);
    const units = h.unitIds.map((id) => s.units[id]!);
    const leases = units.map((u) => u.leaseExpiresAt).filter((t): t is number => t !== undefined);
    const decline = lastDecline(bk);
    const ids = new Set(h.unitIds);
    bills.push({
      key,
      state: "unpaid",
      buyerKey: bk,
      buyer: name(bk),
      unitIds: h.unitIds,
      chargeMode: "pay-now",
      claimPass: livePass(bk),
      lines: toLines(h.input),
      shippingCents: h.input.shippingCents,
      amountCents: h.input.totalCents,
      ...(email ? { email } : {}),
      ...(decline ? { declineCode: decline } : {}),
      ...(leases.length ? { holdUntil: Math.min(...leases) } : {}),
      ...(orders.some((o) => o.purpose === "holds" && o.buyerKey === bk && (o.unitIds ?? []).some((u) => ids.has(u))) ? { openOrder: true } : {}),
      ...(invoice ? { invoice } : {}),
      order: (buyerOrder.get(bk) ?? 999) * 100 + 99,
    });
  }

  bills.sort((a, b) => a.order - b.order);
  return {
    showId: show.showId,
    shopName: show.shopName,
    currency: "USD",
    now: deps.now,
    bills: bills.map(({ order: _order, ...b }, i) => ({ ...b, ref: `c${i + 1}` })),
    invoices,
    open: deps.open,
    carriers: CARRIERS,
    reminderGapMs: REMINDER_GAP_MS,
  };
}

/** The third chip names a real paid buyer and item, so it never suggests a refund that would fail. */
export function suggestions(ledger: CloserLedger): string[] {
  const paid = ledger.bills.find((b) => b.state === "paid" && b.captureId && b.amountCents - (b.refundedCents ?? 0) >= 500 && b.lines.length);
  if (!paid) return [...CHIPS];
  const line = paid.lines.find((l) => /cardigan/i.test(l.name)) ?? paid.lines[paid.lines.length - 1]!;
  const noun = (line.name.replace(/^#\S+\s*/, "").split(/\s+·\s+/)[0] ?? "item").trim().split(/\s+/).pop()!.toLowerCase();
  return [...CHIPS, `Refund ${paid.buyer} $5, the ${noun} had a pulled thread`];
}

export function closerView(
  show: ShowData,
  ledger: CloserLedger,
  env: { planner: "closer" | "rules"; model?: string; executor: "toolkit" | "mock"; executorLabel: string; planning: boolean },
): CloserView {
  const c = show.closer;
  const planRank = new Map(c.plans.map((p, i) => [p.id, i]));
  const proposals = [...c.proposals.values()]
    .filter((p) => p.status !== "superseded")
    .sort((a, b) => (planRank.get(b.planId) ?? 0) - (planRank.get(a.planId) ?? 0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en", { numeric: true }));
  return {
    ...env,
    plans: [...c.plans].reverse().slice(0, 5),
    proposals,
    invoices: [...c.invoices.values()].map(({ email: _email, ...i }) => i),
    log: c.log.slice(-200),
    suggestions: suggestions(ledger),
  };
}

export const openInvoices = (c: CloserState) => [...c.invoices.values()].filter((i) => isOpenInvoice(i.status));

export function logEntry(type: CloserLogEntry["type"], reason: string, at: number, extra: { buyerKey?: string; proposalId?: string } = {}): CloserLogEntry {
  return { at, type, reason, ...extra };
}
