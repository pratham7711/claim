import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import { createEngine } from "../engine.js";
import { auditLog, buyerCarts, itemBoard, oversold, reviewQueue } from "../projections.js";
import { replay } from "../state.js";
import type { EngineConfig } from "../types.js";
import { T0, buyer, holders, item, key, ofType, say, statusOf, unitsOf } from "./fixtures.js";

const MIN = 60_000;

function show(overrides: Partial<Omit<EngineConfig, "showId">> = {}) {
  const eng = createEngine(makeConfig("show1", overrides));
  return eng;
}

function blueDress(eng: ReturnType<typeof show>, qty = 2) {
  eng.execute({ type: "listItem", item: item({ code: "14", title: "Floral wrap dress", variants: [{ size: "M", color: "blue", qty }] }) }, T0 - 5000);
}

describe("4 claims for 2 items", () => {
  it("grants the two earliest and waitlists the rest in platformTs order", () => {
    const eng = show();
    blueDress(eng);
    const offsets: [string, number][] = [["alice", 120], ["bob", 240], ["carol", 480], ["dave", 600]];
    for (const [user, ms] of offsets) say(eng, { id: `c-${user}`, user, ts: T0 + ms, item: "14", size: "M" }, T0 + ms + 15);

    const v = itemBoard(eng.state)[0]!.variants[0]!;
    expect(v).toMatchObject({ qty: 2, held: 2, sold: 0, available: 0 });
    expect(v.waitlist.map((w) => w.displayName)).toEqual(["carol", "dave"]);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["alice", "bob"]);
    expect(oversold(eng.state)).toEqual([]);

    const waitReasons = ofType(eng.events, "unitWaitlisted").map((e) => e.reason);
    expect(waitReasons[0]).toContain("waitlisted #1 for #14 M blue: sold out");
    expect(waitReasons[1]).toContain("waitlisted #2");
  });

  it("settles the same winners when the four arrive in reverse order inside the settle window", () => {
    const eng = show();
    blueDress(eng);
    const arrivals: [string, number, number][] = [
      ["dave", 600, 700],
      ["carol", 480, 750],
      ["bob", 240, 800],
      ["alice", 120, 900],
    ];
    for (const [user, ms, at] of arrivals) say(eng, { id: `c-${user}`, user, ts: T0 + ms, item: "14", size: "M" }, T0 + at);

    expect(holders(eng.state, "14", "14-M-BLUE").sort()).toEqual(["alice", "bob"]);
    expect(itemBoard(eng.state)[0]!.variants[0]!.waitlist.map((w) => w.displayName)).toEqual(["carol", "dave"]);
    const pre = ofType(eng.events, "unitWaitlisted").filter((e) => e.cause === "preempted");
    expect(pre).toHaveLength(2);
    expect(pre[0]!.reason).toContain("bob platformTs 12:01:03.240 precedes dave 12:01:03.600");
    expect(pre[0]!.reason).toContain("inside the 2000ms settle window");
  });

  it("promotes the waitlist head when a holder cancels (\"jk\")", () => {
    const eng = show();
    blueDress(eng);
    for (const [user, ms] of [["alice", 120], ["bob", 240], ["carol", 480], ["dave", 600]] as const) {
      say(eng, { id: `c-${user}`, user, ts: T0 + ms, item: "14", size: "M" }, T0 + ms + 15);
    }
    say(eng, { id: "jk", user: "alice", ts: T0 + 9000, kind: "cancel", text: "jk" }, T0 + 9010);
    expect(statusOf(eng.state, "alice")).toEqual(["released"]);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["bob", "carol"]);
    expect(itemBoard(eng.state)[0]!.variants[0]!.waitlist.map((w) => w.displayName)).toEqual(["dave"]);
    const promoted = ofType(eng.events, "unitGranted").filter((e) => e.promoted);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.reason).toContain("promoted #14 M blue to carol");
  });
});

describe("fairness across ingestion jitter", () => {
  it("a Twitch comment that arrives late but was posted first wins the last unit", () => {
    const eng = show();
    blueDress(eng, 1);
    // Room comment posted at .480 lands in 10 ms; Twitch comment posted at .120 lands at p90 lag (426 ms).
    say(eng, { id: "room-1", user: "rita", ts: T0 + 480, item: "14", size: "M", platform: "room" }, T0 + 490);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["rita"]);
    say(eng, { id: "tw-1", user: "tom", ts: T0 + 120, item: "14", size: "M", platform: "twitch" }, T0 + 120 + 426);

    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["tom"]);
    const grant = ofType(eng.events, "unitGranted").at(-1)!;
    expect(grant.reason).toContain("granted #14 M blue to tom: earliest platformTs 12:01:03.120 vs 12:01:03.480");
    expect(grant.preempted).toBe(unitsOf(eng.state, "rita")[0]!.id);
    expect(itemBoard(eng.state)[0]!.variants[0]!.waitlist.map((w) => w.buyerKey)).toEqual([key("rita")]);
  });

  it("a claim arriving after the settle window queues instead of pre-empting", () => {
    const eng = show();
    blueDress(eng, 1);
    say(eng, { id: "room-1", user: "rita", ts: T0 + 480, item: "14", size: "M" }, T0 + 490);
    say(eng, { id: "tw-late", user: "tom", ts: T0 + 120, item: "14", size: "M", platform: "twitch" }, T0 + 490 + 2001);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["rita"]);
    const w = ofType(eng.events, "unitWaitlisted").at(-1)!;
    expect(w.cause).toBe("sold-out");
    expect(w.reason).toContain("but that grant is final");
  });

  it("orders exact platformTs ties by comment id", () => {
    const eng = show();
    blueDress(eng, 1);
    say(eng, { id: "m-200", user: "bea", ts: T0, item: "14", size: "M" }, T0 + 5);
    say(eng, { id: "m-100", user: "al", ts: T0, item: "14", size: "M" }, T0 + 30);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["al"]);
  });

  it("never pre-empts a unit that has been paid", () => {
    const eng = show({ settleWindowMs: 60_000 });
    blueDress(eng, 1);
    say(eng, { id: "a", user: "alice", ts: T0 + 500, item: "14", size: "M" }, T0 + 510);
    const u = unitsOf(eng.state, "alice")[0]!;
    eng.execute({ type: "confirmPayment", unitIds: [u.id], orderId: "ORDER-1" }, T0 + 2000);
    say(eng, { id: "b", user: "bob", ts: T0 + 100, item: "14", size: "M" }, T0 + 3000);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["alice"]);
    expect(statusOf(eng.state, "bob")).toEqual(["waitlisted"]);
  });
});

describe("leases and the Claim Pass", () => {
  it("expires an unpaid pay-now hold and promotes the waitlist head with a fresh lease", () => {
    const eng = show();
    blueDress(eng, 1);
    say(eng, { id: "a", user: "alice", ts: T0, item: "14", size: "M" }, T0 + 10);
    say(eng, { id: "b", user: "bob", ts: T0 + 50, item: "14", size: "M" }, T0 + 60);
    const a = unitsOf(eng.state, "alice")[0]!;
    expect(a).toMatchObject({ status: "held", via: "pay-now", leaseExpiresAt: T0 + 10 + 10 * MIN });

    eng.execute({ type: "tick" }, T0 + 10 + 10 * MIN - 1);
    expect(a.status).toBe("held");
    eng.execute({ type: "tick" }, T0 + 10 + 10 * MIN);
    expect(statusOf(eng.state, "alice")).toEqual(["released"]);
    const b = unitsOf(eng.state, "bob")[0]!;
    expect(b).toMatchObject({ status: "held", leaseExpiresAt: T0 + 10 + 20 * MIN });

    const late = eng.execute({ type: "confirmPayment", unitIds: [a.id] }, T0 + 11 * MIN);
    expect(ofType(late, "commandRejected")[0]!.reason).toContain("lapsed; do not capture");

    eng.execute({ type: "confirmPayment", unitIds: [b.id], orderId: "O-2" }, T0 + 12 * MIN);
    expect(unitsOf(eng.state, "bob")[0]).toMatchObject({ status: "confirmed", paid: true, via: "pay-now" });
    const again = eng.execute({ type: "confirmPayment", unitIds: [b.id] }, T0 + 12 * MIN + 1);
    expect(ofType(again, "commandRejected")[0]!.reason).toContain("already paid");
  });

  it("checks the lease at capture time even when no tick has run", () => {
    const eng = show({ leaseMs: 1000 });
    blueDress(eng, 1);
    say(eng, { id: "a", user: "alice", ts: T0, item: "14", size: "M" }, T0);
    const a = unitsOf(eng.state, "alice")[0]!;
    const events = eng.execute({ type: "confirmPayment", unitIds: [a.id] }, T0 + 1000);
    expect(events.map((e) => e.type)).toEqual(["unitReleased", "commandRejected"]);
  });

  it("auto-confirms a Claim Pass holder and confirms open holds when a pass is saved", () => {
    const eng = show();
    blueDress(eng, 3);
    eng.execute({ type: "saveClaimPass", buyer: buyer("alice") }, T0);
    say(eng, { id: "a", user: "alice", ts: T0 + 10, item: "14", size: "M" }, T0 + 20);
    expect(unitsOf(eng.state, "alice")[0]).toMatchObject({ status: "confirmed", via: "claim-pass", paid: false });
    expect(unitsOf(eng.state, "alice")[0]!.leaseExpiresAt).toBeUndefined();

    say(eng, { id: "b", user: "bob", ts: T0 + 30, item: "14", size: "M" }, T0 + 40);
    expect(statusOf(eng.state, "bob")).toEqual(["held"]);
    eng.execute({ type: "saveClaimPass", buyer: buyer("bob"), capCents: 10_000 }, T0 + MIN);
    expect(unitsOf(eng.state, "bob")[0]).toMatchObject({ status: "confirmed", via: "claim-pass" });

    eng.execute({ type: "revokeClaimPass", buyerKey: key("bob") }, T0 + 2 * MIN);
    expect(unitsOf(eng.state, "bob")[0]).toMatchObject({ status: "held", via: "pay-now", leaseExpiresAt: T0 + 12 * MIN });
  });
});

describe("per-buyer per-show cap", () => {
  it("routes the claim that would push the cart over the cents cap to review", () => {
    const eng = show({ cap: { maxCents: 15_000 } });
    eng.execute({ type: "listItem", item: item({ code: "14", priceCents: 3800, variants: [{ size: "M", qty: 10 }] }) }, T0);
    say(eng, { id: "1", user: "alice", ts: T0 + 1, item: "14", size: "M" }, T0 + 10);
    say(eng, { id: "2", user: "alice", ts: T0 + 2, item: "14", size: "M", qty: 2 }, T0 + 20);
    expect(statusOf(eng.state, "alice")).toEqual(["held", "held", "held"]);
    say(eng, { id: "3", user: "alice", ts: T0 + 3, item: "14", size: "M" }, T0 + 30);
    expect(statusOf(eng.state, "alice")).toHaveLength(3);
    const [r] = reviewQueue(eng.state);
    expect(r).toMatchObject({ cause: "over-cap", commentId: "3" });
    expect(r!.reason).toContain("over cap: cart would be $152.00 (items $152.00 + shipping $0.00) vs cap $150.00");
  });

  it("enforces the unit cap and a lower cap chosen on the Claim Pass", () => {
    const units = show({ cap: { maxUnits: 2 } });
    units.execute({ type: "listItem", item: item({ code: "1", priceCents: 1000, variants: [{ qty: 9 }] }) }, T0);
    say(units, { id: "1", user: "u", ts: T0, item: "1", qty: 3 }, T0);
    expect(reviewQueue(units.state)[0]!.reason).toContain("over unit cap: 3 units vs cap 2");

    const pass = show({ cap: { maxCents: 15_000 } });
    pass.execute({ type: "listItem", item: item({ code: "1", priceCents: 3000, variants: [{ qty: 9 }] }) }, T0);
    pass.execute({ type: "saveClaimPass", buyer: buyer("p"), capCents: 5000 }, T0);
    say(pass, { id: "1", user: "p", ts: T0 + 1, item: "1" }, T0 + 1);
    say(pass, { id: "2", user: "p", ts: T0 + 2, item: "1" }, T0 + 2);
    expect(statusOf(pass.state, "p")).toEqual(["confirmed"]);
    expect(reviewQueue(pass.state)[0]!.reason).toContain("vs cap $50.00");
  });

  it("checks every partial fill of a multi-unit claim, since free shipping makes fewer units dearer", () => {
    // 3 x $20 = $60 ships free and fits a $60 cap; only 2 are in stock, and 2 x $20 + $30 shipping = $70 does not.
    const eng = show({ cap: { maxCents: 6000 }, shipping: { firstItemCents: 2500, perExtraItemCents: 500, freeOverCents: 6000 } });
    eng.execute({ type: "listItem", item: item({ code: "5", priceCents: 2000, variants: [{ qty: 2 }] }) }, T0);
    say(eng, { id: "1", user: "alice", ts: T0, item: "5", qty: 3 }, T0);
    expect(unitsOf(eng.state, "alice")).toEqual([]);
    expect(reviewQueue(eng.state)[0]!.reason).toContain("cart would be $70.00");
  });

  it("skips a waitlist head whose promotion would break the cap and promotes the next", () => {
    const eng = show({ cap: { maxCents: 10_000 }, shipping: { firstItemCents: 0, perExtraItemCents: 0 } });
    eng.execute({ type: "listItem", item: item({ code: "X", priceCents: 6000, variants: [{ qty: 1 }] }) }, T0);
    eng.execute({ type: "listItem", item: item({ code: "Y", priceCents: 5000, variants: [{ qty: 1 }] }) }, T0);
    say(eng, { id: "1", user: "carol", ts: T0 + 1, item: "X" }, T0 + 10);
    say(eng, { id: "2", user: "alice", ts: T0 + 2, item: "X" }, T0 + 20);
    say(eng, { id: "3", user: "alice", ts: T0 + 3, item: "Y" }, T0 + 30);
    say(eng, { id: "4", user: "dave", ts: T0 + 4, item: "X" }, T0 + 40);
    say(eng, { id: "5", user: "carol", ts: T0 + 5, kind: "cancel", item: "X" }, T0 + 5000);

    expect(holders(eng.state, "X", "X-OS")).toEqual(["dave"]);
    const r = reviewQueue(eng.state);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ cause: "promotion-over-cap", buyerKey: key("alice") });
  });
});

describe("review lane", () => {
  it("parks low-confidence intents and grants them on approval", () => {
    const eng = show();
    blueDress(eng, 1);
    say(eng, { id: "low", user: "alice", ts: T0, item: "14", size: "M", confidence: 0.55, text: "omg me?" }, T0 + 10);
    expect(unitsOf(eng.state, "alice")).toEqual([]);
    const [r] = reviewQueue(eng.state);
    expect(r!.reason).toContain("confidence 0.55 below 0.80 (rule)");
    eng.execute({ type: "approveReview", reviewId: r!.id }, T0 + 5000);
    expect(unitsOf(eng.state, "alice")[0]).toMatchObject({ status: "held", capExempt: true, source: "review" });
    expect(reviewQueue(eng.state)).toEqual([]);
  });

  it("rejecting a review grants nothing", () => {
    const eng = show();
    blueDress(eng, 1);
    say(eng, { id: "low", user: "alice", ts: T0, item: "14", size: "M", confidence: 0.3 }, T0 + 10);
    eng.execute({ type: "rejectReview", reviewId: "R1", note: "joke comment" }, T0 + 100);
    expect(unitsOf(eng.state, "alice")).toEqual([]);
    expect(eng.state.reviews.R1!.status).toBe("rejected");
    const again = eng.execute({ type: "approveReview", reviewId: "R1" }, T0 + 200);
    expect(again[0]!.type).toBe("commandRejected");
  });

  it("sends an ambiguous variant to review and resolves it with the seller's patch", () => {
    const eng = show();
    eng.execute({ type: "listItem", item: item({ code: "7", variants: [{ size: "S", qty: 1 }, { size: "M", qty: 1 }, { size: "L", qty: 1 }] }) }, T0);
    say(eng, { id: "amb", user: "alice", ts: T0, item: "7" }, T0 + 10);
    const [r] = reviewQueue(eng.state);
    expect(r).toMatchObject({ cause: "ambiguous-variant" });
    expect(r!.reason).toContain("#7 is ambiguous for no size or colour: S, M, L");

    const refused = eng.execute({ type: "approveReview", reviewId: r!.id }, T0 + 20);
    expect(refused[0]!.type).toBe("commandRejected");
    expect(reviewQueue(eng.state)).toHaveLength(1);

    eng.execute({ type: "approveReview", reviewId: r!.id, patch: { size: "large" } }, T0 + 30);
    expect(unitsOf(eng.state, "alice")[0]).toMatchObject({ sku: "7-L", status: "held" });
  });

  it("treats questions and chatter as non-claims", () => {
    const eng = show();
    blueDress(eng, 1);
    const ev = say(eng, { id: "q", user: "alice", ts: T0, kind: "question", item: "14", text: "is 14 in red?" }, T0);
    expect(ev.map((e) => e.type)).toEqual(["intentIgnored"]);
    expect(unitsOf(eng.state, "alice")).toEqual([]);
  });
});

describe("idempotency", () => {
  it("applying the same comment twice is a no-op", () => {
    const eng = show();
    blueDress(eng, 2);
    const first = say(eng, { id: "dup", user: "alice", ts: T0, item: "14", size: "M", qty: 1 }, T0 + 10);
    expect(first.length).toBeGreaterThan(0);
    const before = eng.state;
    const second = say(eng, { id: "dup", user: "alice", ts: T0, item: "14", size: "M", qty: 1 }, T0 + 10);
    expect(second).toEqual([]);
    expect(eng.state).toBe(before);
    expect(unitsOf(eng.state, "alice")).toHaveLength(1);
  });

  it("a duplicate of a comment that went to review does not open a second review", () => {
    const eng = show();
    blueDress(eng, 2);
    say(eng, { id: "dup", user: "alice", ts: T0, item: "14", size: "M", confidence: 0.2 }, T0 + 10);
    say(eng, { id: "dup", user: "alice", ts: T0, item: "14", size: "M", confidence: 0.99 }, T0 + 20);
    expect(reviewQueue(eng.state)).toHaveLength(1);
    expect(unitsOf(eng.state, "alice")).toEqual([]);
  });
});

describe("claims before the item is listed", () => {
  it("parks them and applies them in platformTs order when the item goes live", () => {
    const eng = show();
    say(eng, { id: "early-2", user: "bob", ts: T0 + 100, item: "20" }, T0 + 110);
    say(eng, { id: "early-1", user: "alice", ts: T0 + 50, item: "20" }, T0 + 900);
    expect(eng.state.parked).toHaveLength(2);
    eng.execute({ type: "listItem", item: item({ code: "20", variants: [{ qty: 1 }] }) }, T0 + 5000);
    expect(holders(eng.state, "20", "20-OS")).toEqual(["alice"]);
    expect(statusOf(eng.state, "bob")).toEqual(["waitlisted"]);
    expect(eng.state.parked).toEqual([]);
  });

  it("moves claims for an item never listed to review at end of show", () => {
    const eng = show();
    say(eng, { id: "ghost", user: "alice", ts: T0, item: "77" }, T0);
    eng.execute({ type: "endShow" }, T0 + MIN);
    expect(reviewQueue(eng.state)[0]).toMatchObject({ cause: "never-listed", commentId: "ghost" });
  });
});

describe("seller overrides", () => {
  it("grants only from free stock, revokes with promotion, and reassigns", () => {
    const eng = show();
    blueDress(eng, 1);
    say(eng, { id: "a", user: "alice", ts: T0, item: "14", size: "M" }, T0);
    say(eng, { id: "b", user: "bob", ts: T0 + 1, item: "14", size: "M" }, T0 + 1);

    const refused = eng.execute({ type: "sellerGrant", buyer: buyer("phone-order"), itemCode: "14", sku: "14-M-BLUE" }, T0 + 10);
    expect(refused[0]!.reason).toContain("only 0 of #14 M blue free");

    const aUnit = unitsOf(eng.state, "alice")[0]!;
    eng.execute({ type: "sellerRevoke", unitId: aUnit.id, note: "duplicate account" }, T0 + 20);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["bob"]);

    const bUnit = unitsOf(eng.state, "bob")[0]!;
    eng.execute({ type: "sellerReassign", unitId: bUnit.id, to: buyer("carol") }, T0 + 30);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["carol"]);
    expect(eng.state.units[bUnit.id]).toMatchObject({ buyerKey: key("carol"), status: "held", capExempt: true });

    eng.execute({ type: "updateInventory", itemCode: "14", sku: "14-M-BLUE", qty: 2 }, T0 + 40);
    eng.execute({ type: "sellerGrant", buyer: buyer("phone-order"), itemCode: "14", sku: "14-M-BLUE" }, T0 + 50);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["carol", "phone-order"]);
    const granted = unitsOf(eng.state, "phone-order")[0]!;
    expect(granted.settleUntil).toBe(T0 + 50);
  });

  it("refuses to reassign a paid unit", () => {
    const eng = show();
    blueDress(eng, 1);
    say(eng, { id: "a", user: "alice", ts: T0, item: "14", size: "M" }, T0);
    const u = unitsOf(eng.state, "alice")[0]!;
    eng.execute({ type: "confirmPayment", unitIds: [u.id] }, T0 + 100);
    const r = eng.execute({ type: "sellerReassign", unitId: u.id, to: buyer("bob") }, T0 + 200);
    expect(r[0]!.reason).toContain("revoke and refund instead");
  });
});

describe("inventory updates", () => {
  it("promotes on increase and bumps the latest claims on decrease, never below paid units", () => {
    const eng = show();
    blueDress(eng, 2);
    for (const [u, ms] of [["a", 1], ["b", 2], ["c", 3]] as const) say(eng, { id: u, user: u, ts: T0 + ms, item: "14", size: "M" }, T0 + 10 + ms);
    expect(statusOf(eng.state, "c")).toEqual(["waitlisted"]);

    eng.execute({ type: "updateInventory", itemCode: "14", sku: "14-M-BLUE", qty: 3 }, T0 + 5000);
    expect(statusOf(eng.state, "c")).toEqual(["held"]);

    eng.execute({ type: "updateInventory", itemCode: "14", sku: "14-M-BLUE", qty: 1 }, T0 + 6000);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["a"]);
    expect(itemBoard(eng.state)[0]!.variants[0]!.waitlist.map((w) => w.displayName)).toEqual(["b", "c"]);

    eng.execute({ type: "confirmPayment", unitIds: [unitsOf(eng.state, "a")[0]!.id] }, T0 + 7000);
    const refused = eng.execute({ type: "updateInventory", itemCode: "14", sku: "14-M-BLUE", qty: 0 }, T0 + 8000);
    expect(refused[0]!.reason).toContain("1 units are paid or billed");
    expect(oversold(eng.state)).toEqual([]);
  });

  it("adds a new variant", () => {
    const eng = show();
    blueDress(eng, 1);
    eng.execute({ type: "updateInventory", itemCode: "14", sku: "14-L-BLUE", qty: 2, size: "L", color: "blue" }, T0);
    say(eng, { id: "l", user: "alice", ts: T0 + 1, item: "14", size: "L" }, T0 + 2);
    expect(unitsOf(eng.state, "alice")[0]).toMatchObject({ sku: "14-L-BLUE", status: "held" });
  });
});

describe("changes and cancels", () => {
  it("swaps a held unit to another size and promotes the old size's waitlist", () => {
    const eng = show();
    eng.execute({ type: "listItem", item: item({ code: "12", variants: [{ size: "M", color: "blue", qty: 1 }, { size: "L", color: "blue", qty: 1 }] }) }, T0);
    say(eng, { id: "1", user: "alice", ts: T0 + 1, item: "12", size: "M" }, T0 + 10);
    say(eng, { id: "2", user: "bob", ts: T0 + 2, item: "12", size: "M" }, T0 + 20);
    say(eng, { id: "3", user: "alice", ts: T0 + 3000, kind: "change", item: "12", size: "L", text: "actually L" }, T0 + 3010);
    expect(unitsOf(eng.state, "alice").map((u) => [u.sku, u.status])).toEqual([["12-M-BLUE", "released"], ["12-L-BLUE", "held"]]);
    expect(holders(eng.state, "12", "12-M-BLUE")).toEqual(["bob"]);
  });

  it("routes a change to a sold-out size to review and keeps the original unit", () => {
    const eng = show();
    eng.execute({ type: "listItem", item: item({ code: "12", variants: [{ size: "M", qty: 1 }, { size: "L", qty: 1 }] }) }, T0);
    say(eng, { id: "1", user: "alice", ts: T0 + 1, item: "12", size: "M" }, T0 + 10);
    say(eng, { id: "2", user: "bob", ts: T0 + 2, item: "12", size: "L" }, T0 + 20);
    say(eng, { id: "3", user: "alice", ts: T0 + 3000, kind: "change", item: "12", size: "L" }, T0 + 3010);
    expect(statusOf(eng.state, "alice")).toEqual(["held"]);
    expect(reviewQueue(eng.state)[0]).toMatchObject({ cause: "change-unavailable" });
  });

  it("sends a cancel of a paid unit to review; approval releases it with a refund due", () => {
    const eng = show();
    blueDress(eng, 1);
    say(eng, { id: "a", user: "alice", ts: T0, item: "14", size: "M" }, T0);
    say(eng, { id: "b", user: "bob", ts: T0 + 1, item: "14", size: "M" }, T0 + 1);
    eng.execute({ type: "confirmPayment", unitIds: [unitsOf(eng.state, "alice")[0]!.id] }, T0 + 100);
    say(eng, { id: "c", user: "alice", ts: T0 + 200, kind: "cancel", item: "14" }, T0 + 210);
    expect(statusOf(eng.state, "alice")).toEqual(["confirmed"]);
    const [r] = reviewQueue(eng.state);
    expect(r).toMatchObject({ cause: "paid-cancel" });
    const ev = eng.execute({ type: "approveReview", reviewId: r!.id }, T0 + 300);
    expect(ofType(ev, "unitReleased")[0]).toMatchObject({ refundDue: true });
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["bob"]);
  });

  it("a waitlisted buyer can cancel without touching holders", () => {
    const eng = show();
    blueDress(eng, 1);
    say(eng, { id: "a", user: "alice", ts: T0, item: "14", size: "M" }, T0);
    say(eng, { id: "b", user: "bob", ts: T0 + 1, item: "14", size: "M" }, T0 + 1);
    say(eng, { id: "c", user: "bob", ts: T0 + 2, kind: "cancel", item: "14" }, T0 + 2);
    expect(statusOf(eng.state, "bob")).toEqual(["released"]);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["alice"]);
    const ignored = say(eng, { id: "d", user: "bob", ts: T0 + 3, kind: "cancel", item: "14" }, T0 + 3);
    expect(ignored.map((e) => e.type)).toEqual(["intentIgnored"]);
  });
});

describe("end show, carts and close-out", () => {
  function closeOut() {
    const eng = show({ shipping: { firstItemCents: 800, perExtraItemCents: 200, freeOverCents: 10_000 } });
    eng.execute({ type: "listItem", item: item({ code: "14", title: "Floral wrap dress", priceCents: 3800, variants: [{ size: "M", color: "blue", qty: 2 }, { size: "L", color: "blue", qty: 1 }] }) }, T0);
    eng.execute({ type: "listItem", item: item({ code: "15", title: "Ribbed top", priceCents: 2200, variants: [{ size: "S", qty: 3 }] }) }, T0);
    for (const u of ["alice", "carol", "dave"]) eng.execute({ type: "saveClaimPass", buyer: buyer(u) }, T0);
    say(eng, { id: "1", user: "alice", ts: T0 + 1, item: "14", size: "M" }, T0 + 10);
    say(eng, { id: "2", user: "alice", ts: T0 + 2, item: "15", size: "S", qty: 2 }, T0 + 20);
    say(eng, { id: "3", user: "bob", ts: T0 + 3, item: "14", size: "L" }, T0 + 30);
    say(eng, { id: "4", user: "carol", ts: T0 + 4, item: "14", size: "M" }, T0 + 40);
    say(eng, { id: "5", user: "carol", ts: T0 + 5, item: "15", size: "S" }, T0 + 50);
    say(eng, { id: "6", user: "dave", ts: T0 + 6, item: "14", size: "M" }, T0 + 60);
    eng.execute({ type: "confirmPayment", unitIds: [unitsOf(eng.state, "bob")[0]!.id], orderId: "PN-1" }, T0 + MIN);
    return eng;
  }

  it("builds one cart per buyer with combined shipping and deterministic PayPal ids", () => {
    const eng = closeOut();
    eng.execute({ type: "endShow" }, T0 + 30 * MIN);
    const late = say(eng, { id: "late", user: "erin", ts: T0 + 30 * MIN + 5, item: "15", size: "S" }, T0 + 30 * MIN + 10);
    expect(late[0]!.reason).toContain("show has ended");

    const ev = eng.execute({ type: "finalizeCarts" }, T0 + 31 * MIN);
    const carts = ofType(ev, "cartsFinalized")[0]!.carts;
    expect(carts.map((c) => c.displayName)).toEqual(["alice", "bob", "carol"]);

    const [alice, bob, carol] = carts;
    expect(alice).toMatchObject({
      invoiceId: "show1-room:alice",
      requestId: "show1-room:alice",
      chargeMode: "vault",
      units: 3,
      subtotalCents: 3800 + 2 * 2200,
      shippingCents: 800 + 2 * 200,
      totalCents: 8200 + 1200,
      paidCents: 0,
      dueCents: 9400,
      capCents: 15_000,
    });
    expect(alice!.lines.map((l) => [l.itemCode, l.size, l.qty, l.lineCents])).toEqual([
      ["14", "M", 1, 3800],
      ["15", "S", 2, 4400],
    ]);
    expect(bob).toMatchObject({ chargeMode: "pay-now", subtotalCents: 3800, shippingCents: 800, paidCents: 3800, dueCents: 800 });
    expect(bob!.flags).toContain("pay-now-balance");
    expect(carol).toMatchObject({ subtotalCents: 6000, shippingCents: 1000, totalCents: 7000 });
    expect(buyerCarts(eng.state).find((b) => b.displayName === "dave")).toMatchObject({ waitlisted: 1, finalized: [] });

    const again = eng.execute({ type: "finalizeCarts" }, T0 + 32 * MIN);
    expect(again[0]!.reason).toContain("no confirmed units waiting to be billed");
  });

  it("refuses to finalize before the show ends", () => {
    const eng = closeOut();
    expect(eng.execute({ type: "finalizeCarts" }, T0 + MIN)[0]!.reason).toContain("end the show");
  });

  it("gives free shipping over the threshold", () => {
    const eng = show({ shipping: { firstItemCents: 800, perExtraItemCents: 200, freeOverCents: 10_000 }, cap: {} });
    eng.execute({ type: "listItem", item: item({ code: "9", priceCents: 5000, variants: [{ qty: 5 }] }) }, T0);
    eng.execute({ type: "saveClaimPass", buyer: buyer("big") }, T0);
    say(eng, { id: "1", user: "big", ts: T0, item: "9", qty: 2 }, T0);
    eng.execute({ type: "endShow" }, T0 + 1);
    const cart = ofType(eng.execute({ type: "finalizeCarts" }, T0 + 2), "cartsFinalized")[0]!.carts[0]!;
    expect(cart).toMatchObject({ subtotalCents: 10_000, shippingCents: 0, totalCents: 10_000 });
  });

  it("cascades a declined charge: pay-now link, then waitlist, then a supplementary cart", () => {
    const eng = closeOut();
    eng.execute({ type: "endShow" }, T0 + 30 * MIN);
    eng.execute({ type: "finalizeCarts" }, T0 + 31 * MIN);
    eng.execute({ type: "recordCharge", cartId: "show1-room:alice", outcome: "completed", orderId: "ORD-A" }, T0 + 32 * MIN);
    expect(statusOf(eng.state, "alice")).toEqual(["charged", "charged", "charged"]);
    expect(eng.state.carts["show1-room:alice"]).toMatchObject({ status: "charged", orderId: "ORD-A" });

    eng.execute({ type: "recordCharge", cartId: "show1-room:carol", outcome: "declined", note: "INSTRUMENT_DECLINED" }, T0 + 32 * MIN);
    expect(eng.state.buyers[key("carol")]!.pass).toBeUndefined();
    const carolUnits = unitsOf(eng.state, "carol");
    expect(carolUnits.map((u) => [u.status, u.leaseExpiresAt])).toEqual([
      ["held", T0 + 47 * MIN],
      ["held", T0 + 47 * MIN],
    ]);

    const top = carolUnits.find((u) => u.itemCode === "15")!;
    eng.execute({ type: "confirmPayment", unitIds: [top.id] }, T0 + 40 * MIN);
    eng.execute({ type: "tick" }, T0 + 47 * MIN);
    expect(holders(eng.state, "14", "14-M-BLUE")).toEqual(["alice", "dave"]);
    expect(unitsOf(eng.state, "dave")[0]).toMatchObject({ status: "confirmed", via: "claim-pass" });

    const carts = ofType(eng.execute({ type: "finalizeCarts" }, T0 + 48 * MIN), "cartsFinalized")[0]!.carts;
    expect(carts.map((c) => [c.invoiceId, c.seq, c.totalCents, c.dueCents])).toEqual([
      ["show1-room:carol-2", 2, 2200 + 800, 800],
      ["show1-room:dave", 1, 3800 + 800, 4600],
    ]);
    expect(oversold(eng.state)).toEqual([]);
  });
});

describe("audit log and replay", () => {
  it("records a reason for every decision and replays to the same state", () => {
    const eng = show();
    blueDress(eng, 1);
    say(eng, { id: "room-1", user: "rita", ts: T0 + 480, item: "14", size: "M" }, T0 + 490);
    say(eng, { id: "tw-1", user: "tom", ts: T0 + 120, item: "14", size: "M", platform: "twitch" }, T0 + 546);
    eng.execute({ type: "tick" }, T0 + 20 * MIN);

    const log = auditLog(eng.events);
    expect(log.every((e) => e.reason.length > 0)).toBe(true);
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(log.find((e) => e.type === "unitGranted" && e.buyerKey === undefined && e.reason.includes("tom"))?.time).toBe("12:01:03.546");
    expect(replay(eng.state.config, eng.events)).toEqual(eng.state);
  });
});
