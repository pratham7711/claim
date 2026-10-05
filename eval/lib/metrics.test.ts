import type { ResolvedIntent } from "@claim/resolver";
import { describe, expect, it } from "vitest";
import type { Example, Gold } from "./data.js";
import { judgeGrants, kindCorrect, pct, score } from "./metrics.js";

const ex = (gold: Partial<Gold>): Example => ({ id: "x", show: "s", current: "1", text: "", tags: [], gold: { kind: "claim", items: [], from: null, ...gold } });
const claim = (itemCode: string, confidence = 0.9, extra: Partial<ResolvedIntent> = {}): ResolvedIntent => ({ commentId: "x", kind: "claim", itemCode, confidence, method: "rule", ...extra });
const item = (code: string, size: string | null = null, color: string | null = null) => ({ code, size, color, qty: null });

describe("eval metrics", () => {
  it("flags a granted wrong item and a granted non-claim as harmful", () => {
    expect(judgeGrants(ex({ items: [item("4")] }), [claim("5")])[0]!.harmful).toBe(true);
    expect(judgeGrants(ex({ kind: "question" }), [claim("4")])[0]!.harmful).toBe(true);
    expect(judgeGrants(ex({ items: [item("4")] }), [claim("4", 0.7)])).toEqual([]);
  });

  it("matches repeated codes with different variants", () => {
    const gold = ex({ items: [item("7", "S", "red"), item("7", "M", "green")] });
    const v = judgeGrants(gold, [claim("7", 0.9, { size: "S", color: "red" }), claim("7", 0.9, { size: "M", color: "green" })]);
    expect(v.every((g) => !g.harmful && !g.wrongVariant)).toBe(true);
  });

  it("accepts any non-grant for a claim nobody can place", () => {
    expect(kindCorrect(ex({}), [claim("3", 0.5)])).toBe(true);
    expect(kindCorrect(ex({}), [claim("3", 0.9, { kind: "change" })])).toBe(false);
    expect(judgeGrants(ex({}), [claim("3", 0.9)])[0]!.harmful).toBe(true);
  });

  it("computes precision, recall and percentiles", () => {
    const m = score([
      { ex: ex({ items: [item("1"), item("2")] }), pred: [claim("1")], latencyMs: 1, viaLlm: false },
      { ex: ex({ kind: "other" }), pred: [claim("9")], latencyMs: 100, viaLlm: true },
    ]);
    expect(m.itemP).toBe(0.5);
    expect(m.itemR).toBe(0.5);
    expect(m.grantPrecision).toBe(0.5);
    expect(m.harmfulRate).toBe(0.5);
    expect(pct([1, 2, 3, 4, 100], 95)).toBe(100);
    expect(pct([1, 2, 3, 4, 100], 50)).toBe(3);
  });
});
