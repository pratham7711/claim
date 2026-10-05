import { describe, expect, it } from "vitest";
import type { IntentKind, Platform, ShowItem } from "../contract.js";
import { effectiveCapCents, exposure } from "../carts.js";
import { makeConfig } from "../config.js";
import { decide } from "../decide.js";
import { createEngine, type Engine } from "../engine.js";
import { itemBoard, oversold } from "../projections.js";
import { initialState, mutate, replay } from "../state.js";
import type { Command, EngineConfig, EngineEvent, EngineState, Unit } from "../types.js";
import { compareKeys } from "../util.js";
import { T0, comment, deepFreeze, intent, type Say } from "./fixtures.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  next(): number;
  int(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
}

function rng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
  };
}

const USERS = ["ana", "ben", "cy", "dee", "eli", "fay", "gus"];
const SIZES = ["S", "M", "L"] as const;
const COLORS = ["blue", "red"] as const;

function randomConfig(r: Rng, seed: number): EngineConfig {
  return makeConfig(`s${seed}`, {
    leaseMs: r.int(2_000, 30_000),
    declineLeaseMs: r.int(2_000, 30_000),
    settleWindowMs: r.pick([0, 500, 2000, 4000]),
    confidenceThreshold: 0.8,
    cap: { maxCents: r.pick([undefined, 5_000, 8_000, 15_000]), maxUnits: r.pick([undefined, 3, 6]) },
    shipping: { firstItemCents: 800, perExtraItemCents: 200, freeOverCents: r.pick([undefined, 6_000, 10_000]) },
  });
}

function randomItem(r: Rng, code: string): ShowItem {
  const variants: ShowItem["variants"] = [];
  for (const size of SIZES) {
    for (const color of COLORS) {
      if (r.next() < 0.45) variants.push({ sku: `${code}-${size}-${color}`, size, color, qty: r.int(0, 3) });
    }
  }
  if (!variants.length) variants.push({ sku: `${code}-OS`, qty: r.int(1, 3) });
  return { code, title: `Item ${code}`, priceCents: r.int(5, 60) * 100, variants };
}

/** Invariants that must hold after every command. */
function checkState(s: EngineState): void {
  expect(oversold(s)).toEqual([]);
  const board = itemBoard(s);
  const granted = board.flatMap((i) => i.variants).reduce((a, v) => a + v.sold + v.held, 0);
  const inventory = board.flatMap((i) => i.variants).reduce((a, v) => a + v.qty, 0);
  expect(granted).toBeLessThanOrEqual(inventory);

  for (const item of board) {
    for (const v of item.variants) {
      if (v.available > 0) expect(v.waitlist, `${item.code}/${v.sku} has stock and a waitlist`).toEqual([]);
    }
  }

  const units = s.unitOrder.map((id) => s.units[id]!);
  expect(units.filter((u) => u.status === "pending")).toEqual([]);

  // No waitlisted claim is earlier than a holder that could still be pre-empted.
  const byVariant = new Map<string, Unit[]>();
  for (const u of units) byVariant.set(`${u.itemCode}/${u.sku}`, [...(byVariant.get(`${u.itemCode}/${u.sku}`) ?? []), u]);
  for (const [variant, list] of byVariant) {
    const provisional = list.filter(
      (u) => (u.status === "held" || u.status === "confirmed") && !u.paid && !u.cartId && u.settleUntil !== undefined && s.clock < u.settleUntil,
    );
    for (const w of list.filter((u) => u.status === "waitlisted")) {
      for (const p of provisional) {
        expect(compareKeys(w.key, p.key), `${variant}: waitlisted ${w.id} precedes provisional ${p.id}`).toBeGreaterThan(0);
      }
    }
  }
}

/** Walks a command's events against a mirror: promotions take the waitlist head; grants respect the cap. */
function checkEvents(mirror: EngineState, events: readonly EngineEvent[]): void {
  for (const e of events) {
    if (e.type === "unitGranted" && e.promoted) {
      const u = mirror.units[e.unitId]!;
      const head = mirror.unitOrder
        .map((id) => mirror.units[id]!)
        .filter((x) => x.itemCode === u.itemCode && x.sku === u.sku && x.status === "waitlisted")
        .sort((a, b) => compareKeys(a.key, b.key))[0];
      expect(head?.id, "promotion must take the waitlist head").toBe(e.unitId);
    }
    if (e.type === "unitWaitlisted") expect(mirror.units[e.unitId]!.paid, "a paid unit went back to the waitlist").toBe(false);
    mutate(mirror, e);
    if (e.type === "unitGranted") {
      const u = mirror.units[e.unitId]!;
      if (u.capExempt) continue;
      const x = exposure(mirror, u.buyerKey);
      const cap = effectiveCapCents(mirror, u.buyerKey);
      if (cap !== undefined) expect(x.totalCents, `cap breached for ${u.buyerKey}`).toBeLessThanOrEqual(cap);
      const maxUnits = mirror.config.cap.maxUnits;
      if (maxUnits !== undefined) expect(x.units).toBeLessThanOrEqual(maxUnits);
    }
  }
}

interface Sim {
  eng: Engine;
  commands: { command: Command; now: number }[];
}

const memo = new Map<number, Sim>();

/** Each seed is simulated (with every per-step check) once; later tests reuse the run. */
function simulate(seed: number): Sim {
  let sim = memo.get(seed);
  if (!sim) memo.set(seed, (sim = runSimulation(seed)));
  return sim;
}

function runSimulation(seed: number, steps = 160): Sim {
  const r = rng(seed);
  const config = randomConfig(r, seed);
  const eng = createEngine(config);
  const mirror = initialState(config);
  const commands: Sim["commands"] = [];
  const said: Say[] = [];
  let now = T0;

  const run = (command: Command, at: number): EngineEvent[] => {
    const frozen = deepFreeze(structuredClone(eng.state));
    const predicted = decide(frozen, command, at);
    const events = eng.execute(command, at);
    expect(events).toEqual(predicted);
    commands.push({ command, now: at });
    checkEvents(mirror, events);
    checkState(eng.state);
    return events;
  };

  const liveUnits = (pred: (u: Unit) => boolean) => eng.state.unitOrder.map((id) => eng.state.units[id]!).filter(pred);
  const items = () => eng.state.itemOrder.map((c) => eng.state.items[c]!);

  for (let step = 0; step < steps; step++) {
    now += r.int(0, 1500);
    const roll = r.next();
    const listed = items();

    if (listed.length === 0 || (listed.length < 4 && roll < 0.06)) {
      run({ type: "listItem", item: randomItem(r, String(10 + listed.length)) }, now);
    } else if (roll < 0.16) {
      // Burst on one hot variant: several viewers type within ~600 ms and land shuffled by ingestion jitter.
      const it = r.pick(listed);
      const v = r.pick(it.variants);
      const burst: Say[] = Array.from({ length: r.int(3, 6) }, (_, i) => ({
        id: `b${seed}-${step}-${i}`,
        user: r.pick(USERS),
        platform: r.pick<Platform>(["room", "twitch"]),
        ts: now - r.int(0, 600),
        kind: "claim" as const,
        item: it.code,
        ...(v.size ? { size: v.size } : {}),
        ...(v.color ? { color: v.color } : {}),
        confidence: 0.95,
      }));
      for (const s of burst) {
        said.push(s);
        now += r.int(0, 250);
        run({ type: "applyIntent", comment: comment(s, now), intent: intent(s) }, now);
      }
    } else if (roll < 0.55) {
      const kind = r.pick<IntentKind>(["claim", "claim", "claim", "claim", "claim", "claim", "cancel", "cancel", "change", "waitlist", "question", "other"]);
      const it = r.next() < 0.08 ? "99" : r.next() < 0.05 ? undefined : r.pick(listed).code;
      const s: Say = {
        id: `m${seed}-${step}`,
        user: r.pick(USERS),
        platform: r.pick<Platform>(["room", "twitch", "youtube"]),
        ts: now - r.int(0, 3000),
        kind,
        confidence: r.next() < 0.15 ? r.next() * 0.8 : 0.8 + r.next() * 0.2,
        ...(it ? { item: it } : {}),
        ...(r.next() < 0.8 ? { size: r.pick(SIZES) } : {}),
        ...(r.next() < 0.5 ? { color: r.pick(COLORS) } : {}),
        ...(r.next() < 0.3 ? { qty: r.int(1, 3) } : {}),
      };
      said.push(s);
      run({ type: "applyIntent", comment: comment(s, now), intent: intent(s) }, now);
    } else if (roll < 0.6 && said.length) {
      // Duplicate delivery: settle time first, then the redelivered comment must change nothing.
      run({ type: "tick" }, now);
      const s = r.pick(said);
      const before = eng.state;
      const events = run({ type: "applyIntent", comment: comment(s, now), intent: intent(s) }, now);
      expect(events).toEqual([]);
      expect(eng.state).toBe(before);
    } else if (roll < 0.68) {
      now += r.int(0, 25_000);
      run({ type: "tick" }, now);
    } else if (roll < 0.74) {
      const held = liveUnits((u) => u.status === "held");
      const ids = held.length && r.next() < 0.85 ? [r.pick(held).id] : [r.pick(liveUnits(() => true))?.id ?? "nope"];
      run({ type: "confirmPayment", unitIds: ids, orderId: `O-${step}` }, now);
    } else if (roll < 0.78) {
      const u = r.pick(USERS);
      run({ type: "saveClaimPass", buyer: { buyerKey: `room:${u}`, displayName: u }, ...(r.next() < 0.5 ? { capCents: r.pick([4_000, 12_000]) } : {}) }, now);
    } else if (roll < 0.8) {
      run({ type: "revokeClaimPass", buyerKey: `room:${r.pick(USERS)}` }, now);
    } else if (roll < 0.85) {
      const any = liveUnits((u) => u.status !== "released");
      const which = r.int(0, 2);
      if (which === 0) {
        const it = r.pick(listed);
        const v = r.pick(it.variants);
        const u = r.pick(USERS);
        run({ type: "sellerGrant", buyer: { buyerKey: `room:${u}`, displayName: u }, itemCode: it.code, sku: v.sku, qty: r.int(1, 2) }, now);
      } else if (which === 1 && any.length) {
        run({ type: "sellerRevoke", unitId: r.pick(any).id }, now);
      } else if (any.length) {
        const u = r.pick(USERS);
        run({ type: "sellerReassign", unitId: r.pick(any).id, to: { buyerKey: `twitch:${u}`, displayName: u } }, now);
      }
    } else if (roll < 0.89) {
      const it = r.pick(listed);
      const v = r.pick(it.variants);
      run({ type: "updateInventory", itemCode: it.code, sku: v.sku, qty: r.int(0, 4) }, now);
    } else if (roll < 0.95) {
      const pending = eng.state.reviewOrder.map((id) => eng.state.reviews[id]!).filter((x) => x.status === "pending");
      if (pending.length) {
        const rv = r.pick(pending);
        if (r.next() < 0.7) {
          const target = rv.request.itemCode ? eng.state.items[rv.request.itemCode] : undefined;
          const patch = target && r.next() < 0.6 ? { sku: r.pick(target.variants).sku } : undefined;
          run({ type: "approveReview", reviewId: rv.id, ...(patch ? { patch } : {}) }, now);
        } else {
          run({ type: "rejectReview", reviewId: rv.id }, now);
        }
      }
    } else {
      run({ type: "tick" }, now);
    }
  }

  // Close-out: end, bill, charge with random outcomes, let decline leases run out, bill again.
  run({ type: "endShow" }, (now += 1000));
  for (let round = 0; round < 3; round++) {
    run({ type: "finalizeCarts" }, (now += 1000));
    for (const id of eng.state.cartOrder) {
      const cart = eng.state.carts[id]!;
      if (cart.status !== "pending") continue;
      run({ type: "recordCharge", cartId: id, outcome: r.next() < 0.75 ? "completed" : "declined" }, (now += 10));
    }
    const held = liveUnits((u) => u.status === "held");
    if (held.length && r.next() < 0.5) run({ type: "confirmPayment", unitIds: [r.pick(held).id] }, (now += 10));
    run({ type: "tick" }, (now += 60 * 60_000));
  }

  return { eng, commands };
}

const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);

describe("engine properties over random shows", { timeout: 60_000 }, () => {
  it.each(SEEDS)("seed %i: never oversells, promotes in order, respects caps, decides purely", (seed) => {
    const { eng } = simulate(seed);
    expect(eng.events.length).toBeGreaterThan(50);
  });

  it("replaying the event log reproduces state, from scratch and from any prefix", () => {
    for (const seed of SEEDS.slice(0, 12)) {
      const { eng } = simulate(seed);
      expect(replay(eng.state.config, eng.events)).toEqual(eng.state);
      const cut = Math.floor(eng.events.length / 2);
      const resumed = createEngine(eng.state.config, eng.events.slice(0, cut));
      for (const e of eng.events.slice(cut)) mutate(resumed.state, e);
      expect(resumed.state).toEqual(eng.state);
    }
  });

  it("re-running the same command stream yields the identical event log", () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const a = simulate(seed);
      const b = createEngine(a.eng.state.config);
      for (const { command, now } of a.commands) b.execute(command, now);
      expect(b.events).toEqual(a.eng.events);
      expect(b.state).toEqual(a.eng.state);
    }
  });

  it("delivering every comment twice changes nothing (idempotent replay)", () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const a = simulate(seed);
      const b = createEngine(a.eng.state.config);
      for (const { command, now } of a.commands) {
        b.execute(command, now);
        if (command.type === "applyIntent") expect(b.execute(command, now)).toEqual([]);
      }
      expect(b.state).toEqual(a.eng.state);
    }
  });

  it("exercises the interesting paths", () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      for (const e of simulate(seed).eng.events) {
        seen.add(e.type);
        if (e.type === "unitWaitlisted") seen.add(`waitlisted:${e.cause}`);
        if (e.type === "unitGranted" && e.promoted) seen.add("promoted");
        if (e.type === "reviewOpened") seen.add(`review:${e.cause}`);
        if (e.type === "unitReleased") seen.add(`released:${e.cause}`);
      }
    }
    for (const k of [
      "waitlisted:preempted",
      "waitlisted:sold-out",
      "waitlisted:bumped",
      "promoted",
      "review:low-confidence",
      "review:over-cap",
      "review:promotion-over-cap",
      "review:ambiguous-variant",
      "released:lease-expired",
      "released:buyer-cancel",
      "claimParked",
      "cartsFinalized",
      "cartDeclined",
      "unitReverted",
    ]) {
      expect(seen, k).toContain(k);
    }
  });
});

describe("waitlist promotion order", () => {
  it("promotes strictly by platformTs regardless of arrival order", () => {
    const eng = createEngine(makeConfig("wl", { settleWindowMs: 0, cap: {} }));
    eng.execute({ type: "listItem", item: { code: "1", title: "Tee", priceCents: 1000, variants: [{ sku: "1-OS", qty: 1 }] } }, T0);
    eng.execute({ type: "applyIntent", comment: comment({ id: "h", user: "holder", ts: T0 }, T0), intent: intent({ id: "h", user: "holder", ts: T0, item: "1" }) }, T0);
    const order = [5, 1, 4, 2, 3];
    order.forEach((n, i) => {
      const s: Say = { id: `w${n}`, user: `u${n}`, ts: T0 + n * 100, item: "1" };
      eng.execute({ type: "applyIntent", comment: comment(s, T0 + 1000 + i), intent: intent(s) }, T0 + 1000 + i);
    });
    const winners: string[] = [];
    let now = T0 + 5000;
    for (let i = 0; i < 5; i++) {
      const holder = eng.state.unitOrder.map((id) => eng.state.units[id]!).find((u) => u.status === "held")!;
      eng.execute({ type: "sellerRevoke", unitId: holder.id }, (now += 100));
      const next = eng.state.unitOrder.map((id) => eng.state.units[id]!).find((u) => u.status === "held");
      if (next) winners.push(next.buyerKey);
    }
    expect(winners).toEqual(["room:u1", "room:u2", "room:u3", "room:u4", "room:u5"]);
  });
});
