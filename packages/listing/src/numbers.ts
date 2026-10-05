import { PIECE_WORDS } from "./lexicon.js";
import { markLexemes, tokenize, type Tok } from "./tokens.js";

type Kind = "unit" | "teen" | "tens" | "hundred" | "big" | "digits";

const EN: Record<string, [number, Kind]> = {
  zero: [0, "unit"], one: [1, "unit"], two: [2, "unit"], three: [3, "unit"], four: [4, "unit"], five: [5, "unit"],
  six: [6, "unit"], seven: [7, "unit"], eight: [8, "unit"], nine: [9, "unit"],
  ten: [10, "teen"], eleven: [11, "teen"], twelve: [12, "teen"], thirteen: [13, "teen"], fourteen: [14, "teen"],
  fifteen: [15, "teen"], sixteen: [16, "teen"], seventeen: [17, "teen"], eighteen: [18, "teen"], nineteen: [19, "teen"],
  twenty: [20, "tens"], thirty: [30, "tens"], forty: [40, "tens"], fourty: [40, "tens"], fifty: [50, "tens"],
  sixty: [60, "tens"], seventy: [70, "tens"], eighty: [80, "tens"], ninety: [90, "tens"],
};

const MULT: Record<string, [number, Kind]> = {
  hundred: [100, "hundred"], sau: [100, "hundred"],
  thousand: [1_000, "big"], k: [1_000, "big"], grand: [1_000, "big"], hazaar: [1_000, "big"], hazar: [1_000, "big"],
  hajar: [1_000, "big"], hazzar: [1_000, "big"],
  lakh: [100_000, "big"], lakhs: [100_000, "big"], lac: [100_000, "big"], lacs: [100_000, "big"],
  million: [1_000_000, "big"],
};

/** Hindi number words, enabled only in Indian mode and only where a multiplier, size or piece word follows. */
const HI: Record<string, [number, Kind]> = {
  ek: [1, "unit"], do: [2, "unit"], teen: [3, "unit"], char: [4, "unit"], chaar: [4, "unit"], paanch: [5, "unit"],
  panch: [5, "unit"], chhe: [6, "unit"], chhah: [6, "unit"], saat: [7, "unit"], aath: [8, "unit"], nau: [9, "unit"],
  das: [10, "teen"], gyarah: [11, "teen"], barah: [12, "teen"], baarah: [12, "teen"], terah: [13, "teen"],
  chaudah: [14, "teen"], pandrah: [15, "teen"], solah: [16, "teen"], satrah: [17, "teen"], atharah: [18, "teen"],
  unnis: [19, "teen"], bees: [20, "teen"], pachees: [25, "teen"], pachchis: [25, "teen"], tees: [30, "teen"],
  chalis: [40, "teen"], chaalis: [40, "teen"], pachaas: [50, "teen"], pachas: [50, "teen"], sattar: [70, "teen"],
  assi: [80, "teen"], nabbe: [90, "teen"],
  dedh: [1.5, "unit"], derh: [1.5, "unit"], dhai: [2.5, "unit"], dhaai: [2.5, "unit"], adhai: [2.5, "unit"],
};

const IDIOM = new Set(["sau", "hazaar", "hazar", "hajar", "hazzar", "lakh", "lakhs", "lac", "lacs"]);

/** "saade teen hazaar" = 3,500; "paune do sau" = 175. */
const HI_MOD: Record<string, number> = { saade: 0.5, sade: 0.5, sava: 0.25, savaa: 0.25, paune: -0.25 };

const FOLLOWS: Record<Kind, Kind[]> = {
  digits: ["hundred", "big"],
  unit: ["hundred", "big"],
  teen: ["hundred", "big"],
  tens: ["unit", "hundred", "big"],
  hundred: ["unit", "teen", "tens", "big"],
  big: ["unit", "teen", "tens", "digits"],
};

export interface NumberOpts {
  /** Accept Hindi number words ("do hazaar", "24 sau"). */
  hindi?: boolean;
}

function wordNumber(toks: Tok[], i: number, opts: NumberOpts): [number, Kind] | undefined {
  const t = toks[i];
  if (!t || t.kind !== "word") return undefined;
  const next = toks[i + 1];
  if (EN[t.w]) return EN[t.w];
  if (MULT[t.w]) return MULT[t.w];
  if ((t.w === "a" || t.w === "an") && next?.kind === "word" && MULT[next.w]) return [1, "unit"];
  if (opts.hindi && HI[t.w]) {
    const ok = next && (next.kind === "size" || (next.kind === "word" && (MULT[next.w] || PIECE_WORDS.has(next.w))));
    if (ok) return HI[t.w];
  }
  return undefined;
}

/**
 * Collapses runs like "two thousand four hundred", "twenty four hundred", "24 sau" and "1.5 lakh" into one
 * number token. A run stops at the first word that could not continue it, so "fourteen thirty eight"
 * stays two numbers and "twelve ninety nine" can be read as a spoken price later.
 */
export function mergeNumbers(toks: Tok[], opts: NumberOpts = {}): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; ) {
    const start = i;
    let total = 0;
    let cur = 0;
    let last: Kind | undefined;
    let tensOpen = false;
    let spoken = false;
    let consumed = 0;
    let mod = 0;
    let idiom = false;

    for (;;) {
      const t = toks[i];
      if (!t) break;
      if (opts.hindi && t.kind === "word" && HI_MOD[t.w] !== undefined && last === undefined && mod === 0) {
        const n = wordNumber(toks, i + 1, opts);
        if (n && n[1] !== "hundred" && n[1] !== "big") {
          mod = HI_MOD[t.w]!;
        } else if (n) {
          // "sava lakh" = 1.25 lakh, "paune hazaar" = 750: the modifier stands in for an implicit "one".
          cur = 1 + HI_MOD[t.w]!;
          last = "unit";
        } else break;
        spoken = true;
        idiom = true;
        i += 1;
        consumed += 1;
        continue;
      }
      if (t.kind === "word" && t.w === "and" && (last === "hundred" || last === "big")) {
        const n = wordNumber(toks, i + 1, opts);
        if (n && (n[1] === "unit" || n[1] === "teen" || n[1] === "tens")) {
          i += 1;
          consumed += 1;
          continue;
        }
        break;
      }
      const n: [number, Kind] | undefined =
        t.kind === "num" && !t.used ? [t.value!, "digits"] : t.kind === "word" ? wordNumber(toks, i, opts) : undefined;
      if (!n) break;
      const [v, kind] = n;
      if (last !== undefined) {
        const allowed = kind === "unit" && last === "tens" ? tensOpen : FOLLOWS[last].includes(kind);
        if (!allowed) break;
      } else if (kind === "hundred" || kind === "big") {
        // A bare multiplier ("hundred", "k") is not a number on its own.
        if (!(t.w === "hundred" || t.w === "thousand")) break;
      }
      if (kind === "hundred") cur = (cur || 1) * v;
      else if (kind === "big") {
        total += (cur || 1) * v;
        cur = 0;
      } else {
        cur += v + mod;
        mod = 0;
      }
      tensOpen = kind === "tens";
      if (t.kind === "word") spoken = true;
      if (t.kind === "word" && IDIOM.has(t.w)) idiom = true;
      last = kind;
      i += 1;
      consumed += 1;
    }

    if (consumed === 0 || last === undefined) {
      out.push(toks[start]!);
      i = start + 1;
      continue;
    }
    const first = toks[start]!;
    const end = toks[i - 1]!;
    if (consumed === 1 && first.kind === "num") {
      out.push(first);
      continue;
    }
    out.push({
      kind: "num",
      w: first.w,
      from: first.from,
      to: end.to,
      value: Math.round((total + cur) * 100) / 100,
      spoken,
      ...(idiom ? { idiom } : {}),
    });
  }
  return out;
}

/** Reads a whole phrase as one number: "two thousand four hundred" -> 2400, "24 sau" -> 2400 (Hindi on). */
export function parseSpokenNumber(phrase: string, opts: NumberOpts = {}): number | undefined {
  const toks = mergeNumbers(markLexemes(tokenize(phrase)), opts);
  const nums = toks.filter((t) => t.kind === "num");
  if (nums.length !== 1 || toks.some((t) => t.kind !== "num" && t.kind !== "punct")) return undefined;
  return nums[0]!.value;
}
