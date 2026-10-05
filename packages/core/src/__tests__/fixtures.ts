import type { ChatComment, ClaimIntent, IntentKind, Platform, ShowItem } from "../contract.js";
import type { Engine } from "../engine.js";
import type { BuyerRef, EngineEvent, EngineState, Unit } from "../types.js";
import { buyerKeyOf } from "../util.js";

/** 12:01:03.000 UTC on show day. */
export const T0 = Date.UTC(2026, 9, 5, 12, 1, 3);

export interface ItemSpec {
  code: string;
  title?: string;
  priceCents?: number;
  variants: { size?: string; color?: string; qty: number; sku?: string }[];
}

export function item(spec: ItemSpec): ShowItem {
  return {
    code: spec.code,
    title: spec.title ?? `Item ${spec.code}`,
    priceCents: spec.priceCents ?? 3800,
    variants: spec.variants.map((v) => ({
      sku: v.sku ?? [spec.code, v.size ?? "OS", v.color ?? ""].filter(Boolean).join("-").toUpperCase(),
      qty: v.qty,
      ...(v.size ? { size: v.size } : {}),
      ...(v.color ? { color: v.color } : {}),
    })),
  };
}

export interface Say {
  id: string;
  user: string;
  /** platformTs */
  ts: number;
  kind?: IntentKind;
  item?: string;
  size?: string;
  color?: string;
  qty?: number;
  confidence?: number;
  platform?: Platform;
  text?: string;
}

export function comment(s: Say, receivedTs: number): ChatComment {
  return {
    id: s.id,
    platform: s.platform ?? "room",
    userId: s.user,
    displayName: s.user,
    text: s.text ?? `${s.kind ?? "claim"} ${s.item ?? ""} ${s.size ?? ""}`.trim(),
    platformTs: s.ts,
    receivedTs,
  };
}

export function intent(s: Say): ClaimIntent {
  return {
    commentId: s.id,
    kind: s.kind ?? "claim",
    confidence: s.confidence ?? 0.97,
    method: "rule",
    ...(s.item ? { itemCode: s.item } : {}),
    ...(s.size ? { size: s.size } : {}),
    ...(s.color ? { color: s.color } : {}),
    ...(s.qty !== undefined ? { qty: s.qty } : {}),
  };
}

export function say(eng: Engine, s: Say, now: number): EngineEvent[] {
  return eng.execute({ type: "applyIntent", comment: comment(s, now), intent: intent(s) }, now);
}

export function buyer(user: string, platform: Platform = "room"): BuyerRef {
  return { buyerKey: buyerKeyOf(platform, user), displayName: user, platform, userId: user };
}

export const key = (user: string, platform: Platform = "room") => buyerKeyOf(platform, user);

export function unitsOf(state: EngineState, user: string, platform: Platform = "room"): Unit[] {
  const k = key(user, platform);
  return state.unitOrder.map((id) => state.units[id]!).filter((u) => u.buyerKey === k);
}

export function statusOf(state: EngineState, user: string, platform: Platform = "room"): string[] {
  return unitsOf(state, user, platform).map((u) => u.status);
}

export function holders(state: EngineState, itemCode: string, sku: string): string[] {
  return state.unitOrder
    .map((id) => state.units[id]!)
    .filter((u) => u.itemCode === itemCode && u.sku === sku && ["held", "confirmed", "charged"].includes(u.status))
    .map((u) => state.buyers[u.buyerKey]!.buyer.displayName);
}

export function ofType<T extends EngineEvent["type"]>(events: readonly EngineEvent[], type: T): Extract<EngineEvent, { type: T }>[] {
  return events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
