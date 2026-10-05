import { buildCarts } from "./carts.js";
import type { Cart, EngineEvent, EngineState, ReviewItem, Unit } from "./types.js";
import { compareKeys, fmtTs } from "./util.js";

export interface WaitlistEntry {
  unitId: string;
  buyerKey: string;
  displayName: string;
  platformTs: number;
}

export interface BoardVariant {
  sku: string;
  size?: string;
  color?: string;
  qty: number;
  /** Confirmed (Claim Pass or paid) plus charged. */
  sold: number;
  /** Pay-now holds still inside their lease. */
  held: number;
  available: number;
  /** Grants still inside the settle window, which an earlier late claim could pre-empt. */
  settling: number;
  waitlist: WaitlistEntry[];
}

export interface BoardItem {
  code: string;
  title: string;
  priceCents: number;
  variants: BoardVariant[];
}

/** Per-variant sold / held / available / waitlist, in listing order. */
export function itemBoard(state: EngineState, now: number = state.clock): BoardItem[] {
  const byVariant = new Map<string, Unit[]>();
  for (const id of state.unitOrder) {
    const u = state.units[id]!;
    const k = `${u.itemCode}\u0000${u.sku}`;
    const list = byVariant.get(k) ?? [];
    list.push(u);
    byVariant.set(k, list);
  }
  return state.itemOrder.map((code) => {
    const item = state.items[code]!;
    return {
      code,
      title: item.title,
      priceCents: item.priceCents,
      variants: item.variants.map((v) => {
        const units = byVariant.get(`${code}\u0000${v.sku}`) ?? [];
        const sold = units.filter((u) => u.status === "confirmed" || u.status === "charged").length;
        const held = units.filter((u) => u.status === "held").length;
        const settling = units.filter(
          (u) => (u.status === "held" || u.status === "confirmed") && !u.paid && u.settleUntil !== undefined && now < u.settleUntil,
        ).length;
        const waitlist = units
          .filter((u) => u.status === "waitlisted")
          .sort((a, b) => compareKeys(a.key, b.key))
          .map((u) => ({
            unitId: u.id,
            buyerKey: u.buyerKey,
            displayName: state.buyers[u.buyerKey]?.buyer.displayName ?? u.buyerKey,
            platformTs: u.key.ts,
          }));
        return {
          sku: v.sku,
          ...(v.size ? { size: v.size } : {}),
          ...(v.color ? { color: v.color } : {}),
          qty: v.qty,
          sold,
          held,
          available: v.qty - sold - held,
          settling,
          waitlist,
        };
      }),
    };
  });
}

/** Variants where committed units exceed inventory. The engine's invariant is that this is always empty. */
export function oversold(state: EngineState): { itemCode: string; sku: string; qty: number; committed: number }[] {
  return itemBoard(state)
    .flatMap((item) => item.variants.map((v) => ({ itemCode: item.code, sku: v.sku, qty: v.qty, committed: v.sold + v.held })))
    .filter((v) => v.committed > v.qty);
}

export interface BuyerCarts {
  buyerKey: string;
  displayName: string;
  /** Carts already finalized for this buyer, oldest first. */
  finalized: Cart[];
  /** What finalizing now would bill: confirmed units not yet in a cart. */
  preview?: Cart;
  held: number;
  waitlisted: number;
}

export function buyerCarts(state: EngineState, now: number = state.clock): BuyerCarts[] {
  const preview = new Map(buildCarts(state, now).map((c) => [c.buyerKey, c]));
  return Object.values(state.buyers)
    .map(({ buyer }) => {
      const units = state.unitOrder.map((id) => state.units[id]!).filter((u) => u.buyerKey === buyer.buyerKey);
      const p = preview.get(buyer.buyerKey);
      return {
        buyerKey: buyer.buyerKey,
        displayName: buyer.displayName,
        finalized: state.cartOrder.map((id) => state.carts[id]!).filter((c) => c.buyerKey === buyer.buyerKey),
        ...(p ? { preview: p } : {}),
        held: units.filter((u) => u.status === "held").length,
        waitlisted: units.filter((u) => u.status === "waitlisted").length,
      };
    })
    .filter((b) => b.finalized.length || b.preview || b.held || b.waitlisted)
    .sort((a, b) => (a.buyerKey < b.buyerKey ? -1 : a.buyerKey > b.buyerKey ? 1 : 0));
}

/** Pending review items, earliest claim first. */
export function reviewQueue(state: EngineState): ReviewItem[] {
  return state.reviewOrder
    .map((id) => state.reviews[id]!)
    .filter((r) => r.status === "pending")
    .sort((a, b) => compareKeys(a.request.key, b.request.key));
}

export interface AuditEntry {
  seq: number;
  at: number;
  time: string;
  type: EngineEvent["type"];
  reason: string;
  buyerKey?: string;
  unitId?: string;
  commentId?: string;
}

/** Every decision with its reason, in the order it was made. */
export function auditLog(events: readonly EngineEvent[]): AuditEntry[] {
  return events.map((e) => {
    const entry: AuditEntry = { seq: e.seq, at: e.at, time: fmtTs(e.at), type: e.type, reason: e.reason };
    if ("unitId" in e) entry.unitId = e.unitId;
    if ("commentId" in e && e.commentId) entry.commentId = e.commentId;
    if ("buyer" in e && e.buyer) entry.buyerKey = e.buyer.buyerKey;
    else if ("buyerKey" in e) entry.buyerKey = e.buyerKey;
    return entry;
  });
}
