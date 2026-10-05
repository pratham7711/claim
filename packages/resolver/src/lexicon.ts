import type { ShowItem, Variant } from "@claim/core";

/** Spoken/typed size forms -> canonical labels to try, in order, against an item's own sizes. */
export const SIZE_WORDS: Record<string, string[]> = {
  xs: ["XS"],
  xsm: ["XS"],
  xsmall: ["XS"],
  s: ["S"],
  sm: ["S"],
  sml: ["S"],
  small: ["S"],
  smal: ["S"],
  m: ["M"],
  md: ["M"],
  med: ["M"],
  medium: ["M"],
  mediun: ["M"],
  meduim: ["M"],
  medum: ["M"],
  mdm: ["M"],
  l: ["L"],
  lg: ["L"],
  lrg: ["L"],
  lge: ["L"],
  large: ["L"],
  larg: ["L"],
  xl: ["XL", "1X"],
  xlg: ["XL"],
  xlarge: ["XL"],
  xxl: ["XXL", "2XL", "2X"],
  "2xl": ["2XL", "XXL", "2X"],
  xxxl: ["XXXL", "3XL", "3X"],
  "3xl": ["3XL", "XXXL", "3X"],
  "1x": ["1X", "XL"],
  "2x": ["2X", "2XL", "XXL"],
  "3x": ["3X", "3XL", "XXXL"],
  os: ["OS", "ONE SIZE"],
};

/** Two-word forms, checked before single tokens. */
export const SIZE_BIGRAMS: Record<string, string[]> = {
  "extra small": ["XS"],
  "x small": ["XS"],
  "extra large": ["XL"],
  "x large": ["XL"],
  "xtra large": ["XL"],
  "one size": ["OS", "ONE SIZE"],
};

export const COLOR_SYNONYMS: Record<string, string> = {
  blk: "black", blck: "black", blak: "black", blakc: "black", balck: "black", kala: "black", kaala: "black",
  kali: "black", kaali: "black", negro: "black", negra: "black",
  wht: "white", whte: "white", safed: "white", safaid: "white", sufed: "white", blanco: "white", blanca: "white",
  laal: "red", lal: "red", rojo: "red", roja: "red",
  neela: "blue", nila: "blue", neeli: "blue", azul: "blue", blu: "blue",
  hara: "green", hari: "green", verde: "green",
  peela: "yellow", pila: "yellow", peeli: "yellow", amarillo: "yellow", amarilla: "yellow",
  gulabi: "pink", rosa: "pink", rosado: "pink", rosada: "pink",
  gray: "grey", gry: "grey", gris: "grey",
  bhura: "brown", cafe: "brown", marron: "brown",
  morado: "purple", baingani: "purple", jamuni: "purple",
  narangi: "orange", naranja: "orange",
  dorado: "gold", sunehri: "gold", plata: "silver",
  nvy: "navy", burgandy: "burgundy", lavendar: "lavender", fuschia: "fuchsia", fucsia: "fuchsia",
  champange: "champagne", mustered: "mustard", emrald: "emerald", oatmeel: "oatmeal",
};

/** Words that name a colour on their own (recognised even when the item lacks it). */
export const COLOR_WORDS = new Set([
  "black", "white", "red", "blue", "green", "yellow", "pink", "grey", "navy", "brown", "purple", "orange", "gold",
  "silver", "maroon", "cream", "ivory", "tan", "olive", "sage", "blush", "rust", "mustard", "teal", "emerald",
  "champagne", "burgundy", "wine", "plum", "lavender", "lilac", "mint", "peach", "beige", "camel", "cognac", "coral",
  "fuchsia", "leopard", "floral", "denim", "oatmeal", "mocha", "nude", "khaki", "charcoal", "cobalt", "indigo",
  "sand", "mehndi", "multi", "rainbow", "neutral", "tortoise", "plaid", "chocolate", "ocean", "wash", "magenta",
  "turquoise", "aqua", "violet", "copper", "bronze", "taupe", "mauve", "rose", "sky", "forest", "heather",
]);

/** Colour-name words too generic or too size-like to identify a variant alone. */
const WEAK_COLOR_WORDS = new Set(["light", "dark", "wash", "med", "medium", "heather", "small", "large", "and", "with"]);

export const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20,
};

export const canonColor = (word: string) => COLOR_SYNONYMS[word] ?? word;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export const sizesOf = (item: ShowItem) => [...new Set(item.variants.map((v) => v.size).filter((s): s is string => !!s))];
export const colorsOf = (item: ShowItem) => [...new Set(item.variants.map((v) => v.color).filter((c): c is string => !!c))];

/** Map size candidates (from SIZE_WORDS or a literal like "12", "3T", "S/M") onto the item's own spelling. */
export function matchSize(item: ShowItem, candidates: string[]): string | undefined {
  const own = sizesOf(item);
  for (const c of candidates) {
    const hit = own.find((s) => norm(s) === norm(c));
    if (hit) return hit;
  }
  // Combined labels ("S/M", "L/XL") accept either half.
  for (const c of candidates) {
    const hit = own.find((s) => s.includes("/") && s.split("/").some((part) => norm(part) === norm(c)));
    if (hit) return hit;
  }
  return undefined;
}

/** alias -> the item's colour spelling, keeping only aliases that point at exactly one colour. */
export function colorAliases(item: ShowItem): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  const add = (alias: string, color: string) => {
    if (!alias) return;
    if (!seen.has(alias)) seen.set(alias, new Set());
    seen.get(alias)!.add(color);
  };
  for (const color of colorsOf(item)) {
    const n = norm(color);
    add(n, color);
    add(n.replace(/[\s/]+/g, ""), color);
    for (const word of n.split(/[\s/]+/)) if (!WEAK_COLOR_WORDS.has(word)) add(canonColor(word), color);
  }
  const out = new Map<string, string>();
  for (const [alias, colors] of seen) if (colors.size === 1) out.set(alias, [...colors][0]!);
  return out;
}

export type VariantFit = "exact" | "underspecified" | "unavailable";

/** How well the stated size/colour pins down one variant of the item. */
export function variantFit(item: ShowItem, size?: string, color?: string): { fit: VariantFit; matches: Variant[] } {
  const matches = item.variants.filter(
    (v) => (!size || (v.size !== undefined && norm(v.size) === norm(size))) && (!color || (v.color !== undefined && norm(v.color) === norm(color))),
  );
  if (matches.length === 0) return { fit: "unavailable", matches };
  return { fit: matches.length === 1 ? "exact" : "underspecified", matches };
}
