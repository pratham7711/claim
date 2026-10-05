import { describe, expect, it } from "vitest";
import { ruleResolve, type RuleIntent } from "./rules.js";
import { ctxOn, FULL } from "./test-fixtures.js";

const r = (text: string, ctx = FULL) => ruleResolve(text, ctx);
const first = (text: string, ctx = FULL): RuleIntent => r(text, ctx).intents[0]!;
const granted = (i: RuleIntent) => (i.kind === "claim" || i.kind === "change") && !!i.itemCode && i.confidence >= 0.8;

describe("code vs size", () => {
  it("reads '12' as the item when item 12 is on screen", () => {
    expect(first("12", ctxOn("12"))).toMatchObject({ kind: "claim", itemCode: "12" });
  });

  it("reads 'size 12' as a size of the on-screen item", () => {
    expect(first("size 12", ctxOn("11"))).toMatchObject({ kind: "claim", itemCode: "11", size: "12" });
    expect(first("12 size 12", ctxOn("12"))).toMatchObject({ kind: "claim", itemCode: "12", size: "12", confidence: 0.85 });
  });

  it("treats a bare number that is both a code and an on-screen size as ambiguous", () => {
    const out = r("12");
    expect(out.needsLlm).toBe(true);
    expect(granted(out.intents[0]!)).toBe(false);
  });

  it("a # marker or a letter size settles it as a code", () => {
    expect(first("#12")).toMatchObject({ kind: "claim", itemCode: "12" });
    expect(first("sold 7 M")).toMatchObject({ itemCode: "7", size: "M" });
  });

  it("a size after a code belongs to that code", () => {
    expect(first("sold 11 in 10 red")).toMatchObject({ itemCode: "11", size: "10", color: "red", confidence: 0.95 });
  });
});

describe("tricky claims", () => {
  it("'11 or 12' is ambiguous, not a claim", () => {
    expect(first("11 or 12")).toMatchObject({ kind: "question", confidence: 0.3 });
  });

  it("'not 12' never grants 12", () => {
    expect(r("not 12").intents.some((i) => i.kind === "claim" && i.itemCode === "12")).toBe(false);
  });

  it("'12 not 11' is a change away from 11", () => {
    expect(first("12 not 11")).toMatchObject({ kind: "change", itemCode: "12", fromItemCode: "11" });
  });

  it("'cancel my 7 take 8' is a change from 7 to 8", () => {
    const i = first("cancel my 7 take 8");
    expect(i).toMatchObject({ kind: "change", itemCode: "8", fromItemCode: "7" });
    expect(i.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("'lol 10/10' is a rating, not a claim", () => {
    expect(first("lol 10/10")).toMatchObject({ kind: "other" });
  });

  it("'$12?' is a price question", () => {
    const i = first("$12?");
    expect(i.kind).toBe("question");
    expect(i.itemCode).toBeUndefined();
  });

  it("'12 no wait 11' claims 11", () => {
    expect(r("12 no wait 11 10 red").intents).toEqual([expect.objectContaining({ kind: "claim", itemCode: "11", size: "10", color: "red" })]);
  });
});

describe("cues and the on-screen item", () => {
  it.each(["sold", "SOOOLD", "me!!", "mine 🙋‍♀️", "🙋"])("%s claims the item on screen", (text) => {
    expect(first(text, ctxOn("8"))).toMatchObject({ kind: "claim", itemCode: "8" });
  });

  it("skips the LLM when the rule hit is clean", () => {
    const out = r("sold 7 black M x2");
    expect(out.needsLlm).toBe(false);
    expect(out.intents).toEqual([expect.objectContaining({ kind: "claim", itemCode: "7", size: "M", color: "black", qty: 2, confidence: 0.95 })]);
  });

  it("normalises keycaps, 'no.' and 'num'", () => {
    expect(first("sold 7️⃣ blk L")).toMatchObject({ itemCode: "7", size: "L", color: "black" });
    expect(first("no. 8 M")).toMatchObject({ kind: "claim", itemCode: "8", size: "M" });
    expect(first("num 8 M please")).toMatchObject({ kind: "claim", itemCode: "8", size: "M" });
  });

  it("splits several items into several intents, in order", () => {
    expect(r("sold 7 and 8").intents.map((i) => i.itemCode)).toEqual(["7", "8"]);
  });

  it("never invents a code that is not in the show", () => {
    const i = first("sold 99");
    expect(i.kind).toBe("question");
    expect(i.itemCode).toBeUndefined();
    expect(i.confidence).toBeLessThanOrEqual(0.3);
  });

  it("caps confidence when the variant is missing or not offered", () => {
    expect(first("sold 7").confidence).toBe(0.75);
    expect(first("sold 7 purple M").confidence).toBe(0.6);
  });

  it("does not claim on chatter or hypotheticals", () => {
    expect(granted(first("omg 12 is gorgeous"))).toBe(false);
    expect(first("wish I could claim but I'm broke").kind).toBe("other");
    expect(first("is it sold?").kind).toBe("question");
    expect(first("sold out already?").kind).toBe("question");
  });
});

describe("cancel, change, waitlist, questions", () => {
  it("cancels", () => {
    expect(first("cancel 7")).toMatchObject({ kind: "cancel", itemCode: "7" });
    expect(first("jk")).toMatchObject({ kind: "cancel" });
  });

  it("changes a variant or an item", () => {
    expect(first("make mine an L", ctxOn("7"))).toMatchObject({ kind: "change", itemCode: "7", size: "L" });
    expect(first("8 instead of 7")).toMatchObject({ kind: "change", itemCode: "8", fromItemCode: "7" });
  });

  it("waitlists", () => {
    expect(first("waitlist 8")).toMatchObject({ kind: "waitlist", itemCode: "8" });
    expect(first("if anyone cancels I'll take it", ctxOn("8"))).toMatchObject({ kind: "waitlist", itemCode: "8" });
  });

  it("asks", () => {
    expect(first("is 12 still available?")).toMatchObject({ kind: "question", itemCode: "12" });
    expect(first("how much is shipping")).toMatchObject({ kind: "question" });
  });
});

describe("Hinglish and Spanish", () => {
  it("reads Hinglish claims, changes and questions", () => {
    expect(first("7 black M chahiye")).toMatchObject({ kind: "claim", itemCode: "7", size: "M", color: "black" });
    expect(first("ye mera book kar do", ctxOn("8"))).toMatchObject({ kind: "claim", itemCode: "8" });
    expect(first("7 nahi 8 kar do")).toMatchObject({ kind: "change", itemCode: "8", fromItemCode: "7" });
    expect(first("kitne ka hai")).toMatchObject({ kind: "question" });
    expect(first("kya baat hai 🔥").kind).toBe("other");
  });

  it("reads Spanish claims", () => {
    expect(first("lo quiero 7 negro M")).toMatchObject({ kind: "claim", itemCode: "7", size: "M", color: "black" });
  });
});
