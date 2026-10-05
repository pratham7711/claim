import { describe, expect, it } from "vitest";
import type { Example } from "./lib/data.js";
import { kappa, merge } from "./merge-labels.js";

const row = (kind: Example["gold"]["kind"], items: Example["gold"]["items"] = []): Example => ({
  id: "x",
  show: "s",
  current: "1",
  text: "t",
  gold: { kind, items, from: null },
  tags: [],
});
const item = (code: string, size: string | null = null, color: string | null = null) => ({ code, size, color, qty: null });

describe("merge-labels", () => {
  it("keeps agreed labels and nulls a disputed variant", () => {
    expect(merge(row("claim", [item("4", "M", "red")]), row("claim", [item("4", "M", "blue")])).gold.items).toEqual([item("4", "M", null)]);
    expect(merge(row("other"), row("other")).tags).toEqual([]);
  });

  it("turns a claim-vs-not disagreement into a review-only claim", () => {
    const m = merge(row("claim", [item("4")]), row("question"));
    expect(m.gold).toEqual({ kind: "claim", items: [], from: null });
    expect(m.tags).toContain("disputed");
  });

  it("drops item codes the annotators do not share", () => {
    expect(merge(row("claim", [item("4"), item("5")]), row("claim", [item("5")])).gold.items).toEqual([item("5")]);
  });

  it("computes Cohen's kappa", () => {
    expect(kappa([["a", "a"], ["b", "b"]])).toBe(1);
    expect(kappa([["a", "a"], ["a", "b"], ["b", "a"], ["b", "b"]])).toBeCloseTo(0);
  });
});
