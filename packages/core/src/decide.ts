import type { ShowItem } from "./contract.js";
import { buildCarts, effectiveCapCents, exposure, isActive } from "./carts.js";
import { mutate } from "./state.js";
import type {
  BuyerRef,
  ClaimKey,
  ClaimSource,
  Command,
  EngineEvent,
  EngineState,
  EventDraft,
  ItemState,
  ReviewCause,
  ReviewRequest,
  Unit,
  VariantState,
} from "./types.js";
import { buyerFromComment, compareKeys, fmtMoney, fmtTs, normalizeColor, normalizeSize } from "./util.js";

interface Ctx {
  draft: EngineState;
  now: number;
  events: EngineEvent[];
}

interface DispatchOpts {
  source: ClaimSource;
  commentId?: string;
  bypassCap: boolean;
}

const MAX_QTY_PER_CLAIM = 99;

/**
 * Decides what a command means at time `now` and returns the events that record it.
 * Pure: `state` is not touched, and the same (state, command, now) always yields the same events.
 * Leases that lapsed by `now` are expired first, so every decision sees current inventory.
 */
export function decide(state: EngineState, command: Command, now: number): EngineEvent[] {
  const ctx: Ctx = { draft: structuredClone(state), now: Math.max(now, state.clock), events: [] };
  expireLeases(ctx);
  handle(ctx, command);
  return ctx.events;
}

function emit(ctx: Ctx, draft: EventDraft): void {
  const e = { ...draft, seq: ctx.draft.seq + 1, at: ctx.now } as EngineEvent;
  mutate(ctx.draft, e);
  ctx.events.push(e);
}

function reject(ctx: Ctx, command: Command["type"], reason: string, extra: { commentId?: string; buyer?: BuyerRef } = {}): void {
  emit(ctx, { type: "commandRejected", command, reason, ...extra });
}

// ---------- queries over the draft ----------

const money = (ctx: Ctx, cents: number) => fmtMoney(cents, ctx.draft.config.currency);

function unitsWhere(s: EngineState, pred: (u: Unit) => boolean): Unit[] {
  const out: Unit[] = [];
  for (const id of s.unitOrder) {
    const u = s.units[id]!;
    if (pred(u)) out.push(u);
  }
  return out;
}

function variantOf(s: EngineState, itemCode: string, sku: string): VariantState | undefined {
  return s.items[itemCode]?.variants.find((v) => v.sku === sku);
}

function committed(s: EngineState, itemCode: string, sku: string): number {
  return unitsWhere(s, (u) => u.itemCode === itemCode && u.sku === sku && isActive(u)).length;
}

function available(s: EngineState, itemCode: string, sku: string): number {
  const v = variantOf(s, itemCode, sku);
  return v ? v.qty - committed(s, itemCode, sku) : 0;
}

function waitlist(s: EngineState, itemCode: string, sku: string): Unit[] {
  return unitsWhere(s, (u) => u.itemCode === itemCode && u.sku === sku && u.status === "waitlisted").sort((a, b) =>
    compareKeys(a.key, b.key),
  );
}

function hasPass(s: EngineState, buyerKey: string): boolean {
  return Boolean(s.buyers[buyerKey]?.pass);
}

function buyerOf(s: EngineState, buyerKey: string): BuyerRef {
  return s.buyers[buyerKey]?.buyer ?? { buyerKey, displayName: buyerKey };
}

function label(s: EngineState, itemCode: string, sku: string): string {
  const v = variantOf(s, itemCode, sku);
  const attrs = [v?.size, v?.color].filter(Boolean).join(" ");
  return `#${itemCode} ${attrs || sku}`;
}

function nameOf(s: EngineState, buyerKey: string): string {
  return s.buyers[buyerKey]?.buyer.displayName ?? buyerKey;
}

type VariantMatch = { ok: true; sku: string } | { ok: false; reason: string };

export function resolveVariant(item: ItemState | ShowItem, want: { sku?: string; size?: string; color?: string }): VariantMatch {
  if (want.sku) {
    return item.variants.some((v) => v.sku === want.sku)
      ? { ok: true, sku: want.sku }
      : { ok: false, reason: `#${item.code} has no variant ${want.sku}` };
  }
  const size = want.size ? normalizeSize(want.size) : undefined;
  const color = want.color ? normalizeColor(want.color) : undefined;
  const matches = item.variants.filter(
    (v) =>
      (!size || !v.size || normalizeSize(v.size) === size) && (!color || !v.color || normalizeColor(v.color) === color),
  );
  const describe = (vs: typeof item.variants) =>
    vs.map((v) => [v.size, v.color].filter(Boolean).join(" ") || v.sku).join(", ");
  if (matches.length === 1) return { ok: true, sku: matches[0]!.sku };
  const asked = [size, color].filter(Boolean).join(" ") || "no size or colour";
  if (matches.length === 0) return { ok: false, reason: `#${item.code} has no ${asked} variant (has ${describe(item.variants)})` };
  return { ok: false, reason: `#${item.code} is ambiguous for ${asked}: ${describe(matches)}` };
}

function normQty(q: number | undefined): number {
  if (q === undefined || !Number.isFinite(q)) return 1;
  return Math.min(MAX_QTY_PER_CLAIM, Math.max(1, Math.floor(q)));
}

function capViolation(ctx: Ctx, buyerKey: string, addPrices: number[], exclude: ReadonlySet<string> = new Set()): string | undefined {
  const s = ctx.draft;
  const x = exposure(s, buyerKey, addPrices, exclude);
  const maxUnits = s.config.cap.maxUnits;
  if (maxUnits !== undefined && x.units > maxUnits) return `over unit cap: ${x.units} units vs cap ${maxUnits}`;
  const capCents = effectiveCapCents(s, buyerKey);
  if (capCents !== undefined && x.totalCents > capCents) {
    return `over cap: cart would be ${money(ctx, x.totalCents)} (items ${money(ctx, x.subtotalCents)} + shipping ${money(ctx, x.shippingCents)}) vs cap ${money(ctx, capCents)}`;
  }
  return undefined;
}

/**
 * Units of one claim are granted in order, so any granted subset is a prefix. Check each prefix:
 * with a free-shipping threshold, fewer units can cost more than all of them.
 */
function claimCapViolation(ctx: Ctx, buyerKey: string, priceCents: number, qty: number, exclude?: ReadonlySet<string>): string | undefined {
  for (let k = 1; k <= qty; k++) {
    const over = capViolation(ctx, buyerKey, Array<number>(k).fill(priceCents), exclude);
    if (over) return over;
  }
  return undefined;
}

// ---------- allocation ----------

function grant(ctx: Ctx, u: Unit, opts: { promoted: boolean; final?: boolean; preempted?: string }, why: string): void {
  const s = ctx.draft;
  const pass = hasPass(s, u.buyerKey);
  const leaseExpiresAt = pass ? undefined : ctx.now + s.config.leaseMs;
  const tail = pass ? "Claim Pass: auto-confirmed" : `pay-now hold until ${fmtTs(leaseExpiresAt!)}`;
  emit(ctx, {
    type: "unitGranted",
    unitId: u.id,
    status: pass ? "confirmed" : "held",
    via: pass ? "claim-pass" : "pay-now",
    settleUntil: opts.final ? ctx.now : ctx.now + s.config.settleWindowMs,
    ...(leaseExpiresAt !== undefined ? { leaseExpiresAt } : {}),
    promoted: opts.promoted,
    ...(opts.preempted ? { preempted: opts.preempted } : {}),
    reason: `${why}; ${tail}`,
  });
}

/** Grants one unit, pre-empts a later provisional holder, or queues it. Never oversells. */
function allocate(ctx: Ctx, u: Unit, final = false): void {
  const s = ctx.draft;
  const what = label(s, u.itemCode, u.sku);
  const free = available(s, u.itemCode, u.sku);
  if (free > 0) {
    grant(ctx, u, { promoted: false, final }, `granted ${what} to ${nameOf(s, u.buyerKey)}: unit free (${free - 1} left), platformTs ${fmtTs(u.key.ts)}`);
    return;
  }

  const holders = unitsWhere(
    s,
    (h) => h.itemCode === u.itemCode && h.sku === u.sku && (h.status === "held" || h.status === "confirmed"),
  ).sort((a, b) => compareKeys(a.key, b.key));
  const later = holders.filter((h) => compareKeys(h.key, u.key) > 0);
  const provisional = later.filter(
    (h) => !h.paid && !h.cartId && h.settleUntil !== undefined && ctx.now < h.settleUntil,
  );

  const victim = provisional[provisional.length - 1];
  if (victim && !final) {
    const lag = ctx.now - (victim.grantedAt ?? ctx.now);
    emit(ctx, {
      type: "unitWaitlisted",
      unitId: victim.id,
      cause: "preempted",
      by: u.id,
      reason: `pre-empted on ${what}: ${nameOf(s, u.buyerKey)} platformTs ${fmtTs(u.key.ts)} precedes ${nameOf(s, victim.buyerKey)} ${fmtTs(victim.key.ts)}; arrived ${lag}ms after the grant, inside the ${s.config.settleWindowMs}ms settle window`,
    });
    grant(
      ctx,
      u,
      { promoted: false, preempted: victim.id },
      `granted ${what} to ${nameOf(s, u.buyerKey)}: earliest platformTs ${fmtTs(u.key.ts)} vs ${fmtTs(victim.key.ts)}`,
    );
    return;
  }

  const ahead = waitlist(s, u.itemCode, u.sku).filter((w) => compareKeys(w.key, u.key) < 0).length;
  const first = later[0];
  const latestHolder = holders[holders.length - 1];
  const reason = first
    ? `waitlisted #${ahead + 1} for ${what}: platformTs ${fmtTs(u.key.ts)} precedes holder ${fmtTs(first.key.ts)}, but that grant is final (settle window closed or paid)`
    : `waitlisted #${ahead + 1} for ${what}: sold out; latest holder platformTs ${latestHolder ? fmtTs(latestHolder.key.ts) : "n/a"} vs ${fmtTs(u.key.ts)}`;
  emit(ctx, { type: "unitWaitlisted", unitId: u.id, cause: "sold-out", reason });
}

/** Fills free units from the waitlist head, routing heads that would break their cap to review. */
function promote(ctx: Ctx, itemCode: string, sku: string): void {
  const s = ctx.draft;
  for (;;) {
    if (available(s, itemCode, sku) <= 0) return;
    const head = waitlist(s, itemCode, sku)[0];
    if (!head) return;
    const over = head.capExempt ? undefined : capViolation(ctx, head.buyerKey, [head.priceCents]);
    if (over) {
      emit(ctx, { type: "unitReleased", unitId: head.id, cause: "to-review", refundDue: false, reason: `waitlist promotion blocked: ${over}` });
      openReview(ctx, buyerOf(s, head.buyerKey), "promotion-over-cap", `promotion of ${label(s, itemCode, sku)} blocked: ${over}`, {
        kind: "claim",
        itemCode,
        sku,
        qty: 1,
        key: head.key,
      });
      continue;
    }
    grant(ctx, head, { promoted: true }, `promoted ${label(s, itemCode, sku)} to ${nameOf(s, head.buyerKey)}: waitlist head, platformTs ${fmtTs(head.key.ts)}`);
  }
}

function promoteAll(ctx: Ctx, units: Unit[]): void {
  const seen = new Set<string>();
  for (const u of units) {
    const k = `${u.itemCode}\u0000${u.sku}`;
    if (seen.has(k)) continue;
    seen.add(k);
    promote(ctx, u.itemCode, u.sku);
  }
}

function expireLeases(ctx: Ctx): void {
  const due = unitsWhere(ctx.draft, (u) => u.status === "held" && u.leaseExpiresAt !== undefined && u.leaseExpiresAt <= ctx.now).sort(
    (a, b) => a.leaseExpiresAt! - b.leaseExpiresAt! || compareKeys(a.key, b.key),
  );
  for (const u of due) {
    emit(ctx, {
      type: "unitReleased",
      unitId: u.id,
      cause: "lease-expired",
      refundDue: false,
      reason: `pay-now lease on ${label(ctx.draft, u.itemCode, u.sku)} lapsed unpaid at ${fmtTs(u.leaseExpiresAt!)}`,
    });
  }
  promoteAll(ctx, due);
}

function openReview(ctx: Ctx, buyer: BuyerRef, cause: ReviewCause, reason: string, request: ReviewRequest, commentId?: string): void {
  emit(ctx, {
    type: "reviewOpened",
    reviewId: `R${ctx.draft.counters.review + 1}`,
    buyer,
    cause,
    request,
    reason: `needs review (${cause}): ${reason}`,
    ...(commentId ? { commentId } : {}),
  });
}

function acceptClaim(
  ctx: Ctx,
  buyer: BuyerRef,
  item: ItemState,
  sku: string,
  qty: number,
  key: ClaimKey,
  opts: DispatchOpts & { kind: string; final?: boolean },
): Unit[] {
  const s = ctx.draft;
  const claimId = `C${s.counters.claim + 1}`;
  const unitIds = Array.from({ length: qty }, (_, n) => `${claimId}#${n}`);
  emit(ctx, {
    type: "claimAccepted",
    claimId,
    buyer,
    itemCode: item.code,
    sku,
    unitIds,
    key,
    priceCents: item.priceCents,
    source: opts.source,
    capExempt: opts.source !== "comment",
    ...(opts.commentId ? { commentId: opts.commentId } : {}),
    reason: `${opts.kind} ${qty}x ${label(s, item.code, sku)} by ${buyer.displayName} at platformTs ${fmtTs(key.ts)} (${opts.source})`,
  });
  const units = unitIds.map((id) => s.units[id]!);
  for (const u of units) allocate(ctx, u, opts.final);
  return units;
}

// ---------- intents ----------

function onClaim(ctx: Ctx, buyer: BuyerRef, req: ReviewRequest, opts: DispatchOpts): void {
  const s = ctx.draft;
  if (!req.itemCode) {
    openReview(ctx, buyer, "no-item", "the comment names no item and none could be inferred", req, opts.commentId);
    return;
  }
  const item = s.items[req.itemCode];
  if (!item) {
    if (opts.source === "comment" && s.phase === "live" && opts.commentId) {
      emit(ctx, {
        type: "claimParked",
        commentId: opts.commentId,
        buyer,
        request: req,
        reason: `#${req.itemCode} is not listed yet; parked at platformTs ${fmtTs(req.key.ts)} until it is`,
      });
      return;
    }
    openReview(ctx, buyer, "unknown-item", `#${req.itemCode} is not listed`, req, opts.commentId);
    return;
  }
  const match = resolveVariant(item, req);
  if (!match.ok) {
    openReview(ctx, buyer, "ambiguous-variant", match.reason, req, opts.commentId);
    return;
  }
  const qty = normQty(req.qty);
  if (!opts.bypassCap) {
    const over = claimCapViolation(ctx, buyer.buyerKey, item.priceCents, qty);
    if (over) {
      openReview(ctx, buyer, "over-cap", over, req, opts.commentId);
      return;
    }
  }
  acceptClaim(ctx, buyer, item, match.sku, qty, req.key, { ...opts, kind: req.kind });
}

function liveUnitsOf(s: EngineState, buyerKey: string): Unit[] {
  return unitsWhere(
    s,
    (u) => u.buyerKey === buyerKey && !u.cartId && (u.status === "waitlisted" || u.status === "held" || u.status === "confirmed"),
  );
}

function latestClaimUnits(units: Unit[]): Unit[] {
  if (!units.length) return [];
  const latest = units.reduce((m, u) => (compareKeys(u.key, m.key) > 0 ? u : m));
  return units.filter((u) => u.claimId === latest.claimId);
}

function matchesVariantFilter(s: EngineState, u: Unit, size?: string, color?: string): boolean {
  const v = variantOf(s, u.itemCode, u.sku);
  if (size && v?.size && normalizeSize(v.size) !== normalizeSize(size)) return false;
  if (color && v?.color && normalizeColor(v.color) !== normalizeColor(color)) return false;
  return true;
}

function nothingToDo(ctx: Ctx, buyer: BuyerRef, opts: DispatchOpts, kind: "cancel" | "change", reason: string): void {
  if (opts.commentId) emit(ctx, { type: "intentIgnored", commentId: opts.commentId, buyer, kind, reason });
  else reject(ctx, "approveReview", reason, { buyer });
}

function onCancel(ctx: Ctx, buyer: BuyerRef, req: ReviewRequest, opts: DispatchOpts): void {
  const s = ctx.draft;
  let mine = liveUnitsOf(s, buyer.buyerKey);
  if (req.itemCode) {
    mine = mine.filter((u) => u.itemCode === req.itemCode && matchesVariantFilter(s, u, req.size, req.color));
  } else {
    mine = latestClaimUnits(mine);
  }
  if (!mine.length) {
    nothingToDo(ctx, buyer, opts, "cancel", `cancel ignored: ${buyer.displayName} holds nothing${req.itemCode ? ` on #${req.itemCode}` : ""}`);
    return;
  }

  const unpaid = mine
    .filter((u) => !u.paid)
    .sort((a, b) => Number(b.status === "waitlisted") - Number(a.status === "waitlisted") || compareKeys(b.key, a.key));
  const paid = mine.filter((u) => u.paid);
  const wanted = req.qty !== undefined ? normQty(req.qty) : mine.length;
  const release = unpaid.slice(0, wanted);
  for (const u of release) {
    emit(ctx, {
      type: "unitReleased",
      unitId: u.id,
      cause: "buyer-cancel",
      refundDue: false,
      ...(opts.commentId ? { commentId: opts.commentId } : {}),
      reason: `cancelled by ${buyer.displayName}: ${label(s, u.itemCode, u.sku)} (was ${u.status})${req.text ? ` — "${req.text}"` : ""}`,
    });
  }
  const remaining = Math.min(wanted - release.length, paid.length);
  if (remaining > 0) {
    openReview(
      ctx,
      buyer,
      "paid-cancel",
      `${remaining} unit(s) already paid through pay-now; releasing them needs a refund`,
      { ...req, unitIds: paid.slice(0, remaining).map((u) => u.id) },
      release.length ? undefined : opts.commentId,
    );
  }
  promoteAll(ctx, release);
}

function onChange(ctx: Ctx, buyer: BuyerRef, req: ReviewRequest, opts: DispatchOpts): void {
  const s = ctx.draft;
  const live = liveUnitsOf(s, buyer.buyerKey);
  const itemCode = req.itemCode ?? latestClaimUnits(live)[0]?.itemCode;
  if (!itemCode) {
    openReview(ctx, buyer, "no-item", "change names no item and the buyer holds nothing", req, opts.commentId);
    return;
  }
  const item = s.items[itemCode];
  if (!item) {
    openReview(ctx, buyer, "unknown-item", `#${itemCode} is not listed`, req, opts.commentId);
    return;
  }
  const mine = live.filter((u) => u.itemCode === itemCode);
  if (!mine.length) {
    onClaim(ctx, buyer, { ...req, kind: "claim", itemCode }, opts);
    return;
  }
  const base = variantOf(s, itemCode, latestClaimUnits(mine)[0]!.sku);
  const match = resolveVariant(item, req.sku ? { sku: req.sku } : { size: req.size ?? base?.size, color: req.color ?? base?.color });
  if (!match.ok) {
    openReview(ctx, buyer, "ambiguous-variant", match.reason, req, opts.commentId);
    return;
  }
  const old = mine.filter((u) => u.sku !== match.sku);
  if (!old.length) {
    nothingToDo(ctx, buyer, opts, "change", `change ignored: ${buyer.displayName} is already on ${label(s, itemCode, match.sku)}`);
    return;
  }
  const n = req.qty !== undefined ? normQty(req.qty) : old.length;
  const target = label(s, itemCode, match.sku);
  if (old.some((u) => u.paid)) {
    openReview(ctx, buyer, "change-unavailable", `change to ${target} touches a paid unit`, { ...req, itemCode, sku: match.sku }, opts.commentId);
    return;
  }
  const free = available(s, itemCode, match.sku);
  if (free < n) {
    openReview(ctx, buyer, "change-unavailable", `change to ${target} needs ${n}, ${free} free`, { ...req, itemCode, sku: match.sku }, opts.commentId);
    return;
  }
  if (!opts.bypassCap) {
    const over = claimCapViolation(ctx, buyer.buyerKey, item.priceCents, n, new Set(old.map((u) => u.id)));
    if (over) {
      openReview(ctx, buyer, "over-cap", over, { ...req, itemCode, sku: match.sku }, opts.commentId);
      return;
    }
  }
  for (const u of old) {
    emit(ctx, {
      type: "unitReleased",
      unitId: u.id,
      cause: "changed",
      refundDue: false,
      reason: `${buyer.displayName} changed ${label(s, u.itemCode, u.sku)} to ${target}`,
    });
  }
  acceptClaim(ctx, buyer, item, match.sku, n, req.key, { ...opts, kind: "change" });
  promoteAll(ctx, old);
}

function dispatch(ctx: Ctx, buyer: BuyerRef, req: ReviewRequest, opts: DispatchOpts): void {
  if (req.kind === "cancel") onCancel(ctx, buyer, req, opts);
  else if (req.kind === "change") onChange(ctx, buyer, req, opts);
  else onClaim(ctx, buyer, req, opts);
}

// ---------- command handlers ----------

function handle(ctx: Ctx, cmd: Command): void {
  const s = ctx.draft;
  switch (cmd.type) {
    case "tick":
      return;

    case "listItem": {
      const problem = validateItem(cmd.item, s);
      if (problem) return reject(ctx, cmd.type, problem);
      const { item } = cmd;
      const variants = item.variants.map((v) => `${[v.size, v.color].filter(Boolean).join(" ") || v.sku} x${v.qty}`).join(", ");
      emit(ctx, { type: "itemListed", item: structuredClone(item), reason: `listed #${item.code} "${item.title}" at ${money(ctx, item.priceCents)}: ${variants}` });
      const parked = s.parked.filter((p) => p.request.itemCode === item.code).sort((a, b) => compareKeys(a.request.key, b.request.key));
      for (const p of parked) {
        onClaim(ctx, buyerOf(s, p.buyerKey), p.request, { source: "comment", commentId: p.commentId, bypassCap: false });
      }
      return;
    }

    case "updateInventory": {
      const item = s.items[cmd.itemCode];
      if (!item) return reject(ctx, cmd.type, `#${cmd.itemCode} is not listed`);
      if (!Number.isInteger(cmd.qty) || cmd.qty < 0) return reject(ctx, cmd.type, `qty must be a non-negative integer, got ${cmd.qty}`);
      const v = item.variants.find((x) => x.sku === cmd.sku);
      if (!v) {
        const added = { sku: cmd.sku, qty: cmd.qty, ...(cmd.size ? { size: cmd.size } : {}), ...(cmd.color ? { color: cmd.color } : {}) };
        emit(ctx, { type: "inventoryUpdated", itemCode: item.code, sku: cmd.sku, qty: cmd.qty, prevQty: 0, added, reason: `added variant ${cmd.sku} to #${item.code} x${cmd.qty}` });
        return;
      }
      if (v.qty === cmd.qty) return reject(ctx, cmd.type, `${label(s, item.code, v.sku)} already has qty ${cmd.qty}`);
      const what = label(s, item.code, v.sku);
      const prevQty = v.qty;
      const over = committed(s, item.code, v.sku) - cmd.qty;
      if (over > 0) {
        const bumpable = unitsWhere(
          s,
          (u) => u.itemCode === item.code && u.sku === v.sku && (u.status === "held" || u.status === "confirmed") && !u.paid && !u.cartId,
        ).sort((a, b) => compareKeys(b.key, a.key));
        if (bumpable.length < over) {
          return reject(ctx, cmd.type, `cannot cut ${what} to ${cmd.qty}: ${committed(s, item.code, v.sku) - bumpable.length} units are paid or billed`);
        }
        for (const u of bumpable.slice(0, over)) {
          emit(ctx, { type: "unitWaitlisted", unitId: u.id, cause: "bumped", reason: `bumped to waitlist: ${what} cut from ${prevQty} to ${cmd.qty}, latest claim (platformTs ${fmtTs(u.key.ts)}) goes first` });
        }
      }
      emit(ctx, { type: "inventoryUpdated", itemCode: item.code, sku: v.sku, qty: cmd.qty, prevQty, reason: `${what} qty ${prevQty} -> ${cmd.qty}` });
      promote(ctx, item.code, v.sku);
      return;
    }

    case "applyIntent": {
      const { comment, intent } = cmd;
      const n = intent.intentIndex ?? 0;
      const commentId = intentKey(comment.id, n);
      if (s.seenComments[commentId]) return;
      const buyer = buyerFromComment(comment);
      if (intent.commentId !== comment.id) return reject(ctx, cmd.type, `intent ${intent.commentId} does not belong to comment ${comment.id}`, { buyer });
      if (!Number.isFinite(comment.platformTs)) return reject(ctx, cmd.type, `comment ${comment.id} has no usable platformTs`, { buyer });
      if (s.phase !== "live") return reject(ctx, cmd.type, `show has ended; "${comment.text}" not applied`, { commentId, buyer });
      if (intent.kind === "question" || intent.kind === "other") {
        emit(ctx, { type: "intentIgnored", commentId, buyer, kind: intent.kind, reason: `${intent.kind}: not a claim ("${comment.text}")` });
        return;
      }
      const req: ReviewRequest = {
        kind: intent.kind,
        key: { ts: comment.platformTs, id: comment.id, n },
        confidence: intent.confidence,
        text: comment.text,
        ...(intent.itemCode ? { itemCode: intent.itemCode } : {}),
        ...(intent.size ? { size: intent.size } : {}),
        ...(intent.color ? { color: intent.color } : {}),
        ...(intent.qty !== undefined ? { qty: intent.qty } : {}),
      };
      if (!(intent.confidence >= s.config.confidenceThreshold)) {
        const why = `confidence ${intent.confidence.toFixed(2)} below ${s.config.confidenceThreshold.toFixed(2)} (${intent.method}) on "${comment.text}"`;
        openReview(ctx, buyer, "low-confidence", why, req, commentId);
        return;
      }
      if (intent.kind === "change" && intent.fromItemCode && intent.itemCode && intent.fromItemCode !== intent.itemCode) {
        // A cross-item swap is a claim on the new item plus a release of the old one; the buyer asked to give it up either way.
        dispatch(ctx, buyer, { ...req, kind: "claim" }, { source: "comment", commentId, bypassCap: false });
        const { size: _size, color: _color, qty: _qty, ...rest } = req;
        dispatch(ctx, buyer, { ...rest, kind: "cancel", itemCode: intent.fromItemCode }, { source: "comment", commentId, bypassCap: false });
        return;
      }
      dispatch(ctx, buyer, req, { source: "comment", commentId, bypassCap: false });
      return;
    }

    case "saveClaimPass": {
      emit(ctx, {
        type: "claimPassSaved",
        buyer: cmd.buyer,
        ...(cmd.capCents !== undefined ? { capCents: cmd.capCents } : {}),
        reason: `${cmd.buyer.displayName} saved a Claim Pass${cmd.capCents !== undefined ? ` capped at ${money(ctx, cmd.capCents)} per show` : ""}`,
      });
      for (const u of unitsWhere(s, (x) => x.buyerKey === cmd.buyer.buyerKey && x.status === "held")) {
        emit(ctx, { type: "unitConfirmed", unitId: u.id, via: "claim-pass", reason: `${label(s, u.itemCode, u.sku)} confirmed: Claim Pass saved before the lease lapsed` });
      }
      return;
    }

    case "revokeClaimPass": {
      if (!hasPass(s, cmd.buyerKey)) return reject(ctx, cmd.type, `${cmd.buyerKey} has no Claim Pass`);
      emit(ctx, { type: "claimPassRevoked", buyerKey: cmd.buyerKey, reason: `${nameOf(s, cmd.buyerKey)} revoked the Claim Pass; open claims fall back to pay-now` });
      const lease = ctx.now + s.config.leaseMs;
      for (const u of unitsWhere(s, (x) => x.buyerKey === cmd.buyerKey && x.status === "confirmed" && x.via === "claim-pass" && !x.cartId)) {
        emit(ctx, { type: "unitReverted", unitId: u.id, leaseExpiresAt: lease, reason: `${label(s, u.itemCode, u.sku)} back on pay-now until ${fmtTs(lease)}` });
      }
      return;
    }

    case "confirmPayment": {
      if (!cmd.unitIds.length) return reject(ctx, cmd.type, "no units given");
      for (const id of cmd.unitIds) {
        const u = s.units[id];
        if (!u) return reject(ctx, cmd.type, `unknown unit ${id}; do not capture`);
        if (u.status !== "held") {
          const why =
            u.status === "released" && u.releaseCause === "lease-expired"
              ? `lease on ${id} lapsed; do not capture`
              : `${id} is ${u.status}${u.paid ? " (already paid)" : ""}; do not capture`;
          return reject(ctx, cmd.type, why);
        }
      }
      for (const id of cmd.unitIds) {
        const u = s.units[id]!;
        emit(ctx, {
          type: "unitConfirmed",
          unitId: id,
          via: "payment",
          ...(cmd.orderId ? { orderId: cmd.orderId } : {}),
          reason: `${label(s, u.itemCode, u.sku)} paid by ${nameOf(s, u.buyerKey)} before lease end ${fmtTs(u.leaseExpiresAt!)}`,
        });
      }
      return;
    }

    case "extendHolds": {
      if (!cmd.unitIds.length) return reject(ctx, cmd.type, "no units given");
      for (const id of cmd.unitIds) {
        const u = s.units[id];
        if (!u) return reject(ctx, cmd.type, `unknown unit ${id}`);
        if (u.status !== "held" || u.paid) return reject(ctx, cmd.type, `${id} is ${u.status}${u.paid ? " (already paid)" : ""}, not an unpaid hold`);
      }
      for (const id of cmd.unitIds) {
        const u = s.units[id]!;
        if (u.leaseExpiresAt !== undefined && u.leaseExpiresAt >= cmd.until) continue;
        emit(ctx, {
          type: "leaseExtended",
          unitId: id,
          leaseExpiresAt: cmd.until,
          reason: `${label(s, u.itemCode, u.sku)} held for ${nameOf(s, u.buyerKey)} until ${new Date(cmd.until).toISOString().slice(0, 10)} ${fmtTs(cmd.until)}${cmd.note ? `: ${cmd.note}` : ""}`,
        });
      }
      return;
    }

    case "sellerGrant": {
      const item = s.items[cmd.itemCode];
      if (!item || !variantOf(s, cmd.itemCode, cmd.sku)) return reject(ctx, cmd.type, `no variant ${cmd.sku} on #${cmd.itemCode}`);
      const qty = normQty(cmd.qty);
      const free = available(s, cmd.itemCode, cmd.sku);
      if (free < qty) return reject(ctx, cmd.type, `only ${free} of ${label(s, cmd.itemCode, cmd.sku)} free; seller grant of ${qty} refused`);
      const key = { ts: ctx.now, id: `seller:C${s.counters.claim + 1}`, n: 0 };
      acceptClaim(ctx, cmd.buyer, item, cmd.sku, qty, key, { source: "seller", bypassCap: true, kind: "seller grant", final: true });
      return;
    }

    case "sellerRevoke": {
      const u = s.units[cmd.unitId];
      if (!u || !(u.status === "held" || u.status === "confirmed" || u.status === "waitlisted")) {
        return reject(ctx, cmd.type, `unit ${cmd.unitId} is not live`);
      }
      if (u.cartId) return reject(ctx, cmd.type, `unit ${cmd.unitId} is billed in ${u.cartId}`);
      emit(ctx, {
        type: "unitReleased",
        unitId: u.id,
        cause: "seller-revoke",
        refundDue: u.paid,
        reason: `seller revoked ${label(s, u.itemCode, u.sku)} from ${nameOf(s, u.buyerKey)}${cmd.note ? `: ${cmd.note}` : ""}${u.paid ? " (refund due)" : ""}`,
      });
      promote(ctx, u.itemCode, u.sku);
      return;
    }

    case "sellerReassign": {
      const u = s.units[cmd.unitId];
      if (!u || !(u.status === "held" || u.status === "confirmed")) return reject(ctx, cmd.type, `unit ${cmd.unitId} is not held`);
      if (u.cartId) return reject(ctx, cmd.type, `unit ${cmd.unitId} is billed in ${u.cartId}`);
      if (u.paid) return reject(ctx, cmd.type, `unit ${cmd.unitId} was paid by ${nameOf(s, u.buyerKey)}; revoke and refund instead`);
      if (u.buyerKey === cmd.to.buyerKey) return reject(ctx, cmd.type, `unit ${cmd.unitId} already belongs to ${cmd.to.displayName}`);
      const pass = hasPass(s, cmd.to.buyerKey);
      const leaseExpiresAt = pass ? undefined : ctx.now + s.config.leaseMs;
      emit(ctx, {
        type: "unitReassigned",
        unitId: u.id,
        from: u.buyerKey,
        to: cmd.to,
        status: pass ? "confirmed" : "held",
        via: pass ? "claim-pass" : "pay-now",
        ...(leaseExpiresAt !== undefined ? { leaseExpiresAt } : {}),
        refundDue: false,
        reason: `seller reassigned ${label(s, u.itemCode, u.sku)} from ${nameOf(s, u.buyerKey)} to ${cmd.to.displayName}${cmd.note ? `: ${cmd.note}` : ""}`,
      });
      return;
    }

    case "approveReview": {
      const r = s.reviews[cmd.reviewId];
      if (!r || r.status !== "pending") return reject(ctx, cmd.type, `review ${cmd.reviewId} is not pending`);
      const buyer = buyerOf(s, r.buyerKey);
      const patch = cmd.patch ?? {};
      const req: ReviewRequest = { ...r.request };
      if (patch.itemCode !== undefined) req.itemCode = patch.itemCode;
      if (patch.size !== undefined) req.size = patch.size;
      if (patch.color !== undefined) req.color = patch.color;
      if (patch.qty !== undefined) req.qty = patch.qty;
      if (patch.sku !== undefined) req.sku = patch.sku;
      else if (patch.itemCode !== undefined || patch.size !== undefined || patch.color !== undefined) delete req.sku;

      if (r.cause === "paid-cancel") {
        emit(ctx, { type: "reviewResolved", reviewId: r.id, decision: "approved", reason: `seller approved refund-cancel for ${buyer.displayName}` });
        const units = (r.request.unitIds ?? []).map((id) => s.units[id]!).filter((u) => u && !u.cartId && (u.status === "confirmed" || u.status === "held"));
        for (const u of units) {
          emit(ctx, { type: "unitReleased", unitId: u.id, cause: "buyer-cancel", refundDue: u.paid, reason: `seller approved cancel of paid ${label(s, u.itemCode, u.sku)}; refund due` });
        }
        promoteAll(ctx, units);
        return;
      }

      if (req.kind === "claim" || req.kind === "waitlist") {
        const item = req.itemCode ? s.items[req.itemCode] : undefined;
        if (!item) return reject(ctx, cmd.type, `approve ${r.id}: ${req.itemCode ? `#${req.itemCode} is not listed` : "set itemCode"}`);
        const match = resolveVariant(item, req);
        if (!match.ok) return reject(ctx, cmd.type, `approve ${r.id}: ${match.reason}; pass sku`);
        req.sku = match.sku;
      }
      emit(ctx, {
        type: "reviewResolved",
        reviewId: r.id,
        decision: "approved",
        ...(cmd.patch ? { patch: cmd.patch } : {}),
        reason: `seller approved ${r.id} (${r.cause}) for ${buyer.displayName}`,
      });
      dispatch(ctx, buyer, req, { source: "review", bypassCap: true, ...(r.commentId ? { commentId: r.commentId } : {}) });
      return;
    }

    case "rejectReview": {
      const r = s.reviews[cmd.reviewId];
      if (!r || r.status !== "pending") return reject(ctx, cmd.type, `review ${cmd.reviewId} is not pending`);
      emit(ctx, { type: "reviewResolved", reviewId: r.id, decision: "rejected", reason: `seller rejected ${r.id} (${r.cause})${cmd.note ? `: ${cmd.note}` : ""}` });
      return;
    }

    case "endShow": {
      if (s.phase !== "live") return reject(ctx, cmd.type, "show already ended");
      emit(ctx, { type: "showEnded", reason: `show ${s.config.showId} ended; new comments are no longer applied` });
      for (const p of [...s.parked]) {
        openReview(ctx, buyerOf(s, p.buyerKey), "never-listed", `#${p.request.itemCode} was never listed`, p.request, p.commentId);
      }
      return;
    }

    case "finalizeCarts": {
      if (s.phase !== "ended") return reject(ctx, cmd.type, "end the show before finalizing carts");
      const carts = buildCarts(s, ctx.now);
      if (!carts.length) return reject(ctx, cmd.type, "no confirmed units waiting to be billed");
      const due = carts.reduce((a, c) => a + c.dueCents, 0);
      emit(ctx, { type: "cartsFinalized", carts, reason: `finalized ${carts.length} cart(s), ${money(ctx, due)} due` });
      return;
    }

    case "recordCharge": {
      const cart = s.carts[cmd.cartId];
      if (!cart || cart.status !== "pending") return reject(ctx, cmd.type, `cart ${cmd.cartId} is not pending`);
      if (cmd.outcome === "completed") {
        emit(ctx, {
          type: "cartCharged",
          cartId: cart.cartId,
          ...(cmd.orderId ? { orderId: cmd.orderId } : {}),
          reason: `charged ${cart.displayName} ${money(ctx, cart.dueCents)} (${cart.invoiceId})`,
        });
        return;
      }
      emit(ctx, { type: "cartDeclined", cartId: cart.cartId, reason: `charge declined for ${cart.displayName} (${cart.invoiceId})${cmd.note ? `: ${cmd.note}` : ""}; Claim Pass suspended` });
      const lease = ctx.now + s.config.declineLeaseMs;
      for (const line of cart.lines) {
        for (const id of line.unitIds) {
          const u = s.units[id]!;
          if (u.paid) continue;
          emit(ctx, { type: "unitReverted", unitId: id, leaseExpiresAt: lease, reason: `${label(s, u.itemCode, u.sku)} on a pay-now link until ${fmtTs(lease)} after the decline` });
        }
      }
      return;
    }
  }
}

function validateItem(item: ShowItem, s: EngineState): string | undefined {
  if (s.phase !== "live") return "show has ended";
  if (!item.code) return "item code is empty";
  if (s.items[item.code]) return `#${item.code} is already listed; use updateInventory`;
  if (!Number.isInteger(item.priceCents) || item.priceCents < 0) return `price must be integer cents, got ${item.priceCents}`;
  if (!item.variants.length) return `#${item.code} has no variants`;
  const skus = new Set<string>();
  for (const v of item.variants) {
    if (!v.sku) return `#${item.code} has a variant without a sku`;
    if (skus.has(v.sku)) return `#${item.code} repeats sku ${v.sku}`;
    skus.add(v.sku);
    if (!Number.isInteger(v.qty) || v.qty < 0) return `${v.sku} qty must be a non-negative integer`;
  }
  return undefined;
}

/** Engine-side id for one intent of a comment: the comment id itself for the first, `<id>#<n>` for the rest. */
export function intentKey(commentId: string, n: number): string {
  return n > 0 ? `${commentId}#${n}` : commentId;
}
