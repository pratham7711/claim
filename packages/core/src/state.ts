import type { BuyerRef, EngineConfig, EngineEvent, EngineState, Unit } from "./types.js";

export function initialState(config: EngineConfig): EngineState {
  return {
    config: structuredClone(config),
    phase: "live",
    clock: 0,
    seq: 0,
    items: {},
    itemOrder: [],
    units: {},
    unitOrder: [],
    buyers: {},
    reviews: {},
    reviewOrder: [],
    parked: [],
    carts: {},
    cartOrder: [],
    seenComments: {},
    counters: { claim: 0, review: 0 },
  };
}

/** Pure: returns a new state with `event` applied. */
export function applyEvent(state: EngineState, event: EngineEvent): EngineState {
  const next = structuredClone(state);
  mutate(next, event);
  return next;
}

/** Rebuilds state from the event log alone. */
export function replay(config: EngineConfig, events: readonly EngineEvent[]): EngineState {
  const s = initialState(config);
  for (const e of events) mutate(s, e);
  return s;
}

function upsertBuyer(s: EngineState, buyer: BuyerRef): void {
  const cur = s.buyers[buyer.buyerKey];
  if (cur) cur.buyer = { ...cur.buyer, ...buyer };
  else s.buyers[buyer.buyerKey] = { buyer: { ...buyer } };
}

function unit(s: EngineState, id: string): Unit {
  const u = s.units[id];
  if (!u) throw new Error(`event references unknown unit ${id}`);
  return u;
}

function dropParked(s: EngineState, commentId: string | undefined): void {
  if (commentId) s.parked = s.parked.filter((p) => p.commentId !== commentId);
}

/** In-place application. Only the engine's own draft and replay call this. */
export function mutate(s: EngineState, e: EngineEvent): void {
  s.seq = e.seq;
  if (e.at > s.clock) s.clock = e.at;
  if ("commentId" in e && e.commentId) s.seenComments[e.commentId] = true;

  switch (e.type) {
    case "itemListed": {
      const { item } = e;
      s.items[item.code] = {
        code: item.code,
        title: item.title,
        priceCents: item.priceCents,
        variants: item.variants.map((v) => ({ ...v })),
        listedAt: e.at,
      };
      s.itemOrder.push(item.code);
      return;
    }
    case "inventoryUpdated": {
      const item = s.items[e.itemCode];
      if (!item) throw new Error(`unknown item ${e.itemCode}`);
      if (e.added) item.variants.push({ ...e.added });
      else {
        const v = item.variants.find((x) => x.sku === e.sku);
        if (!v) throw new Error(`unknown variant ${e.sku}`);
        v.qty = e.qty;
      }
      return;
    }
    case "claimAccepted": {
      upsertBuyer(s, e.buyer);
      s.counters.claim += 1;
      e.unitIds.forEach((id, n) => {
        const u: Unit = {
          id,
          claimId: e.claimId,
          buyerKey: e.buyer.buyerKey,
          itemCode: e.itemCode,
          sku: e.sku,
          key: { ts: e.key.ts, id: e.key.id, n },
          priceCents: e.priceCents,
          status: "pending",
          paid: false,
          capExempt: e.capExempt,
          source: e.source,
        };
        if (e.commentId) u.commentId = e.commentId;
        s.units[id] = u;
        s.unitOrder.push(id);
      });
      dropParked(s, e.commentId);
      return;
    }
    case "claimParked":
      upsertBuyer(s, e.buyer);
      s.parked.push({ commentId: e.commentId, buyerKey: e.buyer.buyerKey, request: e.request, parkedAt: e.at });
      return;
    case "unitGranted": {
      const u = unit(s, e.unitId);
      u.status = e.status;
      u.via = e.via;
      u.grantedAt = e.at;
      u.settleUntil = e.settleUntil;
      if (e.leaseExpiresAt !== undefined) u.leaseExpiresAt = e.leaseExpiresAt;
      else delete u.leaseExpiresAt;
      delete u.releaseCause;
      return;
    }
    case "unitWaitlisted": {
      const u = unit(s, e.unitId);
      u.status = "waitlisted";
      delete u.via;
      delete u.grantedAt;
      delete u.settleUntil;
      delete u.leaseExpiresAt;
      return;
    }
    case "unitReleased": {
      const u = unit(s, e.unitId);
      u.status = "released";
      u.releaseCause = e.cause;
      delete u.leaseExpiresAt;
      return;
    }
    case "unitConfirmed": {
      const u = unit(s, e.unitId);
      u.status = "confirmed";
      u.via = e.via === "payment" ? "pay-now" : "claim-pass";
      if (e.via === "payment") u.paid = true;
      delete u.leaseExpiresAt;
      return;
    }
    case "unitReverted": {
      const u = unit(s, e.unitId);
      u.status = "held";
      u.via = "pay-now";
      u.leaseExpiresAt = e.leaseExpiresAt;
      delete u.cartId;
      return;
    }
    case "leaseExtended":
      unit(s, e.unitId).leaseExpiresAt = e.leaseExpiresAt;
      return;
    case "unitReassigned": {
      upsertBuyer(s, e.to);
      const u = unit(s, e.unitId);
      u.buyerKey = e.to.buyerKey;
      u.status = e.status;
      u.via = e.via;
      u.capExempt = true;
      u.settleUntil = e.at;
      if (e.leaseExpiresAt !== undefined) u.leaseExpiresAt = e.leaseExpiresAt;
      else delete u.leaseExpiresAt;
      return;
    }
    case "reviewOpened":
      upsertBuyer(s, e.buyer);
      s.counters.review += 1;
      s.reviews[e.reviewId] = {
        id: e.reviewId,
        buyerKey: e.buyer.buyerKey,
        cause: e.cause,
        reason: e.reason,
        request: e.request,
        openedAt: e.at,
        status: "pending",
        ...(e.commentId ? { commentId: e.commentId } : {}),
      };
      s.reviewOrder.push(e.reviewId);
      dropParked(s, e.commentId);
      return;
    case "reviewResolved": {
      const r = s.reviews[e.reviewId];
      if (!r) throw new Error(`unknown review ${e.reviewId}`);
      r.status = e.decision;
      return;
    }
    case "intentIgnored":
      upsertBuyer(s, e.buyer);
      return;
    case "commandRejected":
      return;
    case "claimPassSaved": {
      upsertBuyer(s, e.buyer);
      const b = s.buyers[e.buyer.buyerKey]!;
      b.pass = { savedAt: e.at, ...(e.capCents !== undefined ? { capCents: e.capCents } : {}) };
      return;
    }
    case "claimPassRevoked": {
      const b = s.buyers[e.buyerKey];
      if (b) delete b.pass;
      return;
    }
    case "showEnded":
      s.phase = "ended";
      return;
    case "cartsFinalized":
      for (const cart of e.carts) {
        s.carts[cart.cartId] = structuredClone(cart);
        s.cartOrder.push(cart.cartId);
        for (const line of cart.lines) for (const id of line.unitIds) unit(s, id).cartId = cart.cartId;
      }
      return;
    case "cartCharged": {
      const cart = s.carts[e.cartId];
      if (!cart) throw new Error(`unknown cart ${e.cartId}`);
      cart.status = "charged";
      if (e.orderId) cart.orderId = e.orderId;
      for (const line of cart.lines) for (const id of line.unitIds) unit(s, id).status = "charged";
      return;
    }
    case "cartDeclined": {
      const cart = s.carts[e.cartId];
      if (!cart) throw new Error(`unknown cart ${e.cartId}`);
      cart.status = "declined";
      for (const line of cart.lines) for (const id of line.unitIds) delete unit(s, id).cartId;
      const b = s.buyers[cart.buyerKey];
      if (b) delete b.pass;
      return;
    }
  }
}
