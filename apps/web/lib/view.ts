import {
  auditLog,
  buyerCarts,
  intentKey,
  itemBoard,
  oversold,
  reviewQueue,
  type ChatComment,
  type ClaimIntent,
  type Engine,
  type EngineEvent,
  type Unit,
} from "@claim/core";
import type { CloserLogEntry, InvoiceRecord, PlanRecord, Proposal } from "@claim/closer";
import { percentile } from "./stats";
import type {
  ChargeRecord,
  CommentView,
  IntentView,
  Kpis,
  ListedItem,
  OrderRecord,
  Outcome,
  RefundRecord,
  ShowView,
  TrackingRecord,
  TwitchStatus,
  UnitView,
  ViewScope,
  WebhookRecord,
} from "./types";

export interface CommentRecord {
  comment: ChatComment;
  intents: ClaimIntent[];
  latencyMs: number;
}

export interface PassRecord {
  vaultId: string;
  customerId: string;
  capCents?: number;
  /** Buyer key the setup token was created with; lets mock mode re-vault after a restart. */
  setupKey?: string;
  /** The payer's PayPal email, when the vault response carried it. */
  email?: string;
}

/** Closer's state for one show, folded from its records. */
export interface CloserState {
  plans: PlanRecord[];
  /** Insertion-ordered. */
  proposals: Map<string, Proposal>;
  /** By PayPal invoice id. */
  invoices: Map<string, InvoiceRecord>;
  log: CloserLogEntry[];
  /** Last proposal number used. */
  seq: number;
}

export interface ShowData {
  showId: string;
  title: string;
  shopName: string;
  createdAt: number;
  startedAt?: number;
  streamUrl?: string;
  onAir?: string;
  engine: Engine;
  transcripts: Map<string, string>;
  comments: CommentRecord[];
  /** Engine events keyed by intent key (`<commentId>` or `<commentId>#<n>`). */
  byKey: Map<string, EngineEvent[]>;
  byUnit: Map<string, EngineEvent[]>;
  passes: Map<string, PassRecord>;
  orders: Map<string, OrderRecord>;
  charges: ChargeRecord[];
  refunds: RefundRecord[];
  tracking: TrackingRecord[];
  webhooks: WebhookRecord[];
  twitch: TwitchStatus;
  simulation?: { scenario: string; label: string; startedAt: number };
  closer: CloserState;
}

export interface ViewEnv {
  payments: { mode: "sandbox" | "mock"; label: string };
  llm: { provider: string; model: string; escalateModel?: string };
}

const ACTIONABLE = new Set(["claim", "cancel", "change", "waitlist"]);
const COMMENT_LIMIT = 160;
const AUDIT_LIMIT = 500;

/** Indexes one engine event so stream rows and units can find the decisions about them. */
export function indexEvent(data: Pick<ShowData, "byKey" | "byUnit">, e: EngineEvent): void {
  if ("commentId" in e && e.commentId) {
    const list = data.byKey.get(e.commentId) ?? [];
    list.push(e);
    data.byKey.set(e.commentId, list);
  }
  const unitIds = "unitIds" in e ? e.unitIds : "unitId" in e ? [e.unitId] : [];
  for (const id of unitIds) {
    const list = data.byUnit.get(id) ?? [];
    list.push(e);
    data.byUnit.set(id, list);
  }
}

function itemLabel(engine: Engine, u: Pick<Unit, "itemCode" | "sku">): { label: string; title: string } {
  const item = engine.state.items[u.itemCode];
  const v = item?.variants.find((x) => x.sku === u.sku);
  const attrs = [v?.size, v?.color].filter(Boolean).join(" · ");
  return { label: `#${u.itemCode}${attrs ? ` ${attrs}` : ""}`, title: item?.title ?? `Item ${u.itemCode}` };
}

const RELEASE_LABEL: Record<string, string> = {
  "lease-expired": "LAPSED",
  "buyer-cancel": "CANCELLED",
  "seller-revoke": "REVOKED",
  changed: "SWAPPED",
  "to-review": "REVIEW",
};

function unitsOutcome(data: ShowData, units: Unit[], waitPos: Map<string, number>, now: number): Outcome {
  const by = (s: Unit["status"]) => units.filter((u) => u.status === s);
  const charged = by("charged");
  const confirmed = by("confirmed");
  const held = by("held");
  const waiting = by("waitlisted");
  const released = by("released");
  const granted = [...confirmed, ...held];
  const settling = granted.filter((u) => !u.paid && u.settleUntil !== undefined && now < u.settleUntil);
  const settleUntil = settling.length ? Math.max(...settling.map((u) => u.settleUntil!)) : undefined;

  const lastOf = (u: Unit, type: EngineEvent["type"]) => [...(data.byUnit.get(u.id) ?? [])].reverse().find((e) => e.type === type);
  const parts: string[] = [];
  if (charged.length) parts.push(`SOLD${charged.length > 1 ? ` ×${charged.length}` : ""}`);
  if (granted.length) parts.push(`GRANTED${granted.length > 1 ? ` ×${granted.length}` : ""}`);
  if (waiting.length) parts.push(`WAITLIST #${Math.min(...waiting.map((u) => waitPos.get(u.id) ?? 0))}`);

  if (!parts.length && released.length) {
    const cause = released[0]!.releaseCause ?? "released";
    return { tone: cause === "to-review" ? "review" : "released", label: RELEASE_LABEL[cause] ?? "RELEASED", detail: cause.replace("-", " ") };
  }

  let detail: string | undefined;
  if (granted.length) {
    const g = granted[0]!;
    const grantEv = lastOf(g, "unitGranted");
    const promoted = grantEv?.type === "unitGranted" && grantEv.promoted;
    const preempted = grantEv?.type === "unitGranted" && grantEv.preempted;
    const how = g.paid ? "paid" : g.via === "claim-pass" ? "Claim Pass" : "pay-now hold";
    detail = [promoted ? "promoted from waitlist" : preempted ? "earlier timestamp won" : undefined, how].filter(Boolean).join(" · ");
  } else if (waiting.length) {
    const ev = lastOf(waiting[0]!, "unitWaitlisted");
    detail = ev?.type === "unitWaitlisted" && ev.cause === "preempted" ? "pre-empted by an earlier claim" : "sold out";
  } else if (charged.length) detail = "charged at close-out";

  const tone = charged.length && !granted.length && !waiting.length
    ? "sold"
    : granted.length
      ? settling.length
        ? "settling"
        : held.length && !confirmed.length
          ? "held"
          : "granted"
      : "waitlist";
  const leaseUntil = held.length ? Math.min(...held.map((u) => u.leaseExpiresAt ?? Infinity)) : undefined;
  return {
    tone,
    label: parts.join(" · "),
    ...(detail ? { detail } : {}),
    ...(leaseUntil !== undefined && Number.isFinite(leaseUntil) ? { leaseUntil } : {}),
    ...(settleUntil !== undefined ? { settleUntil } : {}),
  };
}

function intentOutcome(data: ShowData, key: string, intent: ClaimIntent, unitsByKey: Map<string, Unit[]>, waitPos: Map<string, number>, now: number): Outcome {
  const events = data.byKey.get(key) ?? [];
  const ignored = events.find((e) => e.type === "intentIgnored");
  if (ignored) return intent.kind === "question" ? { tone: "question", label: "QUESTION" } : { tone: "chatter", label: "CHATTER" };

  const units = unitsByKey.get(key) ?? [];
  const releasedByThis = events.filter((e) => e.type === "unitReleased");
  if (units.length) {
    const o = unitsOutcome(data, units, waitPos, now);
    if (releasedByThis.length) o.detail = [`swapped out ${releasedByThis.length}`, o.detail].filter(Boolean).join(" · ");
    return o;
  }

  const state = data.engine.state;
  const review = [...state.reviewOrder].reverse().map((id) => state.reviews[id]!).find((r) => r.commentId === key);
  if (releasedByThis.length) {
    return { tone: "released", label: "CANCELLED", detail: `freed ${releasedByThis.length} unit${releasedByThis.length > 1 ? "s" : ""}` };
  }
  if (review) {
    if (review.status === "pending") return { tone: "review", label: "REVIEW", detail: review.cause.replace(/-/g, " ") };
    if (review.status === "rejected") return { tone: "rejected", label: "REJECTED", detail: "seller rejected" };
    return { tone: "granted", label: "APPROVED", detail: "seller approved" };
  }
  if (events.some((e) => e.type === "claimParked")) return { tone: "pending", label: "PARKED", detail: `#${intent.itemCode} not listed yet` };
  const rejected = events.find((e) => e.type === "commandRejected");
  if (rejected) return { tone: "rejected", label: "NO-OP", detail: rejected.reason };
  return { tone: "pending", label: "…" };
}

const PRIORITY: Outcome["tone"][] = ["review", "settling", "granted", "held", "sold", "waitlist", "released", "rejected", "pending", "question", "chatter"];

export function buildView(data: ShowData, env: ViewEnv, now: number, scope: ViewScope = "public"): ShowView {
  const { engine } = data;
  const state = engine.state;
  const board = itemBoard(state, now);

  const waitPos = new Map<string, number>();
  for (const item of board) for (const v of item.variants) v.waitlist.forEach((w, i) => waitPos.set(w.unitId, i + 1));

  const unitsByKey = new Map<string, Unit[]>();
  for (const id of state.unitOrder) {
    const u = state.units[id]!;
    if (!u.commentId) continue;
    const list = unitsByKey.get(u.commentId) ?? [];
    list.push(u);
    unitsByKey.set(u.commentId, list);
  }

  const intentsById = new Map(data.comments.map((c) => [c.comment.id, c.intents]));
  const rationaleFor = (commentId: string, itemCode?: string): { rationale?: string } => {
    const intents = intentsById.get(commentId) ?? [];
    const hit = intents.find((i) => i.itemCode === itemCode) ?? intents[0];
    return hit?.rationale ? { rationale: hit.rationale } : {};
  };
  const comments: CommentView[] = data.comments
    .slice(-COMMENT_LIMIT)
    .reverse()
    .map(({ comment, intents, latencyMs }) => {
      const views: IntentView[] = intents.map((intent, i) => {
        const n = intent.intentIndex ?? i;
        const key = intentKey(comment.id, n);
        return {
          index: n,
          kind: intent.kind,
          ...(intent.itemCode ? { itemCode: intent.itemCode } : {}),
          ...(intent.size ? { size: intent.size } : {}),
          ...(intent.color ? { color: intent.color } : {}),
          ...(intent.qty !== undefined ? { qty: intent.qty } : {}),
          ...(intent.fromItemCode ? { fromItemCode: intent.fromItemCode } : {}),
          confidence: intent.confidence,
          method: intent.method,
          ...(intent.rationale ? { rationale: intent.rationale } : {}),
          outcome: intentOutcome(data, key, intent, unitsByKey, waitPos, now),
        };
      });
      const outcome = [...views].sort((a, b) => PRIORITY.indexOf(a.outcome.tone) - PRIORITY.indexOf(b.outcome.tone))[0]?.outcome ?? {
        tone: "pending" as const,
        label: "…",
      };
      return {
        id: comment.id,
        platform: comment.platform,
        buyerKey: `${comment.platform}:${comment.userId}`,
        displayName: comment.displayName,
        text: comment.text,
        platformTs: comment.platformTs,
        receivedTs: comment.receivedTs,
        latencyMs,
        intents: views,
        outcome,
      };
    });

  const units: UnitView[] = state.unitOrder
    .map((id) => state.units[id]!)
    .filter((u) => u.status !== "pending")
    .map((u) => {
      const { label, title } = itemLabel(engine, u);
      return {
        id: u.id,
        buyerKey: u.buyerKey,
        displayName: state.buyers[u.buyerKey]?.buyer.displayName ?? u.buyerKey,
        itemCode: u.itemCode,
        sku: u.sku,
        label,
        title,
        priceCents: u.priceCents,
        status: u.status,
        ...(u.via ? { via: u.via } : {}),
        paid: u.paid,
        ...(u.leaseExpiresAt !== undefined ? { leaseExpiresAt: u.leaseExpiresAt } : {}),
        ...(u.settleUntil !== undefined ? { settleUntil: u.settleUntil } : {}),
        ...(waitPos.has(u.id) ? { waitlistPos: waitPos.get(u.id)! } : {}),
        ...(u.commentId ? { commentId: u.commentId } : {}),
        ...(u.cartId ? { cartId: u.cartId } : {}),
        ...(u.releaseCause ? { releaseCause: u.releaseCause } : {}),
      };
    });

  const items: ListedItem[] = state.itemOrder.map((code) => {
    const it = state.items[code]!;
    const transcript = data.transcripts.get(code);
    return {
      code,
      title: it.title,
      priceCents: it.priceCents,
      variants: it.variants.map((v) => ({ ...v })),
      listedAt: it.listedAt,
      ...(transcript ? { transcript } : {}),
    };
  });

  return {
    showId: data.showId,
    title: data.title,
    shopName: data.shopName,
    createdAt: data.createdAt,
    ...(data.startedAt ? { startedAt: data.startedAt } : {}),
    phase: state.phase,
    now,
    ...(data.streamUrl ? { streamUrl: data.streamUrl } : {}),
    ...(data.onAir ? { onAir: data.onAir } : {}),
    items,
    board,
    comments,
    reviews: reviewQueue(state).map((r) => ({
      ...rationaleFor(r.request.key.id, r.request.itemCode),
      id: r.id,
      buyerKey: r.buyerKey,
      displayName: state.buyers[r.buyerKey]?.buyer.displayName ?? r.buyerKey,
      cause: r.cause,
      reason: r.reason,
      kind: r.request.kind,
      ...(r.request.itemCode ? { itemCode: r.request.itemCode } : {}),
      ...(r.request.sku ? { sku: r.request.sku } : {}),
      ...(r.request.size ? { size: r.request.size } : {}),
      ...(r.request.color ? { color: r.request.color } : {}),
      ...(r.request.qty !== undefined ? { qty: r.request.qty } : {}),
      ...(r.request.confidence !== undefined ? { confidence: r.request.confidence } : {}),
      ...(r.request.text ? { text: r.request.text } : {}),
      platformTs: r.request.key.ts,
      openedAt: r.openedAt,
    })),
    audit: auditLog(engine.events.slice(-AUDIT_LIMIT)),
    units,
    buyers: Object.values(state.buyers).map(({ buyer, pass }) => ({
      buyerKey: buyer.buyerKey,
      displayName: buyer.displayName,
      ...(buyer.platform ? { platform: buyer.platform } : {}),
      hasPass: Boolean(pass),
      ...(pass?.capCents !== undefined ? { passCapCents: pass.capCents } : {}),
      vaulted: data.passes.has(buyer.buyerKey),
    })),
    carts: buyerCarts(state, now),
    orders: [...data.orders.values()],
    charges: scope === "seller" ? data.charges : data.charges.map(({ shipTo: _address, ...c }) => c),
    refunds: data.refunds,
    tracking: data.tracking,
    webhooks: data.webhooks,
    kpis: kpis(data, now),
    config: {
      currency: state.config.currency,
      ...(state.config.cap.maxCents !== undefined ? { capCents: state.config.cap.maxCents } : {}),
      leaseMs: state.config.leaseMs,
      settleWindowMs: state.config.settleWindowMs,
      confidenceThreshold: state.config.confidenceThreshold,
      shipping: { ...state.config.shipping },
    },
    payments: env.payments,
    llm: env.llm,
    twitch: data.twitch,
    ...(data.simulation ? { simulation: data.simulation } : {}),
  };
}

export function kpis(data: ShowData, now: number): Kpis {
  const state = data.engine.state;
  const recent = data.comments.filter((c) => now - c.comment.receivedTs <= 60_000).length;
  let actionable = 0;
  let reviewed = 0;
  let claims = 0;
  for (const { comment, intents } of data.comments) {
    intents.forEach((intent, i) => {
      if (!ACTIONABLE.has(intent.kind)) return;
      actionable += 1;
      if (intent.kind === "claim") claims += 1;
      const key = intentKey(comment.id, intent.intentIndex ?? i);
      if ((data.byKey.get(key) ?? []).some((e) => e.type === "reviewOpened")) reviewed += 1;
    });
  }
  let heldCents = 0;
  let chargedCents = 0;
  for (const id of state.unitOrder) {
    const u = state.units[id]!;
    if (u.status === "held" || u.status === "confirmed") heldCents += u.priceCents;
    if (u.status === "charged") chargedCents += u.priceCents;
  }
  return {
    commentsPerMin: recent,
    totalComments: data.comments.length,
    autoResolved: actionable ? (actionable - reviewed) / actionable : null,
    p95LatencyMs: percentile(data.comments.slice(-500).map((c) => c.latencyMs), 95),
    heldCents,
    chargedCents,
    oversold: oversold(state).length,
    reviewOpen: reviewQueue(state).length,
    claims,
  };
}
