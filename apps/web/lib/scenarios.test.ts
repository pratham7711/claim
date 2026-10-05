import { describe, expect, it } from "vitest";
import type { BoardItem } from "@claim/core";
import { buildScript } from "./scenarios";
import { percentile, baseCommentId } from "./stats";

const item: BoardItem = {
  code: "12",
  title: "Cardigan",
  priceCents: 3400,
  variants: [
    { sku: "12-M", size: "M", qty: 2, sold: 0, held: 0, available: 2, settling: 0, waitlist: [] },
    { sku: "12-L", size: "L", qty: 1, sold: 0, held: 0, available: 1, settling: 0, waitlist: [] },
  ],
};

describe("scenario scripts", () => {
  it("races four buyers for the variant with two left", () => {
    const s = buildScript("race", item);
    expect(s.lines).toHaveLength(4);
    expect(new Set(s.lines.map((l) => l.user)).size).toBe(4);
    expect(s.lines.every((l) => / M\b|M /.test(` ${l.text} `))).toBe(true);
  });

  it("makes the jitter comment earlier in platform time but later in arrival", () => {
    const [a, b] = buildScript("jitter", item).lines;
    expect(b!.tsMs).toBeLessThan(a!.tsMs);
    expect(b!.arriveMs).toBeGreaterThan(a!.arriveMs);
    expect(b!.arriveMs - a!.arriveMs).toBeLessThan(2000);
  });

  it("reuses an existing holder for the cancel scenario when one is given", () => {
    expect(buildScript("cancel", item, { user: "dana", itemCode: "12" }).lines).toEqual([
      expect.objectContaining({ user: "dana", text: expect.stringMatching(/cancel 12/) }),
    ]);
    expect(buildScript("cancel", item).lines).toHaveLength(3);
  });
});

describe("stats", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });

  it("strips the engine's per-intent suffix", () => {
    expect(baseCommentId("c1#2")).toBe("c1");
    expect(baseCommentId("c1")).toBe("c1");
  });
});
