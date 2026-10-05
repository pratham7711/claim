import { describe, expect, it } from "vitest";
import { assignSkus, missingFields, parseListingRules, type ListingContext, type ListingResult } from "../index.js";

const parse = (text: string, ctx?: ListingContext) => parseListingRules(text, ctx);
const variants = (r: ListingResult) => r.draft.variants.map((v) => `${v.sku}:${v.qty ?? "?"}`);
const shape = (r: ListingResult) => ({
  code: r.draft.code,
  title: r.draft.title,
  priceCents: r.draft.priceCents,
  currency: r.draft.currency,
  variants: variants(r),
});

describe("parseListingRules: the spec utterance", () => {
  const r = parse(
    "okay number fourteen, this gorgeous floral wrap dress, thirty-eight dollars, I have two smalls, three mediums and one large in blue",
  );

  it("reads code, title, price and per-size counts", () => {
    expect(shape(r)).toEqual({
      code: "14",
      title: "Floral Wrap Dress",
      priceCents: 3800,
      currency: "USD",
      variants: ["14-S-BLUE:2", "14-M-BLUE:3", "14-L-BLUE:1"],
    });
  });

  it("is complete, confident, rule-only and carries a ShowItem", () => {
    expect(r.missing).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.confidence).toBe(1);
    expect(r.method).toBe("rule");
    expect(r.item).toEqual({
      code: "14",
      title: "Floral Wrap Dress",
      priceCents: 3800,
      variants: [
        { sku: "14-S-BLUE", qty: 2, size: "S", color: "blue" },
        { sku: "14-M-BLUE", qty: 3, size: "M", color: "blue" },
        { sku: "14-L-BLUE", qty: 1, size: "L", color: "blue" },
      ],
    });
  });

  it("keeps the host's words as the as-described record", () => {
    expect(r.transcript).toMatch(/^okay number fourteen/);
  });

  it("is deterministic", () => {
    const again = parse(r.transcript);
    expect(again).toEqual(r);
  });
});

describe("parseListingRules: prices", () => {
  it.each([
    ["number 1 tee, thirty-eight dollars, two smalls", 3800],
    ["number 1 tee, $38, two smalls", 3800],
    ["number 1 tee, 38 bucks, two smalls", 3800],
    ["number 1 tee, 38 dollars, two smalls", 3800],
    ["number 1 tee for $19.99, two smalls", 1999],
    ["number 1 tee, price is forty five, two smalls", 4500],
    ["number 1 tee, one hundred and five dollars, two smalls", 10500],
    ["number 1 coat, two hundred dollars, two smalls", 20000],
    ["number 1 coat, a hundred bucks, two smalls", 10000],
  ])("%s -> %d cents", (text, cents) => {
    const r = parse(text);
    expect(r.draft.priceCents).toBe(cents);
    expect(r.draft.currency).toBe("USD");
  });

  it("reads a colloquial pair like 'twelve ninety nine dollars' as 12.99 and says so", () => {
    const r = parse("number 8 graphic tee twelve ninety nine dollars, one each in small medium large, black");
    expect(r.draft.priceCents).toBe(1299);
    expect(r.warnings).toContain('read spoken "12 99" as one price');
    expect(variants(r)).toEqual(["8-S-BLACK:1", "8-M-BLACK:1", "8-L-BLACK:1"]);
  });

  it("falls back to a bare trailing number but flags it and lowers confidence", () => {
    const r = parse("next up the blue cable-knit sweater, two mediums and a large, thirty four");
    expect(r.draft.priceCents).toBe(3400);
    expect(r.warnings).toContain("price read from a bare number (34); confirm it");
    expect(r.confidence).toBeLessThan(0.7);
  });

  it("does not take a size count or a small number as the price", () => {
    const r = parse("number 4 scarf, two smalls and one medium");
    expect(r.draft.priceCents).toBeUndefined();
    expect(r.missing).toContain("price");
  });

  it("warns when two prices are said and keeps the last", () => {
    const r = parse("number 4 scarf, was $30, now $25, two smalls");
    expect(r.draft.priceCents).toBe(2500);
    expect(r.warnings.some((w) => w.startsWith("heard more than one price"))).toBe(true);
  });

  it("flags a currency that disagrees with the show", () => {
    const r = parse("number 4 scarf, 500 rupees, two smalls", { currency: "USD" });
    expect(r.draft.currency).toBe("USD");
    expect(r.warnings).toContain("heard INR but the show is in USD");
  });
});

describe("parseListingRules: codes", () => {
  it.each([
    ["number fourteen floral dress $38 two smalls", "14"],
    ["item 7 linen shirt $45 two smalls", "7"],
    ["lot 3 linen shirt $45 two smalls", "3"],
    ["#22 linen shirt $45 two smalls", "22"],
    ["no. 9 linen shirt $45 two smalls", "9"],
    ["style number 12 linen shirt $45 two smalls", "12"],
  ])("%s -> code %s", (text, code) => {
    expect(parse(text).draft.code).toBe(code);
  });

  it("takes a leading bare number as the code when a price was said, and warns", () => {
    const r = parse("14, floral wrap dress, $38, two smalls");
    expect(r.draft.code).toBe("14");
    expect(r.warnings).toContain("took the leading number 14 as the item code");
  });

  it("does not read a leading count as a code", () => {
    const r = parse("two smalls of this floral dress, $38");
    expect(r.draft.code).toBeUndefined();
    expect(variants(r)).toEqual(["NEW-S:2"]);
  });

  it("assigns ctx.nextCode when none is spoken", () => {
    const r = parse("floral wrap dress, $38, two smalls", { nextCode: "15" });
    expect(r.draft.code).toBe("15");
    expect(r.missing).toEqual([]);
    expect(r.warnings).toContain("no code spoken; assigned 15");
  });

  it("flags a code that is already listed", () => {
    const r = parse("number 14 floral wrap dress $38 two smalls", { existingCodes: ["14"] });
    expect(r.warnings).toContain("code 14 is already listed in this show");
    expect(r.confidence).toBeLessThan(1);
  });

  it("reports a missing code instead of inventing one", () => {
    const r = parse("floral wrap dress, $38, two smalls");
    expect(r.missing).toEqual(["code"]);
    expect(r.item).toBeUndefined();
  });
});

describe("parseListingRules: variants", () => {
  it.each([
    ["item 7 linen shirt $45 S 2 M 3 L 1", ["7-S:2", "7-M:3", "7-L:1"]],
    ["item 7 linen shirt $45 S x2, M x3", ["7-S:2", "7-M:3"]],
    ["item 7 linen shirt $45 two small, three medium, one large", ["7-S:2", "7-M:3", "7-L:1"]],
    ["item 7 linen shirt $45 a small and a medium", ["7-S:1", "7-M:1"]],
    ["item 7 linen shirt $45 small medium and large, two each", ["7-S:2", "7-M:2", "7-L:2"]],
    ["item 7 linen shirt $45 small medium and large, one of each", ["7-S:1", "7-M:1", "7-L:1"]],
    ["item 7 linen shirt $45 two extra small and one extra large", ["7-XS:2", "7-XL:1"]],
    ["item 7 linen shirt $45 2 XL and one 2XL", ["7-XL:2", "7-XXL:1"]],
    ["item 7 linen shirt $45 two XL and three XXL in grey", ["7-XL-GRAY:2", "7-XXL-GRAY:3"]],
    ["item 7 linen shirt $45, five pieces", ["7-OS:5"]],
    ["item 7 linen shirt $45, one size, just one", ["7-FREE:1"]],
    ["item 7 linen shirt $45, two small and two small", ["7-S:4"]],
  ])("%s", (text, expected) => {
    expect(variants(parse(text))).toEqual(expected);
  });

  it("reads colour-only counts", () => {
    const r = parse("number twelve leather belt, $25, three in brown and two in black");
    expect(variants(r)).toEqual(["12-BROWN:3", "12-BLACK:2"]);
  });

  it("colours the sizes before an 'in <colour>' mention, and the sizes after when none come before", () => {
    expect(variants(parse("number 1 top $20, two small and one medium in red, three large in green"))).toEqual([
      "1-S-RED:2",
      "1-M-RED:1",
      "1-L-GREEN:3",
    ]);
    expect(variants(parse("number 1 top $20, in red: two small and one medium"))).toEqual(["1-S-RED:2", "1-M-RED:1"]);
  });

  it("crosses sizes with a colour list and warns that it assumed so", () => {
    const r = parse("number 5 maxi dress $52, two small and two medium in mustard and teal");
    expect(variants(r)).toEqual(["5-S-MUSTARD:2", "5-S-TEAL:2", "5-M-MUSTARD:2", "5-M-TEAL:2"]);
    expect(r.warnings).toContain("assumed S comes in every colour (mustard, teal)");
  });

  it("applies the only colour mentioned to every variant", () => {
    expect(variants(parse("number 3 navy sweater, 45 dollars, two small and two medium"))).toEqual(["3-S-NAVY:2", "3-M-NAVY:2"]);
  });

  it("normalises grey to gray", () => {
    expect(parse("number 1 hoodie $35 two medium in grey").draft.variants[0]!.color).toBe("gray");
  });

  it("reads numeric sizes after a size cue", () => {
    expect(variants(parse("number 2 jeans $60 sizes 28 30 32 one of each"))).toEqual(["2-28:1", "2-30:1", "2-32:1"]);
    expect(variants(parse("number 2 jeans $60 sizes 28, 30 and 32, two each"))).toEqual(["2-28:2", "2-30:2", "2-32:2"]);
    expect(variants(parse("number 2 jeans, sizes thirty two thirty four, two of each, fifty dollars"))).toEqual(["2-32:2", "2-34:2"]);
    expect(variants(parse("number 3 shirt size 8, 30 dollars, two pieces"))).toEqual(["3-8:2"]);
  });

  it("does not turn the price or a trailing count into a numeric size", () => {
    const r = parse("number 2 jeans size 30 two pieces, 45 dollars");
    expect(r.draft.priceCents).toBe(4500);
    expect(variants(r)).toEqual(["2-30:2"]);
  });

  it("names variants it could not count and reports them missing", () => {
    const r = parse("number 3 shirt $30, small and medium");
    expect(variants(r)).toEqual(["3-S:?", "3-M:?"]);
    expect(r.missing).toEqual(["variants"]);
    expect(r.warnings).toContain("no count for S, M");
    expect(r.item).toBeUndefined();
  });

  it("reports variants missing when no stock is said at all", () => {
    const r = parse("number 6, the cutest cardigan, forty dollars");
    expect(r.draft.variants).toEqual([]);
    expect(r.missing).toEqual(["variants"]);
  });
});

describe("parseListingRules: titles", () => {
  it.each([
    ["okay number fourteen, this gorgeous floral wrap dress, $38, two smalls", "Floral Wrap Dress"],
    ["next up the blue cable-knit sweater, $34, two mediums", "Blue Cable-Knit Sweater"],
    ["number 6, the cutest cardigan, forty dollars, two smalls", "Cardigan"],
    ["number 1 kurta set, 999 rupees, five pieces", "Kurta Set"],
    ["number 1 floral dress with pockets, $40, two smalls", "Floral Dress with Pockets"],
    ["number 2 so this is our bestselling linen shirt, $45, two smalls", "Linen Shirt"],
  ])("%s -> %s", (text, title) => {
    expect(parse(text).draft.title).toBe(title);
  });

  it("reports a missing title when only numbers are said", () => {
    expect(parse("number 4, $25, two smalls").missing).toContain("title");
  });

  it("returns an empty draft for chatter with everything missing", () => {
    const r = parse("hi everyone, welcome back to the show!");
    expect(r.draft.code).toBeUndefined();
    expect(r.draft.priceCents).toBeUndefined();
    expect(r.missing).toEqual(expect.arrayContaining(["code", "price", "variants"]));
    expect(r.confidence).toBeLessThanOrEqual(0.25);
  });
});

describe("parseListingRules: Indian shows", () => {
  it("reads a saree with a spoken rupee price", () => {
    const r = parse("number 22, Banarasi silk saree, two thousand four hundred rupees, three pieces in maroon");
    expect(shape(r)).toEqual({
      code: "22",
      title: "Banarasi Silk Saree",
      priceCents: 240000,
      currency: "INR",
      variants: ["22-MAROON:3"],
    });
    expect(r.confidence).toBe(1);
  });

  it.each([
    ["number 10 midi skirt ₹2,400, size M two pieces in pink", 240000],
    ["number 10 kurti ₹ 2400, five pieces", 240000],
    ["number 10 kurti rs. 1,299 only, 4 pieces", 129900],
    ["number 10 kurti Rs 899, 4 pieces", 89900],
    ["number 10 kurti 899 rupees, 4 pieces", 89900],
    ["number 10 kurti 899/-, 4 pieces", 89900],
    ["number 10 kurti 1,299 only, 4 pieces", 129900],
    ["number 10 saree 1,50,000 rupees, one piece", 15000000],
    ["number 10 saree 1.5 lakh, one piece", 15000000],
  ])("%s -> %d paise", (text, paise) => {
    const r = parse(text);
    expect(r.draft.priceCents).toBe(paise);
    expect(r.draft.currency).toBe("INR");
  });

  it.each([
    ["code 9 cotton kurti do M teen L, 24 sau", 240000, ["9-M:2", "9-L:3"]],
    ["number 11 kurta set dhai hazaar, free size five pieces", 250000, ["11-FREE:5"]],
    ["number 15, anarkali suit saade teen hazaar, 2 XL and one 2XL", 350000, ["15-XL:2", "15-XXL:1"]],
    ["number 16 bridal lehenga sava lakh, one piece in red", 12500000, ["16-RED:1"]],
    ["number 17 cotton dupatta paune hazaar, 10 pieces", 75000, ["17-OS:10"]],
    ["number 18 silk saree do hazaar, teen piece", 200000, ["18-OS:3"]],
  ])("Hindi number words: %s", (text, paise, expected) => {
    const r = parse(text);
    expect(r.draft.currency).toBe("INR");
    expect(r.draft.priceCents).toBe(paise);
    expect(variants(r)).toEqual(expected);
    expect(r.warnings).toEqual([]);
  });

  it("reads numeric kurti sizes", () => {
    const r = parse("number 9 kurti size 38 and 40, 2 each, 899 rupees");
    expect(variants(r)).toEqual(["9-38:2", "9-40:2"]);
    expect(r.draft.priceCents).toBe(89900);
  });

  it("infers INR from saree and kurti vocabulary when the show currency is not set", () => {
    expect(parse("number 3 georgette saree 1299 only, two pieces").draft.currency).toBe("INR");
    expect(parse("number 3 rayon kurti, 4 pieces, 799").draft.currency).toBe("INR");
  });

  it("honours an INR show even without Indian words", () => {
    const r = parse("number 3 cotton top two thousand, four pieces", { currency: "INR" });
    expect(r.draft.priceCents).toBe(200000);
    expect(r.draft.currency).toBe("INR");
  });

  it("does not treat English 'do' as two outside a count", () => {
    const r = parse("number 4 kurti, do check this one out, 999 rupees, three pieces");
    expect(r.draft.priceCents).toBe(99900);
    expect(variants(r)).toEqual(["4-OS:3"]);
  });
});

describe("assignSkus / missingFields", () => {
  it("builds unique SKUs from code, size and colour", () => {
    expect(assignSkus("14", [{ size: "M", color: "blue", qty: 1 }, { size: "M", color: "blue", qty: 2 }, { qty: 3 }, { color: "dusty pink", qty: 1 }]).map((v) => v.sku)).toEqual([
      "14-M-BLUE",
      "14-M-BLUE-2",
      "14-OS",
      "14-DUSTY-PINK",
    ]);
    expect(assignSkus(undefined, [{ size: "S", qty: 1 }])[0]!.sku).toBe("NEW-S");
  });

  it("lists exactly the fields a seller must fill", () => {
    expect(missingFields({ currency: "USD", variants: [] })).toEqual(["code", "title", "price", "variants"]);
    expect(missingFields({ code: "1", title: "Tee", priceCents: 0, currency: "USD", variants: [{ sku: "1-OS", qty: 1 }] })).toEqual([]);
    expect(missingFields({ code: "1", title: "Tee", priceCents: 100, currency: "USD", variants: [{ sku: "1-S" }] })).toEqual(["variants"]);
  });
});
