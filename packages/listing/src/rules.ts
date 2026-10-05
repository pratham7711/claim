import type { ShowItem } from "@claim/core";
import {
  ARTICLE_QTY,
  CODE_CUES,
  CURRENCY_PREFIX,
  CURRENCY_SUFFIX,
  FLUFF,
  GARMENTS,
  INDIAN_MARKERS,
  LEAD_FILLERS,
  PIECE_WORDS,
  PRICE_CUE_FILLERS,
  PRICE_CUES,
  SMALL_TITLE_WORDS,
  STOPWORDS,
  TITLE_TAIL,
} from "./lexicon.js";
import { mergeNumbers } from "./numbers.js";
import { markLexemes, tokenize, type Role, type Tok } from "./tokens.js";
import type { Currency, ListingContext, ListingDraft, ListingField, ListingResult, VariantDraft } from "./types.js";

const free = (t: Tok | undefined): t is Tok => Boolean(t) && !t!.used;
const isNum = (t: Tok | undefined): t is Tok => free(t) && t!.kind === "num";
const isWord = (t: Tok | undefined, w: string | Set<string>): boolean =>
  free(t) && t!.kind === "word" && (typeof w === "string" ? t!.w === w : w.has(t!.w));
const use = (toks: Tok[], from: number, to: number, role: Role) => {
  for (let i = from; i <= to; i++) toks[i]!.used = role;
};

const MIN_PRICE: Record<Currency, number> = { USD: 2, INR: 20 };

// ---------- code ----------

function findCode(toks: Tok[]): string | undefined {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (!(isWord(t, CODE_CUES) || (t.kind === "sym" && t.w === "#"))) continue;
    let j = i + 1;
    while (isWord(toks[j], CODE_CUES) || toks[j]?.w === "." || toks[j]?.w === "#") j++;
    const n = toks[j];
    if (!isNum(n) || !Number.isInteger(n.value) || n.value! < 0 || toks[j + 1]?.kind === "size") continue;
    use(toks, i, j, "code");
    return String(n.value);
  }
  return undefined;
}

/** "14, floral wrap dress, $38": a leading bare integer is the code, but only when a price was said explicitly. */
function leadingCode(toks: Tok[]): string | undefined {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === "punct" || isWord(t, LEAD_FILLERS)) continue;
    if (!isNum(t) || !Number.isInteger(t.value) || t.value! >= 1000) return undefined;
    const next = toks[i + 1];
    if (next && (next.kind === "size" || next.kind === "color" || PIECE_WORDS.has(next.w) || CURRENCY_SUFFIX[next.w] || GARMENTS.has(next.w))) {
      return undefined;
    }
    use(toks, i, i, "code");
    return String(t.value);
  }
  return undefined;
}

// ---------- price ----------

interface PriceHit {
  value: number;
  strength: number;
  currency?: Currency;
  start: number;
  end: number;
  note?: string;
}

/** Two spoken numbers side by side in a price slot: "twelve ninety nine". */
function pairable(a: Tok | undefined, b: Tok | undefined): boolean {
  return (
    isNum(a) && isNum(b) && Boolean(a.spoken && b.spoken) &&
    Number.isInteger(a.value) && a.value! >= 1 && a.value! <= 99 &&
    Number.isInteger(b.value) && b.value! >= 10 && b.value! <= 99
  );
}

function combinePair(a: number, b: number, currency: Currency): number {
  if (currency === "INR") return a * 100 + b;
  return a >= 10 ? a + b / 100 : a * 100 + b;
}

function priceCandidates(toks: Tok[], currency: Currency): PriceHit[] {
  const hits: PriceHit[] = [];
  const pair = (a: Tok | undefined, b: Tok | undefined, cur: Currency) =>
    pairable(a, b) ? { value: combinePair(a!.value!, b!.value!, cur), note: `read spoken "${a!.value} ${b!.value}" as one price` } : undefined;
  const qtyLike = (t: Tok | undefined) =>
    Boolean(t) && (t!.kind === "size" || t!.kind === "color" || PIECE_WORDS.has(t!.w) || GARMENTS.has(t!.w) || t!.w === "each");

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.used) continue;

    const pre = t.kind === "sym" || t.kind === "word" ? CURRENCY_PREFIX[t.w] : undefined;
    if (pre) {
      let j = i + 1;
      if (toks[j]?.w === ".") j++;
      if (isNum(toks[j])) {
        const p = pair(toks[j], toks[j + 1], pre);
        hits.push({ value: p?.value ?? toks[j]!.value!, strength: 3, currency: pre, start: i, end: p ? j + 1 : j, ...(p ? { note: p.note } : {}) });
      }
    }

    if (isNum(t)) {
      const next = toks[i + 1];
      const suf = next && !next.used && (next.kind === "word" || next.kind === "sym") ? CURRENCY_SUFFIX[next.w] : undefined;
      if (suf) {
        const p = pair(toks[i - 1], t, suf);
        let value = p?.value ?? t.value!;
        let end = i + 1;
        let k = end + 1;
        if (toks[k]?.w === "and") k++;
        if (isNum(toks[k]) && ["cents", "cent", "paise"].includes(toks[k + 1]?.w ?? "")) {
          value += toks[k]!.value! / 100;
          end = k + 1;
        }
        hits.push({ value, strength: 3, currency: suf, start: p ? i - 1 : i, end, ...(p ? { note: p.note } : {}) });
      } else if (isWord(next, "only") && t.value! >= MIN_PRICE[currency]) {
        hits.push({ value: t.value!, strength: 2, start: i, end: i + 1 });
      } else if (t.idiom && !qtyLike(next)) {
        hits.push({ value: t.value!, strength: 2, currency: "INR", start: i, end: i });
      }
    }

    if (isWord(t, PRICE_CUES)) {
      let j = i + 1;
      while (j < i + 3 && isWord(toks[j], PRICE_CUE_FILLERS)) j++;
      if (toks[j]?.w === ":") j++;
      const n = toks[j];
      if (isNum(n) && n.value! >= MIN_PRICE[currency] && !qtyLike(toks[j + 1])) {
        const p = pair(n, toks[j + 1], currency);
        hits.push({ value: p?.value ?? n.value!, strength: 2, start: i, end: p ? j + 1 : j, ...(p ? { note: p.note } : {}) });
      }
    }
  }
  return hits;
}

function takeExplicitPrice(toks: Tok[], currency: Currency, warnings: string[]): PriceHit | undefined {
  const hits = priceCandidates(toks, currency);
  if (!hits.length) return undefined;
  const top = Math.max(...hits.map((h) => h.strength));
  const best = hits.filter((h) => h.strength === top).sort((a, b) => a.start - b.start).at(-1)!;
  const others = new Set(hits.filter((h) => h.strength === top && h.value !== best.value).map((h) => h.value));
  if (others.size) warnings.push(`heard more than one price (${[...others, best.value].join(", ")}); using the last, ${best.value}`);
  if (best.note) warnings.push(best.note);
  use(toks, best.start, best.end, "price");
  return best;
}

function takeBarePrice(toks: Tok[], currency: Currency, warnings: string[]): number | undefined {
  const idx = toks.map((t, i) => (isNum(t) && t.value! >= MIN_PRICE[currency] ? i : -1)).filter((i) => i >= 0);
  const last = idx.at(-1);
  if (last === undefined) return undefined;
  const prev = toks[last - 1];
  if (pairable(prev, toks[last])) {
    const value = combinePair(prev!.value!, toks[last]!.value!, currency);
    use(toks, last - 1, last, "price");
    warnings.push(`price read from bare spoken numbers as ${value}; confirm it`);
    return value;
  }
  use(toks, last, last, "price");
  warnings.push(`price read from a bare number (${toks[last]!.value}); confirm it`);
  return toks[last]!.value;
}

// ---------- variants ----------

const NUMERIC_SIZE_CUES = new Set(["size", "sizes", "waist"]);
const SIZE_LIST_JOINERS = new Set([",", "and", "&", "/", "or"]);

/** "sizes 28, 30 and 32" -> three size tokens. Runs after the price is taken; the list must ascend. */
function markNumericSizes(toks: Tok[]): void {
  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i], NUMERIC_SIZE_CUES)) continue;
    let j = i + 1;
    let prev = -1;
    let marked = 0;
    for (;;) {
      const t = toks[j];
      if (marked && t && SIZE_LIST_JOINERS.has(t.w) && isNum(toks[j + 1])) {
        j += 1;
        continue;
      }
      if (!isNum(t) || !Number.isInteger(t.value) || t.value! < 0 || t.value! > 60 || t.value! <= prev) break;
      const next = toks[j + 1];
      if (next && (isWord(next, "each") || isWord(next, "of") || PIECE_WORDS.has(next.w) || CURRENCY_SUFFIX[next.w])) break;
      toks[j] = { ...t, kind: "size", canon: String(t.value) };
      prev = t.value!;
      marked += 1;
      j += 1;
    }
    if (marked) toks[i]!.used = "variant";
    i = j - 1;
  }
}

interface Entry {
  size?: string;
  color?: string;
  qty?: number;
  pos: number;
  colors?: string[];
}

function qtyAt(toks: Tok[], j: number, max = 99): number | undefined {
  const t = toks[j];
  if (!free(t)) return undefined;
  if (t.kind === "num" && Number.isInteger(t.value) && t.value! > 0 && t.value! <= max) return t.value;
  if (t.kind === "word" && ARTICLE_QTY.has(t.w)) return 1;
  return undefined;
}

const CONNECTORS = new Set(["x", "×", ":", "-", "=", "of"]);
const JOINERS = new Set(["and", ",", "&", "or", "/"]);
const COLOUR_CUES = new Set(["in", "colours", "colors", "colour", "color", "shades", "shade"]);

function findVariants(toks: Tok[], warnings: string[]): Entry[] {
  const entries: Entry[] = [];

  // Style: "S 2, M 3" puts the count after the size; "two smalls" puts it before.
  const firstSize = toks.findIndex((t) => t.kind === "size" && !t.used);
  let sizeFirst = false;
  if (firstSize >= 0 && qtyAt(toks, firstSize - 1) === undefined && !(toks[firstSize - 1]?.kind === "color" && qtyAt(toks, firstSize - 2) !== undefined)) {
    const k = CONNECTORS.has(toks[firstSize + 1]?.w ?? "") ? firstSize + 2 : firstSize + 1;
    sizeFirst = toks[k]?.kind === "num" && qtyAt(toks, k) !== undefined && toks[k + 1]?.kind === "size";
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== "size" || t.used) continue;
    const e: Entry = { size: t.canon!, pos: i };
    const idx = [i];
    if (!sizeFirst) {
      let j = i - 1;
      let colorIdx: number | undefined;
      if (toks[j]?.kind === "color" && !toks[j]!.used) {
        colorIdx = j;
        j -= 1;
      }
      const q = qtyAt(toks, j);
      if (q !== undefined) {
        e.qty = q;
        idx.push(j);
      }
      if (colorIdx !== undefined) {
        e.color = toks[colorIdx]!.canon!;
        idx.push(colorIdx);
      }
    }
    if (e.qty === undefined) {
      const connector = CONNECTORS.has(toks[i + 1]?.w ?? "") && toks[i + 1]?.w !== "of";
      const k = connector ? i + 2 : i + 1;
      const eachNext = isWord(toks[k + 1], "each") || (isWord(toks[k + 1], "of") && isWord(toks[k + 2], "each"));
      const q = toks[k]?.kind === "num" && !eachNext ? qtyAt(toks, k, connector || sizeFirst ? 99 : 20) : undefined;
      const nextIsSize = toks[k + 1]?.kind === "size" || (toks[k + 1]?.kind === "color" && toks[k + 2]?.kind === "size");
      if (q !== undefined && (sizeFirst || connector || !nextIsSize)) {
        e.qty = q;
        for (let m = i + 1; m <= k; m++) idx.push(m);
      }
    }
    for (const m of idx) toks[m]!.used = "variant";
    entries.push(e);
  }

  // "two each" / "two of each"
  let eachQty: number | undefined;
  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i], "each")) continue;
    const back = isWord(toks[i - 1], "of") ? i - 2 : i - 1;
    const q = toks[back]?.kind === "num" ? qtyAt(toks, back) : undefined;
    if (q !== undefined) {
      eachQty = q;
      use(toks, back, i, "variant");
    }
  }

  // Colour-only counts: "three in black, two in red", "two black".
  for (let i = 0; i < toks.length; i++) {
    if (toks[i]?.kind !== "num") continue;
    const q = qtyAt(toks, i);
    if (q === undefined) continue;
    const j = isWord(toks[i + 1], "in") ? i + 2 : i + 1;
    const c = toks[j];
    if (c?.kind === "color" && !c.used && toks[j + 1]?.kind !== "size") {
      entries.push({ color: c.canon!, qty: q, pos: j });
      use(toks, i, j, "variant");
    }
  }

  // Colour mentions, grouped: "in blue and red".
  const groups: { idx: number[]; colors: string[]; mention: boolean }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== "color" || t.used) continue;
    const g = groups.at(-1);
    const gap = g ? toks.slice(g.idx.at(-1)! + 1, i) : [];
    if (g && gap.every((x) => JOINERS.has(x.w))) {
      g.idx.push(i);
      g.colors.push(t.canon!);
    } else {
      const before = toks[i - 1];
      const mention = Boolean(before && !before.used && COLOUR_CUES.has(before.w)) || toks[i + 1]?.w === ":";
      groups.push({ idx: [i], colors: [t.canon!], mention });
    }
  }
  const mentions = groups.filter((g) => g.mention);
  for (const g of mentions) {
    const first = g.idx[0]!;
    if (toks[first - 1] && COLOUR_CUES.has(toks[first - 1]!.w)) toks[first - 1]!.used = "variant";
    use(toks, first, g.idx.at(-1)!, "variant");
  }

  // A mention colours the uncoloured sizes before it; with none pending it colours the ones after it.
  const attached = new Set<(typeof mentions)[number]>();
  const timeline = [
    ...entries.filter((e) => e.size && !e.color).map((e) => ({ pos: e.pos, e })),
    ...mentions.map((g) => ({ pos: g.idx[0]!, g })),
  ].sort((a, b) => a.pos - b.pos);
  let pending: Entry[] = [];
  let forward: (typeof mentions)[number] | undefined;
  const paint = (g: (typeof mentions)[number], es: Entry[]) => {
    attached.add(g);
    for (const e of es) {
      if (g.colors.length === 1) e.color = g.colors[0];
      else e.colors = [...g.colors];
    }
  };
  for (const ev of timeline) {
    if ("e" in ev && ev.e) {
      if (forward) paint(forward, [ev.e]);
      else pending.push(ev.e);
    } else if ("g" in ev && ev.g) {
      if (pending.length) {
        paint(ev.g, pending);
        pending = [];
        forward = undefined;
      } else forward = ev.g;
    }
  }

  // "five sarees", "3 pieces", "only one": the whole stock, or the count of a lone variant named without one.
  const lone = entries.length === 1 && entries[0]!.qty === undefined ? entries[0] : undefined;
  if (!entries.length || lone) {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.kind !== "num" || t.used || !Number.isInteger(t.value) || t.value! <= 0 || t.value! > 99) continue;
      const next = toks[i + 1];
      const pieceNext = next && (PIECE_WORDS.has(next.w) || GARMENTS.has(next.w) || (next.w === "in" && toks[i + 2]?.w === "stock"));
      const onlyOne = t.value === 1 && (isWord(toks[i - 1], "only") || isWord(toks[i - 1], "just"));
      if (pieceNext || onlyOne) {
        if (lone) lone.qty = t.value!;
        else entries.push({ qty: t.value!, pos: i });
        use(toks, i, pieceNext && PIECE_WORDS.has(next!.w) ? i + 1 : i, "variant");
        if (onlyOne) toks[i - 1]!.used = "variant";
        break;
      }
    }
  }

  if (!entries.length) {
    const g = mentions.find((m) => !attached.has(m));
    if (g) for (const c of g.colors) entries.push({ color: c, pos: g.idx[0]!, ...(eachQty !== undefined ? { qty: eachQty } : {}) });
  }

  if (eachQty !== undefined) for (const e of entries) if (e.qty === undefined) e.qty = eachQty;

  const expanded: Entry[] = [];
  for (const e of entries) {
    if (!e.colors) expanded.push(e);
    else {
      warnings.push(`assumed ${e.size} comes in every colour (${e.colors.join(", ")})`);
      for (const c of e.colors) expanded.push({ ...e, color: c, colors: undefined });
    }
  }

  const distinct = [...new Set(toks.filter((t) => t.kind === "color").map((t) => t.canon!))];
  const uncoloured = expanded.filter((e) => !e.color);
  if (uncoloured.length && distinct.length === 1) for (const e of uncoloured) e.color = distinct[0];
  else if (uncoloured.length && distinct.length > 1 && expanded.some((e) => e.color)) {
    warnings.push(`colour not stated for ${uncoloured.map((e) => e.size ?? "one variant").join(", ")}`);
  }

  const merged: Entry[] = [];
  for (const e of expanded) {
    const same = merged.find((m) => m.size === e.size && m.color === e.color);
    if (!same) merged.push({ ...e });
    else if (same.qty !== undefined && e.qty !== undefined) same.qty += e.qty;
    else same.qty = same.qty ?? e.qty;
  }
  return merged;
}

// ---------- title ----------

function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((word, i) => {
      if (/\d/.test(word) || (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word))) return word;
      const lower = word.toLowerCase();
      if (i > 0 && SMALL_TITLE_WORDS.has(lower)) return lower;
      return lower.replace(/(^|[-'])(\p{L})/gu, (_, sep: string, ch: string) => (sep === "'" ? sep + ch : sep + ch.toUpperCase()));
    })
    .join(" ");
}

function findTitle(text: string, toks: Tok[]): string | undefined {
  const runs: Tok[][] = [];
  let cur: Tok[] = [];
  for (const t of toks) {
    if ((t.kind === "word" || t.kind === "color") && !t.used) cur.push(t);
    else if (t.kind === "sym" && t.w === "&" && cur.length) cur.push(t);
    else {
      if (cur.length) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);

  const trimmed = runs
    .map((r) => {
      let a = 0;
      let b = r.length;
      while (a < b && (STOPWORDS.has(r[a]!.w) || FLUFF.has(r[a]!.w) || r[a]!.w === "&")) a++;
      while (b > a && (STOPWORDS.has(r[b - 1]!.w) || r[b - 1]!.w === "&")) b--;
      return r.slice(a, b);
    })
    .filter((r) => r.some((t) => !STOPWORDS.has(t.w) && !FLUFF.has(t.w)));
  if (!trimmed.length) return undefined;

  let pick = trimmed.find((r) => r.some((t) => GARMENTS.has(t.w)));
  if (pick) {
    let lastG = -1;
    pick.forEach((t, i) => {
      if (GARMENTS.has(t.w)) lastG = i;
    });
    let end = lastG;
    if (pick[end + 1] && TITLE_TAIL.has(pick[end + 1]!.w)) {
      end += pick[end + 1]!.w === "with" ? Math.min(3, pick.length - 1 - end) : 1;
    }
    pick = pick.slice(0, end + 1);
    while (pick.length > 1 && STOPWORDS.has(pick.at(-1)!.w)) pick = pick.slice(0, -1);
  } else {
    pick = [...trimmed].sort((a, b) => b.length - a.length)[0]!;
  }
  return titleCase(text.slice(pick[0]!.from, pick.at(-1)!.to));
}

// ---------- assembly ----------

function slug(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function assignSkus(code: string | undefined, variants: Omit<VariantDraft, "sku">[]): VariantDraft[] {
  const seen = new Set<string>();
  return variants.map((v) => {
    const parts = [code ?? "NEW", v.size ?? (v.color ? "" : "OS"), v.color ?? ""].filter(Boolean).map(slug);
    let sku = parts.join("-");
    for (let n = 2; seen.has(sku); n++) sku = `${parts.join("-")}-${n}`;
    seen.add(sku);
    return { sku, ...(v.size ? { size: v.size } : {}), ...(v.color ? { color: v.color } : {}), ...(v.qty !== undefined ? { qty: v.qty } : {}) };
  });
}

export function missingFields(d: ListingDraft): ListingField[] {
  const out: ListingField[] = [];
  if (!d.code) out.push("code");
  if (!d.title) out.push("title");
  if (d.priceCents === undefined) out.push("price");
  if (!d.variants.length || d.variants.some((v) => v.qty === undefined)) out.push("variants");
  return out;
}

export function toItem(d: ListingDraft): ShowItem | undefined {
  if (missingFields(d).length) return undefined;
  return {
    code: d.code!,
    title: d.title!,
    priceCents: d.priceCents!,
    variants: d.variants.map((v) => ({ sku: v.sku, qty: v.qty!, ...(v.size ? { size: v.size } : {}), ...(v.color ? { color: v.color } : {}) })),
  };
}

export function scoreConfidence(missing: number, warnings: number, penalties: number): number {
  const c = 1 - 0.25 * missing - 0.05 * Math.min(warnings, 4) - penalties;
  return Math.max(0, Math.min(1, Math.round(c * 100) / 100));
}

/** Deterministic parse of one host utterance. No I/O. */
export function parseListingRules(transcript: string, ctx: ListingContext = {}): ListingResult {
  const warnings: string[] = [];
  let penalties = 0;
  const lexed = markLexemes(tokenize(transcript));
  const indian = ctx.currency === "INR" || (ctx.currency === undefined && lexed.some((t) => INDIAN_MARKERS.has(t.w)));
  const toks = mergeNumbers(lexed, { hindi: indian });
  const guess: Currency = ctx.currency ?? (indian ? "INR" : "USD");

  let code = findCode(toks);
  const explicit = takeExplicitPrice(toks, guess, warnings);
  const currency: Currency = ctx.currency ?? explicit?.currency ?? guess;
  if (ctx.currency && explicit?.currency && explicit.currency !== ctx.currency) {
    warnings.push(`heard ${explicit.currency} but the show is in ${ctx.currency}`);
    penalties += 0.1;
  }
  if (!code && explicit) {
    code = leadingCode(toks);
    if (code) warnings.push(`took the leading number ${code} as the item code`);
  }

  markNumericSizes(toks);
  const entries = findVariants(toks, warnings);
  let price = explicit?.value;
  if (price === undefined) {
    price = takeBarePrice(toks, currency, warnings);
    if (price !== undefined) penalties += 0.1;
  }

  const title = findTitle(transcript, toks);

  if (!code && ctx.nextCode) {
    code = ctx.nextCode;
    warnings.push(`no code spoken; assigned ${code}`);
  }
  if (code && ctx.existingCodes?.includes(code)) {
    warnings.push(`code ${code} is already listed in this show`);
    penalties += 0.2;
  }
  const unknownQty = entries.filter((e) => e.qty === undefined);
  if (unknownQty.length) warnings.push(`no count for ${unknownQty.map((e) => [e.size, e.color].filter(Boolean).join(" ") || "the item").join(", ")}`);

  const draft: ListingDraft = {
    ...(code ? { code } : {}),
    ...(title ? { title } : {}),
    ...(price !== undefined ? { priceCents: Math.round(price * 100) } : {}),
    currency,
    variants: assignSkus(code, entries.map(({ size, color, qty }) => ({ ...(size ? { size } : {}), ...(color ? { color } : {}), ...(qty !== undefined ? { qty } : {}) }))),
  };
  const missing = missingFields(draft);
  const item = toItem(draft);
  return {
    draft,
    missing,
    warnings,
    confidence: scoreConfidence(missing.length, warnings.length, penalties),
    method: "rule",
    transcript,
    ...(item ? { item } : {}),
  };
}
