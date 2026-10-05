import { COLOR_PHRASES, SIZE_PHRASES } from "./lexicon.js";

export type TokKind = "word" | "num" | "sym" | "punct" | "size" | "color";
export type Role = "code" | "price" | "variant";

export interface Tok {
  kind: TokKind;
  /** Lower-cased text; for size/colour tokens the matched phrase. */
  w: string;
  from: number;
  to: number;
  value?: number;
  /** True when a number came from words ("thirty eight") rather than digits. */
  spoken?: boolean;
  /** Built with an Indian multiplier or fraction ("24 sau", "dhai hazaar", "2 lakh"): a price by idiom. */
  idiom?: boolean;
  /** Canonical size or colour. */
  canon?: string;
  used?: Role;
}

const TOKEN_RE =
  /(\b[2-6]x+l\b)|(\d+(?:,\d+)*(?:\.\d+)?(?:k(?![\p{L}]))?)|(\p{L}+(?:['’]\p{L}+)?)|(\/-|[₹$#×&])|([.,!?;:\n]|[-–—])/giu;

const WESTERN_GROUPS = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
const INDIAN_GROUPS = /^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/;

function numberValue(raw: string): number {
  const k = /k$/i.test(raw);
  const n = Number(raw.replace(/k$/i, "").replace(/,/g, ""));
  return k ? n * 1000 : n;
}

export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0];
    const from = m.index!;
    const to = from + raw.length;
    if (m[1]) out.push({ kind: "word", w: raw.toLowerCase(), from, to });
    else if (m[2]) {
      if (raw.includes(",") && !WESTERN_GROUPS.test(raw) && !INDIAN_GROUPS.test(raw)) {
        // "36,38,40" is a list, not thirty-six thousand.
        let at = from;
        raw.split(",").forEach((part, i) => {
          if (i > 0) out.push({ kind: "punct", w: ",", from: at - 1, to: at });
          if (part) out.push({ kind: "num", w: part.toLowerCase(), from: at, to: at + part.length, value: numberValue(part) });
          at += part.length + 1;
        });
      } else out.push({ kind: "num", w: raw.toLowerCase(), from, to, value: numberValue(raw) });
    } else if (m[3]) out.push({ kind: "word", w: raw.toLowerCase().replace(/’/g, "'"), from, to });
    else if (m[4]) out.push({ kind: "sym", w: raw, from, to });
    else out.push({ kind: "punct", w: raw === "\n" ? "." : raw, from, to });
  }
  // A hyphen glued between two words joins them ("thirty-eight", "cable-knit").
  return out.filter((t, i) => {
    if (t.kind !== "punct" || !/^[-–—]$/.test(t.w)) return true;
    const prev = out[i - 1];
    const next = out[i + 1];
    return !(prev?.kind === "word" && next?.kind === "word" && prev.to === t.from && next.from === t.to);
  });
}

function matchPhrases(toks: Tok[], kind: "size" | "color", phrases: [string[], string][]): Tok[] {
  const sorted = [...phrases].sort((a, b) => b[0].length - a[0].length);
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; ) {
    const t = toks[i]!;
    if (t.kind === "word") {
      const hit = sorted.find(([words]) => words.every((w, k) => toks[i + k]?.kind === "word" && toks[i + k]!.w === w));
      if (hit) {
        const last = toks[i + hit[0].length - 1]!;
        out.push({ kind, w: hit[0].join(" "), canon: hit[1], from: t.from, to: last.to });
        i += hit[0].length;
        continue;
      }
    }
    out.push(t);
    i += 1;
  }
  return out;
}

/** Turns size and colour phrases into single tokens. Runs before number merging so "one size" stays a size. */
export function markLexemes(toks: Tok[]): Tok[] {
  return matchPhrases(matchPhrases(toks, "size", SIZE_PHRASES), "color", COLOR_PHRASES);
}
