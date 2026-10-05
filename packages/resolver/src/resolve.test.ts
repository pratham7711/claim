import { createMockClient, LlmError } from "@claim/llm";
import { describe, expect, it } from "vitest";
import { buildUserPrompt, RESOLVE_SCHEMA, validateLlmResult } from "./llm-stage.js";
import { normalize } from "./normalize.js";
import { resolve, resolveAll, resolveBatch } from "./resolve.js";
import { ctxOn, FULL } from "./test-fixtures.js";

const result = (id: string, kind: string, items: { code: string; size?: string | null; color?: string | null; qty?: number | null }[], confidence = 0.9, from: string | null = null) => ({
  id,
  kind,
  items: items.map((i) => ({ size: null, color: null, qty: null, ...i })),
  from,
  confidence,
  reason: "test",
});

describe("normalize", () => {
  it("unifies emoji, keycaps, digits and elongations", () => {
    expect(normalize("SOOOLD 7️⃣ 🙋‍♀️").text).toBe("sold 7 me");
    expect(normalize("xxl pls").text).toBe("xxl pls");
    expect(normalize("१२ चाहिए").text).toBe("12 chahiye");
    expect(normalize("😍😍").emojiOnly).toBe(true);
    expect(normalize("sold #12?").hasQuestionMark).toBe(true);
  });

  it("keeps offsets so glued tokens can be told apart", () => {
    const t = normalize("sold142x2").tokens.map((x) => x.t);
    expect(t).toEqual(["sold", "142", "x", "2"]);
  });
});

describe("resolveBatch", () => {
  it("never calls the LLM for clean rule hits", async () => {
    const llm = createMockClient();
    const out = await resolveBatch([{ id: "a", text: "sold 7 black M" }], FULL, { llm });
    expect(llm.calls).toHaveLength(0);
    expect(out[0]).toEqual([expect.objectContaining({ commentId: "a", kind: "claim", itemCode: "7", method: "rule" })]);
  });

  it("sends only ambiguous comments, in one batch, and keeps input order", async () => {
    const llm = createMockClient({
      replies: [{ results: [result("c1", "claim", [{ code: "12", size: "10" }]), result("c2", "other", [], 0.8)] }],
    });
    const comments = [
      { id: "a", text: "sold 7 black M" },
      { id: "b", text: "12 in a 10" },
      { id: "c", text: "cancel 8" },
      { id: "d", text: "omg 12 is gorgeous" },
    ];
    const out = await resolveBatch(comments, FULL, { llm });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.jsonSchema?.schema).toBe(RESOLVE_SCHEMA);
    expect(out.map((o) => o[0]!.commentId)).toEqual(["a", "b", "c", "d"]);
    expect(out[1]![0]).toMatchObject({ kind: "claim", itemCode: "12", size: "10", method: "llm" });
    expect(out[3]![0]).toMatchObject({ kind: "other", method: "llm" });
    expect(out[2]![0]).toMatchObject({ kind: "cancel", method: "rule" });
  });

  it("splits routed comments by batchSize and reports each call", async () => {
    const llm = createMockClient({ fallback: () => ({ results: [result("c1", "other", [], 0.7)] }) });
    const seen: number[][] = [];
    await resolveBatch(
      [
        { id: "a", text: "omg 12 is gorgeous" },
        { id: "b", text: "12" },
      ],
      FULL,
      { llm, batchSize: 1, onLlmCall: (info) => seen.push(info.indices) },
    );
    expect(llm.calls).toHaveLength(2);
    expect(seen.sort()).toEqual([[0], [1]]);
  });

  it("keeps the rule answer when the LLM fails or abstains", async () => {
    const failing = createMockClient({ replies: [new LlmError("down", 503, true)] });
    const [failed] = await resolveBatch([{ id: "a", text: "12" }], FULL, { llm: failing });
    expect(failed![0]).toMatchObject({ method: "rule", itemCode: "12" });
    const abstaining = createMockClient();
    const [abstained] = await resolveBatch([{ id: "a", text: "12" }], FULL, { llm: abstaining });
    expect(abstained![0]!.method).toBe("rule");
  });

  it("does not let the LLM auto-grant a number the rules found ambiguous or unknown", async () => {
    const llm = createMockClient({
      fallback: { results: [result("c1", "claim", [{ code: "11", size: "12", color: "red" }], 0.95), result("c2", "claim", [{ code: "12", size: "12" }], 0.95)] },
    });
    const out = await resolveBatch(
      [
        { id: "a", text: "12" },
        { id: "b", text: "sold 3 dark wash 12" },
      ],
      FULL,
      { llm, mode: "llm" },
    );
    expect(out[0]![0]).toMatchObject({ method: "llm", itemCode: "11", confidence: 0.75 });
    expect(out[1]![0]).toMatchObject({ method: "llm", itemCode: "12", confidence: 0.75 });
  });

  it("keeps a worded claim in review when the LLM calls it not a claim", async () => {
    const llm = createMockClient({ fallback: { results: [result("c1", "other", [], 0.9), result("c2", "question", [], 0.9)] } });
    const out = await resolveBatch(
      [
        { id: "a", text: "claim 12 maybe" },
        { id: "b", text: "omg 12 is gorgeous" },
      ],
      FULL,
      { llm },
    );
    expect(out[0]![0]).toMatchObject({ kind: "claim", itemCode: "12", method: "rule" });
    expect(out[0]![0]!.confidence).toBeLessThan(0.8);
    expect(out[0]![0]!.rationale).toContain("llm read it as other");
    expect(out[1]![0]).toMatchObject({ kind: "question", method: "llm" });
  });

  it("keeps the rule claim in review in llm mode too", async () => {
    const llm = createMockClient({ fallback: { results: [result("c1", "other", [], 0.9)] } });
    const [out] = await resolveBatch([{ id: "a", text: "sold 7 black M" }], FULL, { llm, mode: "llm" });
    expect(out![0]).toMatchObject({ kind: "claim", itemCode: "7", method: "rule" });
    expect(out![0]!.confidence).toBeLessThan(0.8);
  });

  it("routes everything to the LLM in llm mode, and nothing in rules mode", async () => {
    const llm = createMockClient({ fallback: { results: [] } });
    await resolveBatch([{ id: "a", text: "sold 7 black M" }], FULL, { llm, mode: "llm" });
    expect(llm.calls).toHaveLength(1);
    await resolveBatch([{ id: "a", text: "12" }], FULL, { llm, mode: "rules" });
    expect(llm.calls).toHaveLength(1);
  });

  it("gives each comment its own on-screen item inside one call", async () => {
    const llm = createMockClient({ fallback: { results: [] } });
    const ctxs = [ctxOn("8"), FULL];
    await resolveBatch(
      [
        { id: "a", text: "that one!!" },
        { id: "b", text: "that one!!" },
      ],
      (_c, i) => ctxs[i]!,
      { llm, mode: "llm" },
    );
    const prompt = llm.calls[0]!.messages[1]!.content;
    expect(prompt).toContain('"on_screen":"8"');
    expect(prompt).toContain('"on_screen":"11"');
  });
});

describe("LLM output validation", () => {
  it("never lets the model invent a code", () => {
    const [i] = validateLlmResult(result("c1", "claim", [{ code: "99" }], 0.95), FULL);
    expect(i).toMatchObject({ kind: "question" });
    expect(i!.itemCode).toBeUndefined();
    expect(i!.confidence).toBeLessThanOrEqual(0.3);
  });

  it("maps size and colour onto the item's own spelling and caps by variant fit", () => {
    expect(validateLlmResult(result("c1", "claim", [{ code: "7", size: "medium", color: "Black" }], 0.95), FULL)[0]).toMatchObject({
      itemCode: "7",
      size: "M",
      color: "black",
      confidence: 0.95,
    });
    expect(validateLlmResult(result("c1", "claim", [{ code: "7" }], 0.95), FULL)[0]!.confidence).toBe(0.75);
    expect(validateLlmResult(result("c1", "claim", [{ code: "7", color: "purple" }], 0.95), FULL)[0]!.confidence).toBe(0.6);
  });

  it("clamps confidence and keeps a valid 'from'", () => {
    const [i] = validateLlmResult(result("c1", "change", [{ code: "8", size: "M" }], 1.4, "7"), FULL);
    expect(i).toMatchObject({ kind: "change", itemCode: "8", fromItemCode: "7", confidence: 0.97 });
  });

  it("puts the catalogue and the on-screen marker in the prompt", () => {
    const prompt = buildUserPrompt([{ id: "c1", text: "me", ctx: FULL }]);
    expect(prompt).toContain("#11 Wrap dress | sizes 8, 10, 12 | colours red, navy | ON SCREEN NOW");
    expect(prompt).toContain('{"id":"c1","text":"me"}');
  });
});

describe("resolve", () => {
  it("returns the single intent for a comment", async () => {
    expect(await resolve({ id: "a", text: "me" }, ctxOn("8"))).toMatchObject({ commentId: "a", kind: "claim", itemCode: "8" });
  });

  it("caps a multi-intent comment below the grant threshold; resolveAll shows them all", async () => {
    const one = await resolve({ id: "a", text: "sold 7 black M and 8 M" }, FULL);
    expect(one.confidence).toBeLessThanOrEqual(0.6);
    const all = await resolveAll({ id: "a", text: "sold 7 black M and 8 M" }, FULL);
    expect(all.map((i) => i.itemCode)).toEqual(["7", "8"]);
  });
});
