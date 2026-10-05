import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createShowService, type ShowService } from "./service";
import { createFileStore, createMemoryStore, type ShowStore } from "./store";
import { MOCK_LABEL, selectGateway } from "./payments";

const T0 = Date.UTC(2026, 9, 5, 18, 0, 0);

function setup(store: ShowStore = createMemoryStore()) {
  let t = T0;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const svc = createShowService({
    store,
    gateway: selectGateway({}),
    now: clock.now,
    tickMs: false,
  });
  return { svc, clock, store };
}

let services: ShowService[] = [];
afterEach(() => {
  for (const s of services) s.dispose();
  services = [];
});

function track<T extends { svc: ShowService }>(x: T): T {
  services.push(x.svc);
  return x;
}

describe("show service", () => {
  it("seeds a demo show with three listed items and the first on air", async () => {
    const { svc } = track(setup());
    const id = await svc.create({ seed: true });
    const v = svc.view(id)!;
    expect(v.items.map((i) => i.code)).toEqual(["12", "7", "21"]);
    expect(v.onAir).toBe("12");
    expect(v.items[0]!.transcript).toMatch(/cable knit/);
    expect(v.payments).toEqual({ mode: "mock", label: MOCK_LABEL });
  });

  it("settles the 4-for-2 race in platform timestamp order", async () => {
    const { svc } = track(setup());
    const id = await svc.create({ seed: true });
    await svc.runScenario(id, "race", { instant: true });
    const v = svc.view(id)!;
    const m = v.board.find((b) => b.code === "12")!.variants.find((x) => x.size === "M")!;
    expect(m.sold + m.held).toBe(2);
    expect(m.waitlist.map((w) => w.displayName)).toEqual(["ben", "cleo"]);
    const stamps = Object.fromEntries(v.comments.map((c) => [c.displayName, c.outcome.label]));
    expect(stamps).toMatchObject({ ava: "GRANTED", dana: "GRANTED", ben: "WAITLIST #1", cleo: "WAITLIST #2" });
    expect(v.kpis.oversold).toBe(0);
    expect(v.kpis.p95LatencyMs).not.toBeNull();
  });

  it("lets an earlier comment that arrives late take the last unit inside the settle window", async () => {
    const { svc } = track(setup());
    const id = await svc.create({ seed: true });
    await svc.runScenario(id, "jitter", { instant: true });
    const v = svc.view(id)!;
    const byName = Object.fromEntries(v.comments.map((c) => [c.displayName, c.outcome]));
    expect(byName.hal!.tone).toMatch(/granted|held|settling/);
    expect(byName.gia!.label).toBe("WAITLIST #1");
    expect(byName.gia!.detail).toMatch(/pre-empted/);
  });

  it("promotes the waitlist when a holder cancels", async () => {
    const { svc } = track(setup());
    const id = await svc.create({ seed: true });
    await svc.runScenario(id, "cancel", { instant: true });
    const v = svc.view(id)!;
    const fay = v.comments.find((c) => c.displayName === "fay")!;
    expect(fay.outcome.tone).toMatch(/granted|settling/);
    expect(fay.outcome.detail).toMatch(/promoted/);
    expect(v.comments.find((c) => c.text.startsWith("jk cancel"))!.outcome.label).toBe("CANCELLED");
  });

  it("routes vague slang to review and still answers questions as questions", async () => {
    const { svc } = track(setup());
    const id = await svc.create({ seed: true });
    await svc.runScenario(id, "slang", { instant: true });
    const v = svc.view(id)!;
    const tones = new Set(v.comments.map((c) => c.outcome.tone));
    expect(tones.has("review")).toBe(true);
    expect(tones.has("question")).toBe(true);
    expect(v.reviews.length).toBeGreaterThan(0);
    expect(v.kpis.autoResolved).toBeGreaterThan(0);
    expect(v.kpis.autoResolved).toBeLessThan(1);
  });

  it("applies every intent of a multi-item comment and links outcomes back to the row", async () => {
    const { svc, clock } = track(setup());
    const id = await svc.create({ seed: true });
    const t = clock.now();
    await svc.ingest(id, { id: "c-multi", platform: "room", userId: "zoe", displayName: "zoe", text: "sold 12 L and 7 S", platformTs: t, receivedTs: t });
    const v = svc.view(id)!;
    const row = v.comments.find((c) => c.id === "c-multi")!;
    expect(row.intents).toHaveLength(2);
    for (const intent of row.intents) expect(intent.outcome.label).not.toBe("…");
    const held = v.units.filter((u) => u.displayName === "zoe" && (u.status === "held" || u.status === "confirmed")).map((u) => u.itemCode).sort();
    expect(held).toEqual(["12", "7"]);
  });

  it("bundles one buyer's three items into one cart with combined shipping", async () => {
    const { svc } = track(setup());
    const id = await svc.create({ seed: true });
    await svc.runScenario(id, "bundle", { instant: true });
    expect((await svc.act(id, { action: "end" })).ok).toBe(true);
    expect(await svc.act(id, { action: "chargeAll" })).toMatchObject({ ok: true, data: { charged: 1, declined: 0 } });
    const nora = svc.view(id)!.carts.find((c) => c.displayName === "nora")!;
    const lines = nora.finalized.flatMap((cart) => cart.lines);
    expect(lines.map((l) => l.itemCode).sort()).toEqual(["12", "21", "7"]);
    expect(nora.finalized.every((cart) => cart.status === "charged")).toBe(true);
    expect(nora.finalized.reduce((a, cart) => a + cart.shippingCents, 0)).toBeLessThan(3 * 800);
  });

  it("closes out: charges Claim Pass carts, declines one, and cascades the declined unit to the waitlist", async () => {
    const { svc } = track(setup());
    const id = await svc.create({ seed: true });
    await svc.runScenario(id, "race", { instant: true });
    expect((await svc.act(id, { action: "chargeAll" })).ok).toBe(false);
    expect((await svc.act(id, { action: "end" })).ok).toBe(true);

    const charged = await svc.act(id, { action: "chargeAll" });
    expect(charged).toMatchObject({ ok: true, data: { charged: 1, declined: 1 } });
    let v = svc.view(id)!;
    const dana = v.carts.find((c) => c.displayName === "dana")!;
    expect(dana.finalized[0]!.status).toBe("declined");
    expect(v.charges.find((c) => c.status === "DECLINED")!.declineCode).toBe("INSTRUMENT_DECLINED");

    expect(await svc.act(id, { action: "releaseHolds", buyerKey: dana.buyerKey })).toMatchObject({ ok: true, data: { released: 1 } });
    v = svc.view(id)!;
    const ben = v.units.find((u) => u.displayName === "ben" && u.status === "confirmed");
    expect(ben).toBeDefined();

    const again = await svc.act(id, { action: "chargeAll" });
    expect(again).toMatchObject({ ok: true, data: { charged: 1, declined: 0 } });
    v = svc.view(id)!;
    expect(v.kpis.oversold).toBe(0);
    expect(v.charges.filter((c) => c.status === "COMPLETED")).toHaveLength(2);
  });

  it("takes a pay-now payment for holds, then refunds and tracks the cart", async () => {
    const { svc, clock } = track(setup());
    const id = await svc.create({ seed: true });
    const t = clock.now();
    await svc.ingest(id, { id: "c1", platform: "room", userId: "uma", displayName: "uma", text: "sold 12 L", platformTs: t, receivedTs: t });
    await svc.act(id, { action: "end" });
    const order = await svc.act(id, { action: "payNowHolds", buyerKey: "room:uma" }, { origin: "http://x" });
    expect(order.ok).toBe(true);
    const o = (order as { data: { orderId: string; amountCents: number; approveUrl: string } }).data;
    expect(o.amountCents).toBe(3400 + 800);
    expect(o.approveUrl).toContain(`/pay/${id}`);
    expect((await svc.act(id, { action: "capture", orderId: o.orderId })).ok).toBe(true);
    let v = svc.view(id)!;
    const cart = v.carts.find((c) => c.buyerKey === "room:uma")!.finalized[0]!;
    expect(cart.status).toBe("charged");

    expect((await svc.act(id, { action: "refund", cartId: cart.cartId, amountCents: 500 })).ok).toBe(true);
    expect((await svc.act(id, { action: "tracking", cartId: cart.cartId, carrier: "USPS", trackingNumber: "9400111" })).ok).toBe(true);
    v = svc.view(id)!;
    expect(v.refunds[0]!.amountCents).toBe(500);
    expect(v.tracking[0]!.carrier).toBe("USPS");
  });

  it("sends one capture to PayPal when the same order is captured twice at once", async () => {
    const selected = selectGateway({});
    let captures = 0;
    const captureOrder = selected.gateway.captureOrder.bind(selected.gateway);
    selected.gateway.captureOrder = async (orderId) => {
      captures += 1;
      await new Promise((r) => setTimeout(r, 5));
      return captureOrder(orderId);
    };
    const svc = createShowService({ store: createMemoryStore(), gateway: selected, now: () => T0, tickMs: false });
    services.push(svc);
    const id = await svc.create({ seed: true });
    await svc.ingest(id, { id: "c1", platform: "room", userId: "uma", displayName: "uma", text: "sold 12 L", platformTs: T0, receivedTs: T0 });
    await svc.act(id, { action: "end" });
    const { orderId } = ((await svc.act(id, { action: "payNowHolds", buyerKey: "room:uma" }, { origin: "http://x" })) as { data: { orderId: string } }).data;
    const [a, b] = await Promise.all([svc.act(id, { action: "capture", orderId }), svc.act(id, { action: "capture", orderId })]);
    expect(a.ok && b.ok).toBe(true);
    expect(captures).toBe(1);
    expect((await svc.act(id, { action: "capture", orderId })).ok).toBe(true);
    expect(captures).toBe(1);
    expect(svc.view(id)!.charges.filter((c) => c.via === "pay-now")).toHaveLength(1);
  });

  it("keeps a pay-now order open when PayPal says the buyer has not approved it yet", async () => {
    const selected = selectGateway({});
    const captureOrder = selected.gateway.captureOrder.bind(selected.gateway);
    let first = true;
    selected.gateway.captureOrder = async (orderId) => {
      if (first) {
        first = false;
        return { orderId, status: "PAYER_ACTION_REQUIRED", declineCode: "ORDER_NOT_APPROVED" };
      }
      return captureOrder(orderId);
    };
    const svc = createShowService({ store: createMemoryStore(), gateway: selected, now: () => T0, tickMs: false });
    services.push(svc);
    const id = await svc.create({ seed: true });
    await svc.ingest(id, { id: "c1", platform: "room", userId: "uma", displayName: "uma", text: "sold 12 L", platformTs: T0, receivedTs: T0 });
    await svc.act(id, { action: "end" });
    const { orderId } = ((await svc.act(id, { action: "payNowHolds", buyerKey: "room:uma" }, { origin: "http://x" })) as { data: { orderId: string } }).data;
    const early = await svc.act(id, { action: "capture", orderId });
    expect(early).toMatchObject({ ok: false, error: expect.stringMatching(/not approved this payment yet/) });
    expect(svc.view(id)!.orders.find((o) => o.orderId === orderId)!.status).toBe("open");
    expect((await svc.act(id, { action: "capture", orderId })).ok).toBe(true);
    expect(svc.view(id)!.orders.find((o) => o.orderId === orderId)!.status).toBe("captured");
  });

  it("replays a refund submitted twice with the same key, but honours a second refund with a new key", async () => {
    const { svc } = track(setup());
    const id = await svc.create({ seed: true });
    await svc.runScenario(id, "bundle", { instant: true });
    await svc.act(id, { action: "end" });
    await svc.act(id, { action: "chargeAll" });
    const cartId = svc.view(id)!.carts.find((c) => c.displayName === "nora")!.finalized[0]!.cartId;
    const refund = (requestId: string) => svc.act(id, { action: "refund", cartId, amountCents: 2900, requestId });
    const [a, b] = await Promise.all([refund("key-aaaa-1111"), refund("key-aaaa-1111")]);
    const c = await refund("key-aaaa-1111");
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(svc.view(id)!.refunds).toHaveLength(1);
    expect(await refund("key-bbbb-2222")).toMatchObject({ ok: true });
    expect(svc.view(id)!.refunds.map((r) => r.amountCents)).toEqual([2900, 2900]);
  });

  it("expires an unpaid hold on the clock and promotes the next buyer", async () => {
    const { svc, clock } = track(setup());
    const id = await svc.create({ seed: true });
    const t = clock.now();
    await svc.ingest(id, { id: "a", platform: "room", userId: "a", displayName: "a", text: "sold 12 L", platformTs: t, receivedTs: t });
    await svc.ingest(id, { id: "b", platform: "room", userId: "b", displayName: "b", text: "sold 12 L", platformTs: t + 5, receivedTs: t + 5 });
    clock.advance(5 * 60_000 + 10);
    svc.tick(id);
    const v = svc.view(id)!;
    expect(v.comments.find((c) => c.id === "a")!.outcome.label).toBe("LAPSED");
    expect(v.comments.find((c) => c.id === "b")!.outcome.detail).toMatch(/promoted/);
  });

  it("replays the event log from disk after a restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claim-web-"));
    try {
      const first = setup(createFileStore(dir));
      const id = await first.svc.create({ seed: true });
      await first.svc.runScenario(id, "race", { instant: true });
      await first.svc.act(id, { action: "end" });
      await first.svc.act(id, { action: "chargeAll" });
      const before = first.svc.view(id)!;
      first.svc.dispose();

      const second = track(setup(createFileStore(dir)));
      const after = second.svc.view(id)!;
      expect(after.board).toEqual(before.board);
      expect(after.carts).toEqual(before.carts);
      expect(after.comments.map((c) => c.outcome.label)).toEqual(before.comments.map((c) => c.outcome.label));
      expect(after.charges).toEqual(before.charges);
      expect(second.svc.list().map((s) => s.showId)).toContain(id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-saves mock Claim Passes lost in a restart, keeping the declining card declining", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claim-web-"));
    try {
      const first = setup(createFileStore(dir));
      const id = await first.svc.create({ seed: true });
      await first.svc.runScenario(id, "race", { instant: true });
      await first.svc.act(id, { action: "end" });
      first.svc.dispose();

      const second = track(setup(createFileStore(dir)));
      expect(await second.svc.act(id, { action: "chargeAll" })).toMatchObject({ ok: true, data: { charged: 1, declined: 1 } });
      const v = second.svc.view(id)!;
      expect(v.charges.find((c) => c.status === "DECLINED")!.declineCode).toBe("INSTRUMENT_DECLINED");
      expect(v.kpis.oversold).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects bad input without touching the engine", async () => {
    const { svc } = track(setup());
    const id = await svc.create({ seed: true });
    expect(await svc.act("nope", { action: "start" })).toMatchObject({ ok: false, status: 404 });
    expect((await svc.act(id, { action: "comment", userId: "", displayName: "x", text: "hi" })).ok).toBe(false);
    expect((await svc.act(id, { action: "onAir", code: "999" })).ok).toBe(false);
    expect((await svc.act(id, { action: "twitch", channel: "bad name!" })).ok).toBe(false);
  });

  it("lists a voice-parsed item after the seller confirms the draft", async () => {
    const { svc } = track(setup());
    const id = await svc.create({ seed: true });
    const parsed = await svc.act(id, { action: "parseListing", transcript: "okay next up is number 9, sage linen button down, two smalls and a medium, thirty six" });
    expect(parsed.ok).toBe(true);
    const draft = (parsed as { data: { draft: unknown; warnings: string[] } }).data;
    expect(draft.warnings.length).toBeGreaterThan(0);
    const listed = await svc.act(id, { action: "listItem", draft: draft.draft, edits: { priceCents: 3600 }, transcript: "okay next up is number 9" });
    expect(listed.ok).toBe(true);
    const v = svc.view(id)!;
    expect(v.onAir).toBe("9");
    expect(v.items.find((i) => i.code === "9")!.priceCents).toBe(3600);
  });
});
