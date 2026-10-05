import { describe, expect, it } from "vitest";
import { makeConfig } from "../config.js";
import { createEngine } from "../engine.js";
import { replay } from "../state.js";
import { T0, comment, holders, item } from "./fixtures.js";

function twoItems() {
  const eng = createEngine(makeConfig("show1"));
  eng.execute({ type: "listItem", item: item({ code: "7", variants: [{ size: "M", qty: 1 }] }) }, T0 - 5000);
  eng.execute({ type: "listItem", item: item({ code: "8", variants: [{ size: "M", qty: 1 }] }) }, T0 - 5000);
  return eng;
}

const base = { commentId: "c1", confidence: 0.97, method: "rule" as const };

describe("a comment that names several items", () => {
  it("applies every intent, not just the first", () => {
    const eng = twoItems();
    const c = comment({ id: "c1", user: "alice", ts: T0, text: "7 M and 8 M" }, T0 + 20);
    eng.execute({ type: "applyIntent", comment: c, intent: { ...base, kind: "claim", itemCode: "7", size: "M", intentIndex: 0 } }, T0 + 20);
    eng.execute({ type: "applyIntent", comment: c, intent: { ...base, kind: "claim", itemCode: "8", size: "M", intentIndex: 1 } }, T0 + 20);
    expect(holders(eng.state, "7", "7-M")).toEqual(["alice"]);
    expect(holders(eng.state, "8", "8-M")).toEqual(["alice"]);
  });

  it("stays idempotent per intent on replay of the same command", () => {
    const eng = twoItems();
    const c = comment({ id: "c1", user: "alice", ts: T0, text: "7 M and 8 M" }, T0 + 20);
    const second = { ...base, kind: "claim" as const, itemCode: "8", size: "M", intentIndex: 1 };
    eng.execute({ type: "applyIntent", comment: c, intent: second }, T0 + 20);
    const again = eng.execute({ type: "applyIntent", comment: c, intent: second }, T0 + 30);
    expect(again).toEqual([]);
    expect(replay(eng.state.config, eng.events)).toEqual(eng.state);
  });
});

describe("a cross-item swap", () => {
  it("claims the new item and releases the old one to the waitlist head", () => {
    const eng = twoItems();
    const say = (id: string, user: string, ts: number, text: string, intent: Record<string, unknown>) =>
      eng.execute({ type: "applyIntent", comment: comment({ id, user, ts, text }, ts + 20), intent: { ...base, commentId: id, ...intent } as never }, ts + 20);
    say("a1", "alice", T0, "7 M", { kind: "claim", itemCode: "7", size: "M" });
    say("b1", "bob", T0 + 500, "7 M", { kind: "claim", itemCode: "7", size: "M" });
    eng.execute({ type: "tick" }, T0 + 5000);
    say("a2", "alice", T0 + 6000, "cancel my 7 take 8", { kind: "change", fromItemCode: "7", itemCode: "8", size: "M" });
    expect(holders(eng.state, "8", "8-M")).toEqual(["alice"]);
    expect(holders(eng.state, "7", "7-M")).toEqual(["bob"]);
  });
});
