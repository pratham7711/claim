import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult, LlmClient } from "@claim/llm";
import { confirmListing, LISTING_SCHEMA, listingPrompt, parseListing, readLlmListing } from "../index.js";

type Reply = Partial<CompletionResult> | ((req: CompletionRequest) => Promise<Partial<CompletionResult>>);

/** A local stand-in for a provider adapter: records every request and answers from a script. */
function fakeLlm(reply: Reply): LlmClient & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    provider: "fake",
    model: "fake-1",
    calls,
    async complete(req) {
      calls.push(req);
      const r = typeof reply === "function" ? await reply(req) : reply;
      return { text: "", model: "fake-1", latencyMs: 1, ...r };
    },
  };
}

const COMPLETE = "okay number fourteen, this gorgeous floral wrap dress, thirty-eight dollars, I have two smalls, three mediums and one large in blue";

describe("parseListing: when the model is asked", () => {
  it("does not call the model when the rules are complete and confident", async () => {
    const llm = fakeLlm({ json: { code: "99" } });
    const r = await parseListing(COMPLETE, {}, llm);
    expect(llm.calls).toHaveLength(0);
    expect(r.method).toBe("rule");
    expect(r.draft.code).toBe("14");
  });

  it("works with no model at all", async () => {
    const r = await parseListing("floral wrap dress, $38, two smalls");
    expect(r.missing).toEqual(["code"]);
    expect(r.method).toBe("rule");
  });

  it("calls the model when a field is missing", async () => {
    const llm = fakeLlm({ json: { code: "21", title: null, price: null, currency: null, variants: [] } });
    await parseListing("floral wrap dress, $38, two smalls", {}, llm);
    expect(llm.calls).toHaveLength(1);
  });

  it("calls the model when everything is present but confidence is low", async () => {
    const text = "number 5 maxi dress $52, two small and two medium in mustard and teal";
    const llm = fakeLlm({ json: { code: "5", title: "Maxi Dress", price: 52, currency: "USD", variants: [] } });
    const r = await parseListing(text, { llmBelowConfidence: 0.95 }, llm);
    expect(llm.calls).toHaveLength(1);
    expect(r.method).toBe("rule");
    expect(r.draft.variants).toHaveLength(4);
  });

  it("sends a deterministic, schema-constrained request with the transcript and context", async () => {
    const llm = fakeLlm({ json: {} });
    await parseListing("number 3 shirt, small and medium", { currency: "INR", existingCodes: ["1", "2"] }, llm);
    const req = llm.calls[0]!;
    expect(req.temperature).toBe(0);
    expect(req.jsonSchema).toBe(LISTING_SCHEMA);
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(req.messages.at(-1)).toEqual({ role: "user", content: "number 3 shirt, small and medium" });
    expect(req.messages[0]!.content).toContain("INR");
    expect(req.messages[0]!.content).toContain("Codes already used in this show: 1, 2.");
  });
});

describe("parseListing: merging the model's reading", () => {
  it("fills missing fields, re-SKUs, and marks the result rule+llm", async () => {
    const llm = fakeLlm({
      json: { code: "21", title: "Wrap Dress", price: 40, currency: "USD", variants: [{ size: "small", color: null, qty: 2 }] },
    });
    const r = await parseListing("floral wrap dress, $38, two smalls", {}, llm);
    expect(r.method).toBe("rule+llm");
    expect(r.draft.code).toBe("21");
    expect(r.draft.title).toBe("Floral Wrap Dress");
    expect(r.draft.priceCents).toBe(3800);
    expect(r.draft.variants).toEqual([{ sku: "21-S", size: "S", qty: 2 }]);
    expect(r.missing).toEqual([]);
    expect(r.item?.code).toBe("21");
    expect(r.warnings).toContain("model heard $40.00 for the price; kept $38.00");
    expect(r.warnings).toContain("filled by the model, please check: code");
    expect(r.confidence).toBeLessThan(1);
  });

  it("never overrides a field the rules read", async () => {
    const text = "number 3 shirt $30, small and medium";
    const llm = fakeLlm({ json: { code: "77", title: "Something Else", price: 99, variants: [{ size: "S", qty: 1 }, { size: "M", qty: 4 }] } });
    const r = await parseListing(text, {}, llm);
    expect(r.draft.code).toBe("3");
    expect(r.draft.title).toBe("Shirt");
    expect(r.draft.priceCents).toBe(3000);
  });

  it("replaces uncounted variants with a fully counted model reading", async () => {
    const llm = fakeLlm({ json: { variants: [{ size: "S", qty: 1 }, { size: "M", qty: 4 }] } });
    const r = await parseListing("number 3 shirt $30, small and medium", {}, llm);
    expect(r.draft.variants).toEqual([
      { sku: "3-S", size: "S", qty: 1 },
      { sku: "3-M", size: "M", qty: 4 },
    ]);
    expect(r.missing).toEqual([]);
    expect(r.method).toBe("rule+llm");
  });

  it("fills only the counts it can match when the model's reading is itself partial", async () => {
    const llm = fakeLlm({ json: { variants: [{ size: "medium", qty: 4 }, { size: "L", qty: null }] } });
    const r = await parseListing("number 3 shirt $30, small and medium", {}, llm);
    expect(r.draft.variants).toEqual([
      { sku: "3-S", size: "S" },
      { sku: "3-M", size: "M", qty: 4 },
    ]);
    expect(r.missing).toEqual(["variants"]);
    expect(r.item).toBeUndefined();
  });

  it("fills the price for an Indian show in paise", async () => {
    const llm = fakeLlm({ json: { code: null, title: null, price: 2400, currency: "INR", variants: [] } });
    const r = await parseListing("number 22 banarasi saree, three pieces in maroon, bahut sundar", { currency: "INR" }, llm);
    expect(r.draft.priceCents).toBe(240000);
    expect(r.draft.currency).toBe("INR");
    expect(r.item?.variants).toEqual([{ sku: "22-MAROON", qty: 3, color: "maroon" }]);
  });

  it("warns when the model hears another currency but keeps the show's", async () => {
    const llm = fakeLlm({ json: { price: 38, currency: "INR" } });
    const r = await parseListing("number 1 tee, two smalls", { currency: "USD" }, llm);
    expect(r.draft.currency).toBe("USD");
    expect(r.draft.priceCents).toBe(3800);
    expect(r.warnings).toContain("model heard INR; show currency is USD");
  });

  it("extracts JSON from a text reply when the adapter returns no parsed json", async () => {
    const llm = fakeLlm({ text: 'Sure! Here it is:\n```json\n{"code":"31","title":null,"price":null,"currency":null,"variants":[]}\n```' });
    const r = await parseListing("floral wrap dress, $38, two smalls", {}, llm);
    expect(r.draft.code).toBe("31");
  });
});

describe("parseListing: model failures degrade to the rule draft", () => {
  const text = "floral wrap dress, $38, two smalls";

  it("keeps the rule result and warns when the model throws", async () => {
    const llm = fakeLlm(async () => {
      throw new Error("429 rate limited");
    });
    const r = await parseListing(text, {}, llm);
    expect(r.method).toBe("rule");
    expect(r.draft.code).toBeUndefined();
    expect(r.missing).toEqual(["code"]);
    expect(r.warnings).toContain("model fallback failed: 429 rate limited");
  });

  it("times out a model that never answers and aborts its signal", async () => {
    let seen: AbortSignal | undefined;
    const llm = fakeLlm((req) => {
      seen = req.signal;
      return new Promise(() => {});
    });
    const started = Date.now();
    const r = await parseListing(text, { llmTimeoutMs: 30 }, llm);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.warnings).toContain("model fallback failed: model timed out after 30ms");
    expect(seen?.aborted).toBe(true);
    expect(r.method).toBe("rule");
  });

  it.each([
    ["no JSON in the reply", { text: "I cannot help with that." }, "model reply holds no JSON object"],
    ["a JSON array", { json: [1, 2] }, undefined],
    ["a non-object", { json: "listing" }, "model reply is not an object"],
  ])("survives %s", async (_label, reply, message) => {
    const r = await parseListing(text, {}, fakeLlm(reply));
    expect(r.draft.code).toBeUndefined();
    if (message) expect(r.warnings).toContain(`model fallback failed: ${message}`);
  });
});

describe("readLlmListing", () => {
  it("normalises sizes and colours and drops junk", () => {
    expect(
      readLlmListing({
        code: "#14",
        title: "  Wrap Dress ",
        price: "$38",
        currency: "EUR",
        variants: [{ size: "medium", color: "Grey", qty: 2 }, { size: "large", qty: -1 }, null, "x", { qty: 0 }, {}],
      }),
    ).toEqual({
      code: "14",
      title: "Wrap Dress",
      price: 38,
      variants: [{ size: "M", color: "gray", qty: 2 }, { size: "L" }],
    });
  });

  it("accepts a numeric code and treats 'null' strings as absent", () => {
    expect(readLlmListing({ code: 7, title: "null", variants: "nope" })).toEqual({ code: "7", variants: [] });
  });

  it("rejects fractional counts", () => {
    expect(readLlmListing({ variants: [{ size: "S", qty: 1.5 }] }).variants).toEqual([{ size: "S" }]);
  });

  it("builds a prompt with the Hindi number hint only for INR shows", () => {
    expect(listingPrompt("x", {}, "INR")[0]!.content).toContain("hazaar");
    expect(listingPrompt("x", {}, "USD")[0]!.content).not.toContain("hazaar");
  });
});

describe("confirmListing: the seller's approval step", () => {
  it("returns a ShowItem for a complete draft", async () => {
    const r = await parseListing(COMPLETE);
    const c = confirmListing(r.draft);
    expect(c).toEqual({ ok: true, item: r.item });
  });

  it("lists what is still missing", async () => {
    const r = await parseListing("floral wrap dress, two smalls");
    expect(confirmListing(r.draft)).toEqual({ ok: false, missing: ["code", "price"] });
  });

  it("applies the seller's edits and re-SKUs on a new code", async () => {
    const r = await parseListing("floral wrap dress, two smalls");
    const c = confirmListing(r.draft, { code: "15", priceCents: 3800, title: " Floral Wrap Midi " });
    expect(c).toEqual({
      ok: true,
      item: { code: "15", title: "Floral Wrap Midi", priceCents: 3800, variants: [{ sku: "15-S", qty: 2, size: "S" }] },
    });
  });

  it("lets the seller replace the variants outright", async () => {
    const r = await parseListing("number 3 shirt $30, small and medium");
    const c = confirmListing(r.draft, { variants: [{ size: "S", qty: 2 }, { size: "M", color: "white", qty: 1 }] });
    expect(c.ok && c.item.variants).toEqual([
      { sku: "3-S", qty: 2, size: "S" },
      { sku: "3-M-WHITE", qty: 1, size: "M", color: "white" },
    ]);
  });

  it("does not mutate the draft it was given", async () => {
    const r = await parseListing("floral wrap dress, two smalls");
    const before = structuredClone(r.draft);
    confirmListing(r.draft, { code: "15", priceCents: 100 });
    expect(r.draft).toEqual(before);
  });
});
