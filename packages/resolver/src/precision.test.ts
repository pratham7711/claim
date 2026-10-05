import type { ResolverContext, ShowItem } from "@claim/core";
import { createMockClient } from "@claim/llm";
import { describe, expect, it } from "vitest";
import { buildUserPrompt, SYSTEM_PROMPT } from "./llm-stage.js";
import { normalize } from "./normalize.js";
import { resolveBatch } from "./resolve.js";
import { REVIEW_CAP, commentEvidence, ruleResolve, type RuleIntent } from "./rules.js";
import { FULL, ITEMS, ctxOn } from "./test-fixtures.js";

const scarf: ShowItem = { code: "5", title: "Silk scarf", priceCents: 1800, variants: [{ sku: "5", qty: 3 }] };
/** One single-variant item on screen, so a bare "sold" can be granted. */
const SCARF: ResolverContext = { currentItem: scarf, items: [scarf, ...FULL.items] };
const comic = (code: string, title: string): ShowItem => ({ code, title, priceCents: 4000, variants: [{ sku: code, qty: 1 }] });
const GRADED: ResolverContext = { currentItem: comic("3", "Comic book"), items: [comic("3", "Comic book"), comic("9", "Annual"), comic("4", "Variant cover")] };

const first = (text: string, ctx: ResolverContext = SCARF): RuleIntent => ruleResolve(text, ctx).intents[0]!;
const granted = (i: RuleIntent) => (i.kind === "claim" || i.kind === "change") && !!i.itemCode && i.confidence >= 0.8;
const grants = (text: string, ctx: ResolverContext = SCARF) => ruleResolve(text, ctx).intents.filter(granted);

describe("unambiguous first-person claims still grant", () => {
  it.each(["sold", "me!", "mine pls", "I'll take it", "book kar do", "ye mere liye kar do", "muje bhi krdo", "मुझे यह चाहिए"])("%s", (text) => {
    expect(first(text)).toMatchObject({ kind: "claim", itemCode: "5" });
    expect(granted(first(text))).toBe(true);
  });

  it("a name after a coded claim does not block it", () => {
    expect(first("sold 7 black M for jenny", FULL)).toMatchObject({ kind: "claim", itemCode: "7", size: "M", color: "black" });
    expect(granted(first("sold 7 black M for jenny", FULL))).toBe(true);
  });

  it("digits inside a username are not a second number", () => {
    expect(grants("kat_lover77 sold 7 black M", FULL).map((i) => i.itemCode)).toEqual(["7"]);
    expect(grants("bee202 sold 8 S", FULL).map((i) => i.itemCode)).toEqual(["8"]);
  });
});

describe("speaker attribution", () => {
  it.each(["Jess wants it", "she needs this one", "he wants 7 black M", "my cousin wants 8 S", "usko ye chahiye"])("someone else's claim: %s", (text) => {
    const out = ruleResolve(text, SCARF);
    expect(out.intents.some(granted)).toBe(false);
    expect(out.llmCap).toBe(REVIEW_CAP);
  });

  it.each(["not me", "not mine lol", "not for me", "mera nahi"])("negated cue: %s", (text) => {
    const out = ruleResolve(text, SCARF);
    expect(out.intents[0]!.kind).not.toBe("claim");
    expect(out.llmCap).toBe(REVIEW_CAP);
  });

  it.each(["I claimed it already", "bought one last week", "got it yesterday", "maine bhi book kiya tha", "booking ho gayi meri"])("past report: %s", (text) => {
    const out = ruleResolve(text, SCARF);
    expect(out.intents.some(granted)).toBe(false);
    expect(out.llmCap).toBe(REVIEW_CAP);
  });

  it.each(["claim the giveaway", "I want the stand behind you", "need the box it came in"])("cue aimed at a non-item: %s", (text) => {
    const out = ruleResolve(text, SCARF);
    expect(out.intents.some(granted)).toBe(false);
    expect(out.llmCap).toBe(REVIEW_CAP);
  });

  it("a cue whose object is a catalogue title still claims that item", () => {
    expect(first("I want the denim jacket in M", FULL)).toMatchObject({ kind: "claim", itemCode: "8", size: "M" });
  });
});

describe("number lists", () => {
  it("two or more numbers where one is not a listed code never grant", () => {
    for (const text of ["7 3 9", "5 2 6", "sold 8 S 44"]) {
      const out = ruleResolve(text, SCARF);
      expect(out.intents.some(granted)).toBe(false);
      expect(out.llmCap).toBe(REVIEW_CAP);
    }
  });

  it("several listed codes with their variants still grant each", () => {
    expect(grants("sold 7 M black and 8 S", FULL).map((i) => i.itemCode)).toEqual(["7", "8"]);
  });

  it("a bare code without a cue stays below 0.9, and a bare single digit goes to review", () => {
    for (const text of ["8 S", "12 10", "#8 M"]) expect(first(text, FULL).confidence).toBeLessThan(0.9);
    expect(granted(first("8 S", ctxOn("8")))).toBe(true);
    expect(granted(first("5"))).toBe(false);
  });

  it("a bare code for an item that is not on screen goes to review, a claim word still grants it", () => {
    for (const text of ["8 S", "8", "#8 M please"]) expect(granted(first(text, FULL))).toBe(false);
    expect(ruleResolve("8 S", FULL).needsLlm).toBe(false);
    expect(granted(first("sold 8 S", FULL))).toBe(true);
    expect(commentEvidence("8 S", FULL).cue).toBe(false);
    expect(commentEvidence("8 S", ctxOn("8")).cue).toBe(true);
  });
});

describe("grades", () => {
  it("a decimal after a claim cue is a grade of the on-screen item, not a code", () => {
    for (const text of ["claim 9.6", "9.8 claim pls"]) {
      const i = first(text, GRADED);
      expect(i).toMatchObject({ kind: "claim", itemCode: "3" });
      expect(i.confidence).toBeLessThanOrEqual(0.85);
    }
  });

  it("with nothing on screen a graded claim is not granted", () => {
    const noScreen: ResolverContext = { items: GRADED.items };
    expect(grants("claim 9.6", noScreen)).toHaveLength(0);
  });
});

describe("how-to questions", () => {
  it.each(["how can i book this", "kaise book kare", "kis number pe book karna hai"])("%s", (text) => {
    expect(first(text)).toMatchObject({ kind: "question" });
  });
});

describe("routing instead of settling as chatter", () => {
  it.each(["ye wala", "iska", "Zorbix please", "bahut sundar hai", "बहुत सुंदर"])("%s goes to the LLM", (text) => {
    const out = ruleResolve(text, SCARF);
    expect(out.needsLlm).toBe(true);
    expect(out.intents.some(granted)).toBe(false);
  });

  it("plain English chatter is still settled without the LLM", () => {
    const out = ruleResolve("omg so cute", SCARF);
    expect(out).toMatchObject({ needsLlm: false, intents: [expect.objectContaining({ kind: "other" })] });
  });

  it("Devanagari question words are read as questions", () => {
    expect(first("कितने का है")).toMatchObject({ kind: "question" });
  });
});

describe("Hinglish spelling normaliser", () => {
  it("maps spelling variants onto one form", () => {
    expect(normalize("muje bhi krdo").text).toBe("mujhe bhi kar do");
    expect(normalize("ye bhi book krni he").text).toBe("ye bhi book karni hai");
    expect(normalize("mujhe chaiye nhi").text).toBe("mujhe chahiye nahi");
    expect(normalize("मुझे यह साड़ी चाहिए").text).toBe("mujhe ye saree chahiye");
  });

  it("leaves English 'he' alone outside a Hindi comment", () => {
    expect(normalize("he wants it").text).toBe("he wants it");
    expect(normalize("he wants it").hindi).toBe(false);
  });
});

describe("LLM answers on capped comments", () => {
  const claimAll = () =>
    createMockClient({
      fallback: (req) => {
        const ids = [...String(req.messages.at(-1)!.content).matchAll(/"id":"(c\d+)"/g)].map((m) => m[1]!);
        return { results: ids.map((id) => ({ id, kind: "claim", items: [{ code: "5", size: null, color: null, qty: null }], from: null, confidence: 0.95, reason: "test" })) };
      },
    });

  it("cannot auto-grant someone else's claim, a negated cue, or a number list", async () => {
    const texts = ["Jess wants it", "not me", "5 2 6", "got it yesterday"];
    const out = await resolveBatch(texts.map((text, i) => ({ id: `k${i}`, text })), SCARF, { llm: claimAll(), mode: "llm" });
    for (const intents of out) {
      expect(intents[0]!.confidence).toBeLessThanOrEqual(REVIEW_CAP);
      expect(intents[0]!.rationale).toMatch(/capped|no claim word/);
    }
  });

  it("can still grant a claim the rules only routed", async () => {
    const out = await resolveBatch([{ id: "a", text: "zorbix sold" }], SCARF, { llm: claimAll() });
    expect(out[0]![0]).toMatchObject({ kind: "claim", itemCode: "5", method: "llm", confidence: 0.95 });
  });

  it("the prompt states the not-the-speaker rule and the claim/question split", () => {
    expect(SYSTEM_PROMPT).toMatch(/Not the speaker's claim/);
    expect(SYSTEM_PROMPT).toMatch(/request to reserve an item is a claim/);
    expect(ITEMS["8"]!.title).toBe("Denim jacket");
  });
});

const answering = (code: string, confidence = 0.95) =>
  createMockClient({
    fallback: (req) => {
      const ids = [...String(req.messages.at(-1)!.content).matchAll(/"id":"(c\d+)"/g)].map((m) => m[1]!);
      return { results: ids.map((id) => ({ id, kind: "claim", items: [{ code, size: null, color: null, qty: null }], from: null, confidence, reason: "test" })) };
    },
  });
const llmFirst = async (text: string, code: string, ctx: ResolverContext, mode: "auto" | "llm" = "llm") =>
  (await resolveBatch([{ id: "x", text }], ctx, { llm: answering(code), mode }))[0]![0]!;
const grantedIntent = (i: { kind: string; itemCode?: string; confidence: number }) => (i.kind === "claim" || i.kind === "change") && !!i.itemCode && i.confidence >= 0.8;

const lots: ShowItem[] = Array.from({ length: 90 }, (_, n) => ({ code: String(n + 1), title: `Vintage piece ${n + 1}`, priceCents: 1000, variants: [{ sku: String(n + 1), qty: 1 }] }));
/** A 90-piece numbered sale, piece 4 on screen. */
const LOTS: ResolverContext = { currentItem: lots[3]!, items: lots };

const kurta: ShowItem = {
  code: "1",
  title: "Cotton kurta on screen",
  priceCents: 90000,
  variants: ["S", "M", "L"].flatMap((size) => ["green", "blue", "maroon"].map((color) => ({ sku: `1-${size}-${color}`, size, color, qty: 2 }))),
};
/** One design on screen with a size and colour grid. */
const KURTA: ResolverContext = { currentItem: kurta, items: [kurta] };

describe("a size or colour with no claim word is never auto-granted", () => {
  it.each(["green in M", "maroon colour", "size L blue", "blue 3XL"])("rules: %s", (text) => {
    const out = ruleResolve(text, KURTA);
    expect(out.intents.some(granted)).toBe(false);
    expect(out.llmCap).toBe(REVIEW_CAP);
  });

  it.each(["green in M", "maroon colour"])("LLM: %s", async (text) => {
    expect(grantedIntent(await llmFirst(text, "1", KURTA))).toBe(false);
  });

  it("with a claim word the same variant still grants", () => {
    for (const text of ["sold green M", "M blue for me", "maroon L book kar do"]) expect(granted(first(text, KURTA))).toBe(true);
  });
});

describe("the LLM may not derive an item from position or description", () => {
  it("drops a code the comment never names", async () => {
    const i = await llmFirst("the one before this please", "7", FULL);
    expect(i.itemCode).toBeUndefined();
    expect(i.confidence).toBeLessThan(0.8);
  });

  it("drops even the on-screen item when the comment points elsewhere by position", async () => {
    for (const text of ["I'll take the last one", "pichla wala book kar do", "next one for me"]) {
      expect(grantedIntent(await llmFirst(text, "11", FULL))).toBe(false);
    }
  });

  it("keeps a written code, a title only one item has, and the on-screen item for 'this'", async () => {
    expect(await llmFirst("sold 7 black M", "7", FULL)).toMatchObject({ itemCode: "7" });
    expect(await llmFirst("I want the denim jacket in M", "8", FULL)).toMatchObject({ itemCode: "8" });
    expect(await llmFirst("I'll take this one", "11", FULL)).toMatchObject({ itemCode: "11" });
  });
});

describe("the LLM needs a claim word", () => {
  it.each(["testing 9", "yep", "ok", "same"])("%s is not granted", async (text) => {
    expect(grantedIntent(await llmFirst(text, "11", FULL))).toBe(false);
  });

  it("a code typed on its own is the claim convention for the item on screen only", async () => {
    expect(grantedIntent(await llmFirst("42", "42", { ...LOTS, currentItem: lots[41]! }))).toBe(true);
    expect(grantedIntent(await llmFirst("42", "42", LOTS))).toBe(false);
  });
});

describe("LLM catalogue", () => {
  const ctx = LOTS;

  it("always lists the on-screen item and every item a comment names, past the line cap", () => {
    const prompt = buildUserPrompt([{ id: "c1", text: "sold 88", ctx }]);
    expect(prompt).toMatch(/#88 Vintage piece 88/);
    expect(prompt).toMatch(/#4 Vintage piece 4 \| ON SCREEN NOW/);
    expect(prompt).toMatch(/more items not listed/);
  });
});

describe("slot letters", () => {
  const slot = (code: string): ShowItem => ({ code, title: `Slot ${code}`, priceCents: 2000, variants: [{ sku: code, qty: 1 }] });
  const GRID: ResolverContext = { items: "ABCDEFGHIJ".split("").map(slot) };

  it("a letter after a claim word is a code when the catalogue is lettered", () => {
    expect(grants("claim e", GRID).map((i) => i.itemCode)).toEqual(["E"]);
    expect(grants("claim b and g", GRID).map((i) => i.itemCode)).toEqual(["B", "G"]);
    expect(grants("claim i", GRID).map((i) => i.itemCode)).toEqual(["I"]);
  });

  it("English 'a' and 'i', bare letters, and numbered catalogues are left alone", () => {
    expect(grants("i want to claim one", GRID)).toHaveLength(0);
    expect(grants("claim a comic for my son", GRID)).toHaveLength(0);
    expect(grants("d", GRID)).toHaveLength(0);
    expect(grants("claim c", FULL)).toHaveLength(0);
    expect(grants("claim a", { items: [slot("A"), slot("B"), { ...slot("12"), title: "Lot 12" }] })).toHaveLength(0);
  });
});

describe("colour words in an item's own title", () => {
  const rock = (code: string, title: string): ShowItem => ({ code, title, priceCents: 1500, variants: [{ sku: code, qty: 1 }] });
  const ROCKS: ResolverContext = { currentItem: rock("31", "Purple amethyst cluster"), items: [rock("30", "Green fluorite tower"), rock("31", "Purple amethyst cluster")] };

  it("describe the item rather than request a variant", () => {
    expect(grants("sold 30 green fluorite", ROCKS).map((i) => i.itemCode)).toEqual(["30"]);
    expect(grants("sold purple one", ROCKS).map((i) => i.itemCode)).toEqual(["31"]);
  });

  it("a colour neither in the title nor offered still blocks the grant", () => {
    expect(grants("sold 30 red", ROCKS)).toHaveLength(0);
  });
});
