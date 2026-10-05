import { randomUUID } from "node:crypto";
import {
  buildCarts,
  buyerKeyOf,
  createEngine,
  itemBoard,
  makeConfig,
  requestIdFor,
  shippingFor,
  type BuyerRef,
  type Cart,
  type CartChargeInput,
  type ChargeResult,
  type ChatComment,
  type ClaimIntent,
  type Command,
  type EngineConfig,
  type EngineEvent,
  type PaymentsGateway,
  type Platform,
  type ResolverContext,
  type ShowItem,
} from "@claim/core";
import { confirmListing, parseListing, type ListingDraft, type ListingEdits } from "@claim/listing";
import type { LlmClient } from "@claim/llm";
import { readWebhookEvent, type WebhookEvent } from "@claim/paypal";
import * as resolver from "@claim/resolver";
import { DECLINE_PREFIX } from "./payments";
import { buildScript, type HolderHint } from "./scenarios";
import { DEMO_SHOP, DEMO_TRANSCRIPTS } from "./seed";
import { percentile } from "./stats";
import type { ShowRecord, ShowStore } from "./store";
import { connectTwitch, type TwitchConnection } from "./twitch";
import type { ChargeRecord, OrderRecord, ScenarioId, ShowAction, ShowSummary, ShowView, ViewScope, WebhookRecord } from "./types";
import { SCENARIOS } from "./types";
import { buildView, indexEvent, type CommentRecord, type ShowData, type ViewEnv } from "./view";

export interface ShowServiceOptions {
  store: ShowStore;
  gateway: { gateway: PaymentsGateway; label: string };
  llm?: LlmClient;
  now?: () => number;
  /** Clock tick for leases and settle windows. `false` in tests that drive time by hand. */
  tickMs?: number | false;
  /** Coalesces snapshot pushes to subscribers. */
  broadcastMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
  WebSocketImpl?: typeof WebSocket;
}

export type ActionResult = { ok: true; data?: unknown } | { ok: false; error: string; status?: number };

type Listener = (view: ShowView) => void;

interface Show extends ShowData {
  /** Each subscriber with the view scope it receives. */
  listeners: Map<Listener, ViewScope>;
  broadcastTimer?: ReturnType<typeof setTimeout>;
  tickTimer?: ReturnType<typeof setInterval>;
  lastTickAt: number;
  twitchConn?: TwitchConnection;
  twitchLags: number[];
  twitchWindow: number[];
  simCancels: (() => void)[];
}

type ResolveFn = (comment: Pick<ChatComment, "id" | "text">, ctx: ResolverContext, opts: resolver.ResolveOptions) => Promise<ClaimIntent | ClaimIntent[]>;

/** Every intent a comment yields. Prefers resolveAll; tolerates resolve() returning one intent or an array. */
const resolveIntents = async (comment: ChatComment, ctx: ResolverContext, opts: resolver.ResolveOptions): Promise<ClaimIntent[]> => {
  const all = (resolver as Record<string, unknown>).resolveAll as ResolveFn | undefined;
  const out = await (all ?? (resolver.resolve as ResolveFn))(comment, ctx, opts);
  const list = Array.isArray(out) ? out : [out];
  return list.length > 1 ? list.map((intent, i) => ({ ...intent, intentIndex: intent.intentIndex ?? i })) : list;
};

const DEMO_CONFIG: Partial<Omit<EngineConfig, "showId">> = { leaseMs: 5 * 60_000 };
const TWITCH_MAX_PER_SEC = 25;

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const refundKey = (v: unknown): string | undefined => (typeof v === "string" && /^[A-Za-z0-9-]{8,40}$/.test(v) ? v : undefined);

export function newShowId(now: number): string {
  return `show-${now.toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, "0")}`;
}

export function createShowService(opts: ShowServiceOptions) {
  const now = opts.now ?? Date.now;
  const store = opts.store;
  const { gateway, label: paymentsLabel } = opts.gateway;
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  const llm = opts.llm;
  const llmLive = Boolean(llm && llm.provider !== "mock");
  const env: ViewEnv = {
    payments: { mode: gateway.mode, label: paymentsLabel },
    llm: { provider: llm?.provider ?? "none", model: llm?.model ?? "" },
  };
  const shows = new Map<string, Show>();

  // ---------- lifecycle ----------

  function blank(rec: Extract<ShowRecord, { k: "meta" }>, history: EngineEvent[]): Show {
    return {
      showId: rec.showId,
      title: rec.title,
      shopName: rec.shopName,
      createdAt: rec.createdAt,
      engine: createEngine(rec.config, history),
      transcripts: new Map(),
      comments: [],
      byKey: new Map(),
      byUnit: new Map(),
      passes: new Map(),
      orders: new Map(),
      charges: [],
      refunds: [],
      tracking: [],
      webhooks: [],
      twitch: { state: "off", messages: 0 },
      listeners: new Map(),
      lastTickAt: now(),
      twitchLags: [],
      twitchWindow: [],
      simCancels: [],
    };
  }

  /** Rebuilds a show from its log: engine events replay through the engine; the rest is folded in order. */
  function hydrate(records: ShowRecord[]): Show | undefined {
    const meta = records.find((r): r is Extract<ShowRecord, { k: "meta" }> => r.k === "meta");
    if (!meta) return undefined;
    const events = records.flatMap((r) => (r.k === "event" ? [r.e] : []));
    const show = blank(meta, events);
    for (const e of events) indexEvent(show, e);
    for (const r of records) {
      switch (r.k) {
        case "set":
          if (r.startedAt !== undefined) show.startedAt = r.startedAt;
          if (r.streamUrl !== undefined) show.streamUrl = r.streamUrl || undefined;
          if (r.onAir !== undefined) show.onAir = r.onAir;
          break;
        case "item":
          if (r.transcript) show.transcripts.set(r.code, r.transcript);
          break;
        case "comment":
          show.comments.push({ comment: r.comment, intents: r.intents, latencyMs: r.latencyMs });
          break;
        case "pass":
          show.passes.set(r.buyerKey, { vaultId: r.vaultId, customerId: r.customerId, ...(r.capCents !== undefined ? { capCents: r.capCents } : {}), ...(r.setupKey ? { setupKey: r.setupKey } : {}) });
          break;
        case "order":
          show.orders.set(r.order.orderId, r.order);
          break;
        case "charge":
          show.charges.push(r.charge);
          break;
        case "refund":
          show.refunds.push(r.refund);
          break;
        case "tracking":
          show.tracking.push(r.tracking);
          break;
        case "webhook":
          show.webhooks.push(r.hook);
          break;
        case "passRevoked":
          show.passes.delete(r.buyerKey);
          break;
      }
    }
    return show;
  }

  function startClock(show: Show): void {
    if (opts.tickMs === false || show.tickTimer) return;
    show.tickTimer = setInterval(() => tick(show), opts.tickMs ?? 1000);
    show.tickTimer.unref?.();
  }

  function get(showId: string): Show | undefined {
    const cached = shows.get(showId);
    if (cached) return cached;
    const records = store.load(showId);
    if (!records) return undefined;
    const show = hydrate(records);
    if (!show) return undefined;
    shows.set(showId, show);
    startClock(show);
    return show;
  }

  function persist(show: Show, rec: ShowRecord): void {
    store.append(show.showId, rec);
  }

  function exec(show: Show, command: Command, at = now()): EngineEvent[] {
    const events = show.engine.execute(command, at);
    for (const e of events) {
      persist(show, { k: "event", e });
      indexEvent(show, e);
    }
    if (events.length) broadcast(show);
    return events;
  }

  function set(show: Show, patch: { startedAt?: number; streamUrl?: string; onAir?: string }): void {
    persist(show, { k: "set", at: now(), ...patch });
    if (patch.startedAt !== undefined) show.startedAt = patch.startedAt;
    if (patch.streamUrl !== undefined) show.streamUrl = patch.streamUrl || undefined;
    if (patch.onAir !== undefined) show.onAir = patch.onAir;
    broadcast(show);
  }

  function view(show: Show, scope: ViewScope = "public"): ShowView {
    return buildView(show, env, now(), scope);
  }

  function broadcast(show: Show): void {
    if (!show.listeners.size || show.broadcastTimer) return;
    show.broadcastTimer = setTimeout(() => {
      show.broadcastTimer = undefined;
      if (!show.listeners.size) return;
      const views = new Map<ViewScope, ShowView>();
      for (const [fn, scope] of show.listeners) {
        let v = views.get(scope);
        if (!v) views.set(scope, (v = view(show, scope)));
        fn(v);
      }
    }, opts.broadcastMs ?? 80);
  }

  /** Expires leases and repaints when a settle window closes, since that changes what the board shows. */
  function tick(show: Show): void {
    const t = now();
    const events = exec(show, { type: "tick" }, t);
    if (!events.length) {
      const s = show.engine.state;
      const settled = s.unitOrder.some((id) => {
        const u = s.units[id]!;
        return u.settleUntil !== undefined && u.settleUntil > show.lastTickAt && u.settleUntil <= t;
      });
      if (settled) broadcast(show);
    }
    show.lastTickAt = t;
  }

  async function create(input: { title?: string; shopName?: string; seed?: boolean } = {}): Promise<string> {
    const createdAt = now();
    const showId = newShowId(createdAt);
    const meta: Extract<ShowRecord, { k: "meta" }> = {
      k: "meta",
      showId,
      title: str(input.title, 80) ?? "Fall knits drop",
      shopName: str(input.shopName, 60) ?? DEMO_SHOP,
      createdAt,
      config: makeConfig(showId, DEMO_CONFIG),
    };
    store.append(showId, meta);
    const show = blank(meta, []);
    shows.set(showId, show);
    startClock(show);
    if (input.seed) {
      for (const transcript of DEMO_TRANSCRIPTS) {
        const r = await parseListing(transcript, { currency: "USD", existingCodes: show.engine.state.itemOrder });
        if (r.item) addItem(show, r.item, r.transcript, false);
      }
      const first = show.engine.state.itemOrder[0];
      if (first) set(show, { onAir: first });
    }
    return showId;
  }

  function addItem(show: Show, item: ShowItem, transcript: string | undefined, onAir: boolean): EngineEvent[] {
    const events = exec(show, { type: "listItem", item });
    if (events.some((e) => e.type === "itemListed")) {
      persist(show, { k: "item", code: item.code, ...(transcript ? { transcript } : {}) });
      if (transcript) show.transcripts.set(item.code, transcript);
      if (onAir) set(show, { onAir: item.code });
    }
    return events;
  }

  function list(): ShowSummary[] {
    return store
      .list()
      .map((id) => get(id))
      .filter((s): s is Show => Boolean(s))
      .map((s) => ({ showId: s.showId, title: s.title, createdAt: s.createdAt, phase: s.engine.state.phase, items: s.engine.state.itemOrder.length }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---------- ingestion ----------

  function resolverContext(show: Show): ResolverContext {
    const s = show.engine.state;
    const items: ShowItem[] = [...s.itemOrder].reverse().map((code) => {
      const it = s.items[code]!;
      return { code, title: it.title, priceCents: it.priceCents, variants: it.variants.map((v) => ({ ...v })) };
    });
    const current = show.onAir ? items.find((i) => i.code === show.onAir) : undefined;
    return { items, ...(current ? { currentItem: current } : {}) };
  }

  /** ChatComment -> resolver -> one applyIntent per intent. Returns the record the stream shows. */
  async function ingest(show: Show, comment: ChatComment, at?: number): Promise<CommentRecord> {
    const started = performance.now();
    let intents: ClaimIntent[];
    try {
      intents = await resolveIntents(comment, resolverContext(show), { ...(llmLive ? { llm, mode: "auto" as const } : { mode: "rules" as const }) });
    } catch {
      intents = [{ commentId: comment.id, kind: "other", confidence: 0, method: "rule", rationale: "resolver failed" }];
    }
    if (!intents.length) intents = [{ commentId: comment.id, kind: "other", confidence: 0.5, method: "rule", rationale: "no intent" }];
    const latencyMs = Math.round((performance.now() - started) * 100) / 100;
    const rec: CommentRecord = { comment, intents, latencyMs };
    persist(show, { k: "comment", ...rec });
    show.comments.push(rec);
    const t = at ?? now();
    for (const intent of intents) exec(show, { type: "applyIntent", comment, intent }, t);
    broadcast(show);
    return rec;
  }

  function roomComment(show: Show, userId: string, displayName: string, text: string): ChatComment {
    const t = now();
    return { id: `rm-${randomUUID()}`, platform: "room", userId, displayName, text, platformTs: t, receivedTs: t };
  }

  // ---------- simulator ----------

  function simBuyer(user: string): BuyerRef {
    return { buyerKey: buyerKeyOf("simulator", user), displayName: user, platform: "simulator", userId: user };
  }

  async function savePass(show: Show, buyer: BuyerRef, capCents: number | undefined, declines: boolean): Promise<void> {
    const key = declines ? `${DECLINE_PREFIX}${buyer.buyerKey}` : buyer.buyerKey;
    const { setupTokenId } = await gateway.createSetupToken({ buyerKey: key, returnUrl: "about:blank", cancelUrl: "about:blank" });
    const { vaultId, customerId } = await gateway.createPaymentToken(setupTokenId);
    storePass(show, buyer, key, vaultId, customerId, capCents);
  }

  /** Setup tokens waiting for the buyer to approve in PayPal's save session (sandbox only). */
  const pendingPasses = new Map<string, { showId: string; buyer: BuyerRef; capCents?: number; at: number }>();

  async function passSetup(show: Show, buyer: BuyerRef, capCents: number | undefined, origin: string): Promise<{ setupTokenId: string }> {
    const back = `${origin}/live/${show.showId}`;
    const { setupTokenId } = await gateway.createSetupToken({ buyerKey: buyer.buyerKey, returnUrl: back, cancelUrl: back });
    for (const [id, p] of pendingPasses) if (now() - p.at > 30 * 60_000) pendingPasses.delete(id);
    pendingPasses.set(setupTokenId, { showId: show.showId, buyer, ...(capCents !== undefined ? { capCents } : {}), at: now() });
    return { setupTokenId };
  }

  async function passApprove(show: Show, setupTokenId: string): Promise<void> {
    const p = pendingPasses.get(setupTokenId);
    if (!p || p.showId !== show.showId) throw new Error("That PayPal approval has expired. Start the Claim Pass again.");
    const { vaultId, customerId } = await gateway.createPaymentToken(setupTokenId);
    pendingPasses.delete(setupTokenId);
    storePass(show, p.buyer, p.buyer.buyerKey, vaultId, customerId, p.capCents);
  }

  function storePass(show: Show, buyer: BuyerRef, key: string, vaultId: string, customerId: string, capCents: number | undefined): void {
    const pass = { vaultId, customerId, setupKey: key, ...(capCents !== undefined ? { capCents } : {}) };
    persist(show, { k: "pass", buyerKey: buyer.buyerKey, ...pass });
    show.passes.set(buyer.buyerKey, pass);
    exec(show, { type: "saveClaimPass", buyer, ...(capCents !== undefined ? { capCents } : {}) });
  }

  /** A simulated buyer holding an unpaid unit of the on-air item with someone waiting behind it. */
  function holderHint(show: Show): HolderHint | undefined {
    const s = show.engine.state;
    const code = show.onAir;
    if (!code) return undefined;
    const units = s.unitOrder.map((id) => s.units[id]!).filter((u) => u.itemCode === code);
    for (const u of [...units].reverse()) {
      if (!(u.status === "held" || u.status === "confirmed") || u.paid || u.cartId || !u.buyerKey.startsWith("simulator:")) continue;
      if (units.some((w) => w.sku === u.sku && w.status === "waitlisted")) return { user: s.buyers[u.buyerKey]!.buyer.userId ?? u.buyerKey.slice(10), itemCode: code };
    }
    return undefined;
  }

  async function runScenario(show: Show, id: ScenarioId, mode: { instant?: boolean } = {}): Promise<void> {
    if (show.engine.state.phase !== "live") throw new Error("The show has ended; simulations need a live show.");
    const code = show.onAir;
    const item = code ? show.engine.state.items[code] : undefined;
    if (!code || !item) throw new Error("Put an item on air first.");
    if (!show.startedAt) set(show, { startedAt: now() });
    const board = itemBoard(show.engine.state, now());
    const boardItem = board.find((b) => b.code === code)!;
    const others = board.filter((b) => b.code !== code);
    const script = buildScript(id, boardItem, id === "cancel" ? holderHint(show) : undefined, others);

    for (const p of script.passes) {
      const buyer = simBuyer(p.user);
      // A simulated buyer cannot approve a real PayPal window: in sandbox they shop on pay-now instead.
      if (!show.engine.state.buyers[buyer.buyerKey]?.pass && gateway.mode === "mock") await savePass(show, buyer, undefined, Boolean(p.declines));
    }

    const start = now();
    const run = `${start.toString(36)}`;
    const toComment = (line: (typeof script.lines)[number], i: number, receivedTs: number): ChatComment => ({
      id: `sim-${run}-${i}`,
      platform: "simulator" as Platform,
      userId: line.user,
      displayName: line.user,
      text: line.text,
      platformTs: start + line.tsMs,
      receivedTs,
    });

    if (mode.instant) {
      const ordered = script.lines.map((l, i) => ({ l, i })).sort((a, b) => a.l.arriveMs - b.l.arriveMs);
      for (const { l, i } of ordered) await ingest(show, toComment(l, i, start + l.arriveMs), start + l.arriveMs);
      return;
    }

    show.simulation = { scenario: id, label: script.label, startedAt: start };
    broadcast(show);
    const last = Math.max(...script.lines.map((l) => l.arriveMs));
    script.lines.forEach((line, i) => {
      show.simCancels.push(
        schedule(() => {
          void ingest(show, toComment(line, i, now()));
        }, line.arriveMs),
      );
    });
    show.simCancels.push(
      schedule(() => {
        show.simulation = undefined;
        show.simCancels = [];
        broadcast(show);
      }, last + 2500),
    );
  }

  // ---------- twitch ----------

  function setTwitch(show: Show, channel: string | undefined): void {
    show.twitchConn?.close();
    show.twitchConn = undefined;
    if (!channel) {
      show.twitch = { state: "off", messages: show.twitch.messages };
      broadcast(show);
      return;
    }
    const chan = channel.replace(/^#/, "").toLowerCase();
    if (!/^[a-z0-9_]{2,25}$/.test(chan)) throw new Error("A Twitch channel name is 2-25 letters, digits or underscores.");
    show.twitch = { channel: chan, state: "connecting", messages: 0 };
    show.twitchLags = [];
    broadcast(show);
    show.twitchConn = connectTwitch(
      chan,
      {
        onComment(c) {
          const t = now();
          show.twitchWindow = show.twitchWindow.filter((x) => t - x < 1000);
          if (show.twitchWindow.length >= TWITCH_MAX_PER_SEC) return;
          show.twitchWindow.push(t);
          show.twitchLags.push(c.receivedTs - c.platformTs);
          if (show.twitchLags.length > 200) show.twitchLags.shift();
          const p50 = percentile(show.twitchLags, 50);
          show.twitch = { ...show.twitch, state: "live", messages: show.twitch.messages + 1, ...(p50 !== null ? { lagP50Ms: p50 } : {}) };
          void ingest(show, c);
        },
        onState(state, error) {
          if (state === "off") return;
          show.twitch = { ...show.twitch, state, ...(error ? { error } : {}) };
          broadcast(show);
        },
      },
      opts.WebSocketImpl,
    );
  }

  // ---------- payments ----------

  function lineName(show: Show, itemCode: string, sku: string): string {
    const it = show.engine.state.items[itemCode];
    const v = it?.variants.find((x) => x.sku === sku);
    return [`#${itemCode} ${it?.title ?? ""}`.trim(), [v?.size, v?.color].filter(Boolean).join(" ")].filter(Boolean).join(" · ").slice(0, 127);
  }

  /** What is still owed on a cart, as PayPal line items: units paid during the show are left out. */
  function cartInput(show: Show, cart: Cart): CartChargeInput {
    const lines = cart.lines
      .map((l) => ({ name: lineName(show, l.itemCode, l.sku), sku: l.sku, qty: l.qty - Math.round(l.paidCents / Math.max(1, l.unitCents)), unitCents: l.unitCents }))
      .filter((l) => l.qty > 0);
    // Items paid during the show leave only shipping due; PayPal needs at least one line.
    const shippingOnly = !lines.length && cart.shippingCents > 0;
    if (shippingOnly) lines.push({ name: "Combined shipping", sku: "SHIPPING", qty: 1, unitCents: cart.shippingCents });
    return {
      invoiceId: cart.invoiceId,
      requestId: cart.requestId,
      currency: "USD",
      lines,
      shippingCents: shippingOnly ? 0 : cart.shippingCents,
      totalCents: cart.dueCents,
      customId: cart.buyerKey.slice(0, 127),
    };
  }

  function ensureFinalized(show: Show): void {
    const s = show.engine.state;
    if (s.phase === "ended" && buildCarts(s, now()).length) exec(show, { type: "finalizeCarts" });
  }

  function record(show: Show, charge: ChargeRecord): void {
    show.charges.push(charge);
    persist(show, { k: "charge", charge });
  }

  function saveOrder(show: Show, order: OrderRecord): void {
    show.orders.set(order.orderId, order);
    persist(show, { k: "order", order });
    broadcast(show);
  }

  /**
   * One vault charge. A thrown error (vault gone, network) becomes a decline so the cart falls back to
   * pay-now instead of aborting the whole close-out. The mock forgets vaults on restart, so in mock mode
   * a missing vault is re-saved once and retried.
   */
  async function chargeOne(show: Show, buyerKey: string, vaultId: string, input: CartChargeInput): Promise<ChargeResult> {
    try {
      return await gateway.chargeVaulted(vaultId, input);
    } catch (err) {
      const issue = (err as { issue?: string }).issue;
      const prev = show.passes.get(buyerKey);
      if (gateway.mode === "mock" && issue === "INVALID_RESOURCE_ID" && prev) {
        const { setupTokenId } = await gateway.createSetupToken({ buyerKey: prev.setupKey ?? buyerKey, returnUrl: "about:blank", cancelUrl: "about:blank" });
        const fresh = await gateway.createPaymentToken(setupTokenId);
        const pass = { ...prev, vaultId: fresh.vaultId, customerId: fresh.customerId };
        persist(show, { k: "pass", buyerKey, ...pass });
        show.passes.set(buyerKey, pass);
        try {
          const shipTo = input.shipTo ?? (await gateway.walletShipTo(fresh.vaultId));
          return await gateway.chargeVaulted(fresh.vaultId, { ...input, ...(shipTo ? { shipTo } : {}) });
        } catch (again) {
          err = again;
        }
      }
      return { status: "DECLINED", declineCode: (err as { issue?: string }).issue ?? (err instanceof Error ? err.message.slice(0, 80) : "CHARGE_FAILED") };
    }
  }

  async function chargeAll(show: Show): Promise<{ charged: number; declined: number; skipped: number; totalCents: number }> {
    if (show.engine.state.phase !== "ended") throw new Error("End the show before charging carts.");
    ensureFinalized(show);
    const s = show.engine.state;
    const due = s.cartOrder.map((id) => s.carts[id]!).filter((c) => c.status === "pending" && c.chargeMode === "vault");
    let charged = 0;
    let declined = 0;
    let skipped = 0;
    let totalCents = 0;
    for (const cart of due) {
      const pass = show.passes.get(cart.buyerKey);
      if (!pass) {
        skipped += 1;
        continue;
      }
      const shipTo = await gateway.walletShipTo(pass.vaultId);
      const input = { ...cartInput(show, cart), ...(shipTo ? { shipTo } : {}) };
      const result = await chargeOne(show, cart.buyerKey, pass.vaultId, input);
      const ok = result.status === "COMPLETED";
      const shipped = result.shipTo ?? shipTo;
      record(show, {
        cartId: cart.cartId,
        ...(result.orderId ? { orderId: result.orderId } : {}),
        ...(result.captureId ? { captureId: result.captureId } : {}),
        status: result.status,
        ...(result.declineCode ? { declineCode: result.declineCode } : {}),
        amountCents: input.totalCents,
        via: "vault",
        at: now(),
        ...(ok && shipped ? { shipTo: shipped } : {}),
      });
      exec(show, {
        type: "recordCharge",
        cartId: cart.cartId,
        outcome: ok ? "completed" : "declined",
        ...(result.orderId ? { orderId: result.orderId } : {}),
        ...(ok ? {} : { note: result.declineCode ?? result.status }),
      });
      if (ok) {
        charged += 1;
        totalCents += input.totalCents;
      } else declined += 1;
    }
    broadcast(show);
    return { charged, declined, skipped, totalCents };
  }

  function payUrls(show: Show, origin: string) {
    return { returnUrl: `${origin}/pay/${show.showId}`, cancelUrl: `${origin}/live/${show.showId}` };
  }

  async function payNowCart(show: Show, cartId: string, origin: string): Promise<OrderRecord> {
    ensureFinalized(show);
    const cart = show.engine.state.carts[cartId];
    if (!cart || cart.status !== "pending") throw new Error(`Cart ${cartId} has nothing pending.`);
    const input = cartInput(show, cart);
    if (input.totalCents <= 0) throw new Error("Nothing is due on this cart.");
    const order = await gateway.createPayNowOrder(input, payUrls(show, origin));
    const rec: OrderRecord = {
      orderId: order.orderId,
      purpose: "cart",
      buyerKey: cart.buyerKey,
      displayName: cart.displayName,
      cartId,
      amountCents: input.totalCents,
      shippingCents: input.shippingCents,
      lines: input.lines,
      approveUrl: order.approveUrl,
      createdAt: now(),
      status: "open",
    };
    saveOrder(show, rec);
    return rec;
  }

  /** Shipping a supplementary cart would add, the same way the engine combines it with carts already billed. */
  function shippingForHolds(show: Show, buyerKey: string, units: number, subtotal: number): number {
    const s = show.engine.state;
    const billed = s.cartOrder.map((id) => s.carts[id]!).filter((c) => c.buyerKey === buyerKey && c.status !== "declined");
    const pu = billed.reduce((a, c) => a + c.units, 0);
    const ps = billed.reduce((a, c) => a + c.subtotalCents, 0);
    const psh = billed.reduce((a, c) => a + c.shippingCents, 0);
    return Math.max(0, shippingFor(pu + units, ps + subtotal, s.config.shipping) - psh);
  }

  async function payNowHolds(show: Show, buyerKey: string, origin: string): Promise<OrderRecord> {
    const s = show.engine.state;
    const held = s.unitOrder.map((id) => s.units[id]!).filter((u) => u.buyerKey === buyerKey && u.status === "held" && !u.paid);
    if (!held.length) throw new Error("No holds waiting for payment.");
    const lines = new Map<string, { name: string; sku: string; qty: number; unitCents: number }>();
    for (const u of held) {
      const k = `${u.itemCode}\u0000${u.sku}\u0000${u.priceCents}`;
      const l = lines.get(k);
      if (l) l.qty += 1;
      else lines.set(k, { name: lineName(show, u.itemCode, u.sku), sku: u.sku, qty: 1, unitCents: u.priceCents });
    }
    const subtotal = held.reduce((a, u) => a + u.priceCents, 0);
    // During the show only the items are taken; combined shipping is billed once at close-out.
    const shippingCents = s.phase === "ended" ? shippingForHolds(show, buyerKey, held.length, subtotal) : 0;
    const displayName = s.buyers[buyerKey]?.buyer.displayName ?? buyerKey;
    const invoiceId = `${show.showId}-${buyerKey}-H${held.map((u) => u.id).join("-")}`.slice(0, 127);
    const input: CartChargeInput = {
      invoiceId,
      requestId: invoiceId.slice(0, 108),
      currency: "USD",
      lines: [...lines.values()],
      shippingCents,
      totalCents: subtotal + shippingCents,
      customId: buyerKey.slice(0, 127),
    };
    const order = await gateway.createPayNowOrder(input, payUrls(show, origin));
    const rec: OrderRecord = {
      orderId: order.orderId,
      purpose: "holds",
      buyerKey,
      displayName,
      unitIds: held.map((u) => u.id),
      amountCents: input.totalCents,
      shippingCents,
      lines: input.lines,
      approveUrl: order.approveUrl,
      createdAt: now(),
      status: "open",
    };
    saveOrder(show, rec);
    return rec;
  }

  /** Captures in flight, so a double click or a page that auto-captures on PayPal's return sends one capture. */
  const capturing = new Map<string, Promise<OrderRecord>>();

  function capture(show: Show, orderId: string): Promise<OrderRecord> {
    const key = `${show.showId}:${orderId}`;
    const running = capturing.get(key);
    if (running) return running;
    const p = captureOnce(show, orderId).finally(() => capturing.delete(key));
    capturing.set(key, p);
    return p;
  }

  async function captureOnce(show: Show, orderId: string): Promise<OrderRecord> {
    const order = show.orders.get(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}.`);
    if (order.status === "captured") return order;
    if (order.purpose === "holds") {
      const s = show.engine.state;
      const stale = (order.unitIds ?? []).filter((id) => s.units[id]?.status !== "held");
      if (stale.length) {
        const failed = { ...order, status: "failed" as const };
        saveOrder(show, failed);
        throw new Error("A hold on this order lapsed or moved before payment; nothing was captured.");
      }
    }
    const result = await gateway.captureOrder(orderId);
    // Not approved yet is not a failure: the buyer can still approve on PayPal, so the order stays open.
    if (result.status === "PAYER_ACTION_REQUIRED") throw new Error("PayPal has not approved this payment yet. Approve it on PayPal, then come back.");
    if (result.status !== "COMPLETED") {
      saveOrder(show, { ...order, status: "failed" });
      throw new Error(`Capture returned ${result.status}${result.declineCode ? ` (${result.declineCode})` : ""}.`);
    }
    const captured: OrderRecord = { ...order, status: "captured", capturedAt: now() };
    saveOrder(show, captured);

    if (order.purpose === "cart" && order.cartId) {
      record(show, { cartId: order.cartId, orderId, ...(result.captureId ? { captureId: result.captureId } : {}), status: "COMPLETED", amountCents: order.amountCents, via: "pay-now", at: now(), ...(result.shipTo ? { shipTo: result.shipTo } : {}) });
      exec(show, { type: "recordCharge", cartId: order.cartId, outcome: "completed", orderId });
      return captured;
    }

    exec(show, { type: "confirmPayment", unitIds: order.unitIds ?? [], orderId });
    if (show.engine.state.phase === "ended") {
      ensureFinalized(show);
      const s = show.engine.state;
      const cart = [...s.cartOrder].reverse().map((id) => s.carts[id]!).find((c) => c.buyerKey === order.buyerKey && c.status === "pending");
      if (cart && cart.dueCents === order.shippingCents) {
        record(show, { cartId: cart.cartId, orderId, ...(result.captureId ? { captureId: result.captureId } : {}), status: "COMPLETED", amountCents: order.amountCents, via: "pay-now", at: now(), ...(result.shipTo ? { shipTo: result.shipTo } : {}) });
        exec(show, { type: "recordCharge", cartId: cart.cartId, outcome: "completed", orderId });
      }
    }
    return captured;
  }

  function releaseHolds(show: Show, buyerKey: string): number {
    const s = show.engine.state;
    const held = s.unitOrder.map((id) => s.units[id]!).filter((u) => u.buyerKey === buyerKey && u.status === "held" && !u.paid && !u.cartId);
    for (const u of held) exec(show, { type: "sellerRevoke", unitId: u.id, note: "released to the waitlist after a decline" });
    return held.length;
  }

  function lastCapture(show: Show, cartId: string): ChargeRecord | undefined {
    return [...show.charges].reverse().find((c) => c.cartId === cartId && c.status === "COMPLETED" && c.captureId);
  }

  async function refund(show: Show, cartId: string, amountCents: number | undefined, note: string | undefined, clientKey: string | undefined) {
    const charge = lastCapture(show, cartId);
    if (!charge?.captureId) throw new Error("This cart has no captured payment to refund.");
    // The form mints one key per refund it means, so a double-submit replays instead of refunding twice.
    // Without a key, the cart's refund count still collapses calls that overlap.
    const invoiceId = show.engine.state.carts[cartId]?.invoiceId ?? cartId;
    const requestId = requestIdFor(`${invoiceId}-refund-${clientKey ?? show.refunds.filter((x) => x.cartId === cartId).length}`);
    const replay = show.refunds.find((x) => x.requestId === requestId);
    if (replay) return replay;
    const refunded = show.refunds.filter((r) => r.cartId === cartId).reduce((a, r) => a + r.amountCents, 0);
    const left = charge.amountCents - refunded;
    const amount = amountCents ?? left;
    if (!Number.isInteger(amount) || amount <= 0 || amount > left) throw new Error(`Refund must be between $0.01 and ${(left / 100).toFixed(2)}.`);
    const r = await gateway.refundCapture(charge.captureId, amount, note, requestId);
    const dup = show.refunds.find((x) => x.refundId === r.refundId);
    if (dup) return dup;
    const rec = { cartId, refundId: r.refundId, requestId, amountCents: amount, status: r.status, ...(note ? { note } : {}), at: now() };
    show.refunds.push(rec);
    persist(show, { k: "refund", refund: rec });
    broadcast(show);
    return rec;
  }

  async function addTracking(show: Show, cartId: string, carrier: string, trackingNumber: string) {
    const charge = lastCapture(show, cartId);
    if (!charge?.captureId || !charge.orderId) throw new Error("Charge the cart before adding tracking.");
    const { trackerId } = await gateway.addTracking({ orderId: charge.orderId, captureId: charge.captureId, trackingNumber, carrier, notifyPayer: true });
    const rec = { cartId, trackerId, carrier, trackingNumber, at: now() };
    show.tracking.push(rec);
    persist(show, { k: "tracking", tracking: rec });
    broadcast(show);
    return rec;
  }

  // ---------- actions ----------

  function nextCode(show: Show): string {
    const used = new Set(show.engine.state.itemOrder);
    let n = 1;
    while (used.has(String(n))) n += 1;
    return String(n);
  }

  async function act(showId: string, a: ShowAction, ctx: { origin?: string } = {}): Promise<ActionResult> {
    const show = get(showId);
    if (!show) return { ok: false, error: "No such show.", status: 404 };
    const origin = ctx.origin ?? "http://localhost:3011";
    try {
      switch (a.action) {
        case "start":
          if (!show.startedAt) set(show, { startedAt: now() });
          return { ok: true };
        case "end": {
          for (const cancel of show.simCancels) cancel();
          show.simCancels = [];
          show.simulation = undefined;
          setTwitch(show, undefined);
          const events = exec(show, { type: "endShow" });
          const rejected = events.find((e) => e.type === "commandRejected");
          return rejected ? { ok: false, error: rejected.reason } : { ok: true };
        }
        case "setStream": {
          const url = str(a.streamUrl, 300) ?? "";
          if (url && !/^https:\/\//.test(url)) return { ok: false, error: "Paste an https:// video link." };
          set(show, { streamUrl: url });
          return { ok: true };
        }
        case "onAir": {
          if (!show.engine.state.items[a.code]) return { ok: false, error: `#${a.code} is not listed.` };
          set(show, { onAir: a.code });
          return { ok: true };
        }
        case "comment": {
          const userId = str(a.userId, 64);
          const displayName = str(a.displayName, 32);
          const text = str(a.text, 280);
          if (!userId || !displayName || !text) return { ok: false, error: "A comment needs a name and some text." };
          const rec = await ingest(show, roomComment(show, userId, displayName, text));
          return { ok: true, data: { commentId: rec.comment.id, intents: rec.intents, latencyMs: rec.latencyMs } };
        }
        case "parseListing": {
          const transcript = str(a.transcript, 600);
          if (!transcript) return { ok: false, error: "Say or type the item first." };
          const result = await parseListing(
            transcript,
            { currency: "USD", existingCodes: show.engine.state.itemOrder, nextCode: nextCode(show) },
            llmLive ? llm : undefined,
          );
          return { ok: true, data: result };
        }
        case "listItem": {
          const r = confirmListing(a.draft as ListingDraft, (a.edits ?? {}) as ListingEdits);
          if (!r.ok) return { ok: false, error: `Still missing: ${r.missing.join(", ")}.`, status: 422 };
          const events = addItem(show, r.item, str(a.transcript, 600), a.onAir !== false);
          const rejected = events.find((e) => e.type === "commandRejected");
          return rejected ? { ok: false, error: rejected.reason, status: 422 } : { ok: true, data: r.item };
        }
        case "simulate": {
          if (!SCENARIOS.some((s) => s.id === a.scenario)) return { ok: false, error: "Unknown scenario." };
          await runScenario(show, a.scenario);
          return { ok: true };
        }
        case "twitch":
          setTwitch(show, str(a.channel, 40));
          return { ok: true };
        case "review": {
          const cmd: Command =
            a.decision === "approve"
              ? { type: "approveReview", reviewId: a.reviewId, ...(a.patch && Object.keys(a.patch).length ? { patch: a.patch } : {}) }
              : { type: "rejectReview", reviewId: a.reviewId };
          const events = exec(show, cmd);
          const rejected = events.find((e) => e.type === "commandRejected");
          return rejected ? { ok: false, error: rejected.reason, status: 422 } : { ok: true };
        }
        case "savePass":
        case "passSetup": {
          const userId = str(a.userId, 64);
          const displayName = str(a.displayName, 32);
          if (!userId || !displayName) return { ok: false, error: "Join the room with a name first." };
          const cap = typeof a.capCents === "number" && Number.isInteger(a.capCents) && a.capCents > 0 ? a.capCents : undefined;
          const buyer: BuyerRef = { buyerKey: buyerKeyOf("room", userId), displayName, platform: "room", userId };
          if (a.action === "passSetup") return { ok: true, data: await passSetup(show, buyer, cap, origin) };
          // Without buyer approval only the mock can vault; sandbox goes through passSetup and passApprove.
          if (gateway.mode !== "mock") return { ok: false, error: "Approve the Claim Pass in PayPal's window." };
          await savePass(show, buyer, cap, Boolean(a.declines));
          return { ok: true };
        }
        case "passApprove": {
          const id = str(a.setupTokenId, 64);
          if (!id) return { ok: false, error: "Missing the PayPal setup token." };
          await passApprove(show, id);
          return { ok: true };
        }
        case "clientToken":
          return { ok: true, data: { clientToken: await gateway.clientToken() } };
        case "finalize":
          if (show.engine.state.phase !== "ended") return { ok: false, error: "End the show before building carts." };
          ensureFinalized(show);
          return { ok: true };
        case "chargeAll":
          return { ok: true, data: await chargeAll(show) };
        case "payNowCart":
          return { ok: true, data: await payNowCart(show, a.cartId, origin) };
        case "payNowHolds":
          return { ok: true, data: await payNowHolds(show, a.buyerKey, origin) };
        case "releaseHolds":
          return { ok: true, data: { released: releaseHolds(show, a.buyerKey) } };
        case "capture":
          return { ok: true, data: await capture(show, a.orderId) };
        case "refund":
          return { ok: true, data: await refund(show, a.cartId, a.amountCents, str(a.note, 120), refundKey(a.requestId)) };
        case "tracking": {
          const carrier = str(a.carrier, 40);
          const number = str(a.trackingNumber, 60);
          if (!carrier || !number) return { ok: false, error: "Add a carrier and a tracking number." };
          return { ok: true, data: await addTracking(show, a.cartId, carrier, number) };
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: false, error: "Unknown action." };
  }

  // ---------- PayPal webhooks ----------

  /** Event ids already handled in this process; a show's own records cover redeliveries after a restart. */
  const seenEvents = new Set<string>();

  /**
   * One delivery from PayPal. Anything but a 2xx makes PayPal retry, so: 401 for a bad signature, 503
   * when no webhook id is configured, 502 when PayPal could not be asked, and 200 for every genuine
   * event, matched or not, so a delivery for another app's order is not retried for three days.
   */
  async function webhook(headers: Record<string, string | undefined>, rawBody: string): Promise<{ status: number; body: Record<string, unknown> }> {
    let verified: boolean;
    try {
      verified = await gateway.verifyWebhook(headers, rawBody);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: /PAYPAL_WEBHOOK_ID/.test(message) ? 503 : 502, body: { ok: false, error: message } };
    }
    if (!verified) return { status: 401, body: { ok: false, error: "The PayPal signature did not verify." } };
    const event = readWebhookEvent(rawBody);
    if (!event) return { status: 400, body: { ok: false, error: "The body is not a webhook event." } };
    if (seenEvents.has(event.id)) return { status: 200, body: { ok: true, event: event.type, duplicate: true } };
    seenEvents.add(event.id);
    const matched: string[] = [];
    for (const showId of store.list()) {
      const show = get(showId);
      if (show && applyWebhook(show, event)) matched.push(showId);
    }
    return { status: 200, body: { ok: true, event: event.type, matched: matched.length } };
  }

  function applyWebhook(show: Show, e: WebhookEvent): boolean {
    if (show.webhooks.some((h) => h.eventId === e.id)) return false;
    const passHolders = e.vaultId ? [...show.passes].filter(([, p]) => p.vaultId === e.vaultId).map(([buyerKey]) => buyerKey) : [];
    const hit =
      (e.captureId && show.charges.some((c) => c.captureId === e.captureId)) ||
      (e.orderId && (show.orders.has(e.orderId) || show.charges.some((c) => c.orderId === e.orderId))) ||
      passHolders.length > 0;
    if (!hit) return false;
    const hook: WebhookRecord = {
      eventId: e.id,
      type: e.type,
      at: now(),
      ...(e.captureId ? { captureId: e.captureId } : {}),
      ...(e.refundId ? { refundId: e.refundId } : {}),
      ...(e.orderId ? { orderId: e.orderId } : {}),
      ...(e.vaultId ? { vaultId: e.vaultId } : {}),
      summary: hookSummary(e),
    };
    show.webhooks.push(hook);
    persist(show, { k: "webhook", hook });
    if (e.type === "VAULT.PAYMENT-TOKEN.DELETED") {
      for (const buyerKey of passHolders) {
        show.passes.delete(buyerKey);
        persist(show, { k: "passRevoked", buyerKey, at: now() });
        exec(show, { type: "revokeClaimPass", buyerKey });
      }
    }
    broadcast(show);
    return true;
  }

  return {
    create,
    list,
    act,
    webhook,
    view(showId: string, scope: ViewScope = "public"): ShowView | undefined {
      const show = get(showId);
      return show ? view(show, scope) : undefined;
    },
    subscribe(showId: string, fn: Listener, scope: ViewScope = "public"): (() => void) | undefined {
      const show = get(showId);
      if (!show) return undefined;
      show.listeners.set(fn, scope);
      return () => show.listeners.delete(fn);
    },
    async ingest(showId: string, comment: ChatComment, at?: number) {
      const show = get(showId);
      if (!show) throw new Error(`no show ${showId}`);
      return ingest(show, comment, at);
    },
    async runScenario(showId: string, id: ScenarioId, mode: { instant?: boolean } = {}) {
      const show = get(showId);
      if (!show) throw new Error(`no show ${showId}`);
      return runScenario(show, id, mode);
    },
    tick(showId: string) {
      const show = get(showId);
      if (show) tick(show);
    },
    /** Raw engine access for tests and debugging. */
    engine(showId: string) {
      return get(showId)?.engine;
    },
    dispose() {
      for (const show of shows.values()) {
        if (show.tickTimer) clearInterval(show.tickTimer);
        if (show.broadcastTimer) clearTimeout(show.broadcastTimer);
        for (const cancel of show.simCancels) cancel();
        show.twitchConn?.close();
      }
      shows.clear();
    },
  };
}

export type ShowService = ReturnType<typeof createShowService>;

function hookSummary(e: WebhookEvent): string {
  switch (e.type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      return "PayPal confirmed the payment";
    case "PAYMENT.CAPTURE.PENDING":
      return `PayPal is holding the payment as pending${e.reason ? ` (${e.reason})` : ""}`;
    case "PAYMENT.CAPTURE.DECLINED":
      return "PayPal declined the payment";
    case "PAYMENT.CAPTURE.REFUNDED":
      return "PayPal confirmed the refund";
    case "PAYMENT.CAPTURE.REVERSED":
      return "PayPal reversed the payment";
    case "CHECKOUT.ORDER.APPROVED":
      return "The buyer approved the order in PayPal";
    case "VAULT.PAYMENT-TOKEN.CREATED":
      return "PayPal saved the buyer's wallet";
    case "VAULT.PAYMENT-TOKEN.DELETED":
      return "The buyer removed the saved wallet in PayPal, so the Claim Pass is revoked";
    default:
      return e.type;
  }
}
