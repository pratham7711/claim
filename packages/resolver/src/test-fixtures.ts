import type { ResolverContext, ShowItem } from "@claim/core";

const variants = (code: string, sizes: (string | undefined)[], colors: (string | undefined)[]) =>
  sizes.flatMap((size) => colors.map((color) => ({ sku: `${code}-${size ?? "x"}-${color ?? "x"}`, size, color, qty: 2 })));

export const ITEMS: Record<string, ShowItem> = {
  "7": { code: "7", title: "Ribbed tank", priceCents: 2400, variants: variants("7", ["S", "M", "L"], ["black", "white"]) },
  "8": { code: "8", title: "Denim jacket", priceCents: 5200, variants: variants("8", ["S", "M", "L"], ["blue"]) },
  "11": { code: "11", title: "Wrap dress", priceCents: 4400, variants: variants("11", ["8", "10", "12"], ["red", "navy"]) },
  "12": { code: "12", title: "Wide-leg jeans", priceCents: 4800, variants: variants("12", ["10", "12", "14"], ["dark wash"]) },
};

/** The show so far (7, 8, 12, 11 listed in that order) with `current` on screen. */
export function ctxOn(current: string): ResolverContext {
  const order = ["7", "8", "12", "11"];
  const items = order.slice(0, order.indexOf(current) + 1).reverse().map((c) => ITEMS[c]!);
  return { currentItem: ITEMS[current]!, items };
}

/** Everything listed, the wrap dress (#11, sold in sizes 8/10/12) on screen. */
export const FULL = ctxOn("11");
