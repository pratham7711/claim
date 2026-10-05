import type { Cart, CartLine, EngineState, ShippingRule, Unit } from "./types.js";
import { compareKeys, fitId } from "./util.js";

/** Combined shipping: flat first item plus a per-extra charge, free at or above the threshold. */
export function shippingFor(units: number, subtotalCents: number, rule: ShippingRule): number {
  if (units <= 0) return 0;
  if (rule.freeOverCents !== undefined && subtotalCents >= rule.freeOverCents) return 0;
  return rule.firstItemCents + rule.perExtraItemCents * (units - 1);
}

/** PayPal invoice_id is capped at 127 chars and must be unique per merchant account. */
export function invoiceIdFor(showId: string, buyerKey: string, seq = 1): string {
  return fitId(seq <= 1 ? `${showId}-${buyerKey}` : `${showId}-${buyerKey}-${seq}`, 127);
}

/** PayPal-Request-Id: the invoice id itself, so a retried create replays rather than double-charges. */
export function requestIdFor(invoiceId: string): string {
  return fitId(invoiceId, 108);
}

export function effectiveCapCents(state: EngineState, buyerKey: string): number | undefined {
  const caps = [state.config.cap.maxCents, state.buyers[buyerKey]?.pass?.capCents].filter(
    (c): c is number => typeof c === "number",
  );
  return caps.length ? Math.min(...caps) : undefined;
}

const ACTIVE = new Set(["held", "confirmed", "charged"]);

export function isActive(u: Unit): boolean {
  return ACTIVE.has(u.status);
}

export interface Exposure {
  units: number;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
}

/** What the buyer's show total would be with `addPrices` granted, excluding `exclude`. */
export function exposure(
  state: EngineState,
  buyerKey: string,
  addPrices: number[] = [],
  exclude: ReadonlySet<string> = new Set(),
): Exposure {
  let units = addPrices.length;
  let subtotalCents = addPrices.reduce((a, b) => a + b, 0);
  for (const id of state.unitOrder) {
    const u = state.units[id]!;
    if (u.buyerKey !== buyerKey || !isActive(u) || exclude.has(id)) continue;
    units += 1;
    subtotalCents += u.priceCents;
  }
  const shippingCents = shippingFor(units, subtotalCents, state.config.shipping);
  return { units, subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}

function variantOrder(state: EngineState, u: Unit): [number, number] {
  const item = state.items[u.itemCode];
  return [state.itemOrder.indexOf(u.itemCode), item ? item.variants.findIndex((v) => v.sku === u.sku) : -1];
}

/**
 * One cart per buyer holding every confirmed unit not yet billed. Buyers who were billed before
 * (a decline, or a unit promoted after close-out) get a supplementary cart whose shipping is the
 * combined rule over everything billed minus the shipping already billed.
 */
export function buildCarts(state: EngineState, now: number): Cart[] {
  const byBuyer = new Map<string, Unit[]>();
  for (const id of state.unitOrder) {
    const u = state.units[id]!;
    if (u.status !== "confirmed" || u.cartId) continue;
    const list = byBuyer.get(u.buyerKey) ?? [];
    list.push(u);
    byBuyer.set(u.buyerKey, list);
  }

  const buyers = [...byBuyer.entries()].sort(([, a], [, b]) => compareKeys(minKey(a), minKey(b)));
  return buyers.map(([buyerKey, units]) => cartFor(state, buyerKey, units, now));
}

function minKey(units: Unit[]) {
  return units.reduce((m, u) => (compareKeys(u.key, m.key) < 0 ? u : m)).key;
}

function cartFor(state: EngineState, buyerKey: string, units: Unit[], now: number): Cart {
  const { config } = state;
  const buyer = state.buyers[buyerKey];
  const sorted = [...units].sort((a, b) => {
    const [ai, av] = variantOrder(state, a);
    const [bi, bv] = variantOrder(state, b);
    return ai - bi || av - bv || compareKeys(a.key, b.key);
  });

  const lines: CartLine[] = [];
  for (const u of sorted) {
    const last = lines[lines.length - 1];
    if (last && last.itemCode === u.itemCode && last.sku === u.sku && last.unitCents === u.priceCents) {
      last.qty += 1;
      last.lineCents += u.priceCents;
      if (u.paid) last.paidCents += u.priceCents;
      last.unitIds.push(u.id);
      continue;
    }
    const item = state.items[u.itemCode];
    const v = item?.variants.find((x) => x.sku === u.sku);
    lines.push({
      itemCode: u.itemCode,
      sku: u.sku,
      title: item?.title ?? u.itemCode,
      ...(v?.size ? { size: v.size } : {}),
      ...(v?.color ? { color: v.color } : {}),
      qty: 1,
      unitCents: u.priceCents,
      lineCents: u.priceCents,
      paidCents: u.paid ? u.priceCents : 0,
      unitIds: [u.id],
    });
  }

  const prior = state.cartOrder.map((id) => state.carts[id]!).filter((c) => c.buyerKey === buyerKey);
  const billed = prior.filter((c) => c.status !== "declined");
  const priorUnits = billed.reduce((a, c) => a + c.units, 0);
  const priorSubtotal = billed.reduce((a, c) => a + c.subtotalCents, 0);
  const priorShipping = billed.reduce((a, c) => a + c.shippingCents, 0);
  const priorTotal = billed.reduce((a, c) => a + c.totalCents, 0);

  const subtotalCents = lines.reduce((a, l) => a + l.lineCents, 0);
  const paidCents = lines.reduce((a, l) => a + l.paidCents, 0);
  const shippingCents = Math.max(
    0,
    shippingFor(priorUnits + units.length, priorSubtotal + subtotalCents, config.shipping) - priorShipping,
  );
  const totalCents = subtotalCents + shippingCents;
  const seq = prior.length + 1;
  const invoiceId = invoiceIdFor(config.showId, buyerKey, seq);
  const capCents = effectiveCapCents(state, buyerKey);
  const chargeMode = buyer?.pass ? "vault" : "pay-now";

  const flags: string[] = [];
  if (capCents !== undefined && priorTotal + totalCents > capCents) flags.push("over-cap");
  if (units.some((u) => u.source === "seller" || u.capExempt)) flags.push("seller-override");
  if (chargeMode === "pay-now" && totalCents - paidCents > 0) flags.push("pay-now-balance");
  if (seq > 1) flags.push("supplementary");

  return {
    cartId: invoiceId,
    showId: config.showId,
    buyerKey,
    displayName: buyer?.buyer.displayName ?? buyerKey,
    seq,
    invoiceId,
    requestId: requestIdFor(invoiceId),
    chargeMode,
    lines,
    units: units.length,
    subtotalCents,
    shippingCents,
    totalCents,
    paidCents,
    dueCents: totalCents - paidCents,
    ...(capCents !== undefined ? { capCents } : {}),
    flags,
    status: "pending",
    createdAt: now,
  };
}
