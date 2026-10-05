import type { BoardItem, BoardVariant } from "@claim/core";
import { SCENARIOS, type ScenarioId } from "./types";

export interface ScriptLine {
  user: string;
  text: string;
  /** platformTs offset from the scenario start: when the viewer hit send. */
  tsMs: number;
  /** Arrival offset: when the comment reaches us. Larger than tsMs means ingestion lag. */
  arriveMs: number;
}

export interface Script {
  id: ScenarioId;
  label: string;
  lines: ScriptLine[];
  /** Simulated buyers who already saved a Claim Pass; `declines` marks a card that will decline at close-out. */
  passes: { user: string; declines?: boolean }[];
}

const SIZE_WORDS: Record<string, string> = { XS: "extra small", S: "small", M: "medium", L: "large", XL: "xl" };

/** What a viewer would type for this variant: the size if sizes differ, else the colour. */
function phrase(item: BoardItem, v: BoardVariant): string {
  const sizes = new Set(item.variants.map((x) => x.size).filter(Boolean));
  if (v.size && sizes.size > 1) return v.size;
  return v.color ?? v.size ?? v.sku;
}

function word(item: BoardItem, v: BoardVariant): string {
  const p = phrase(item, v);
  return SIZE_WORDS[p] ?? p;
}

const byAvailableThenQty = (a: BoardVariant, b: BoardVariant) => a.available - b.available || a.qty - b.qty;

/** The variant a race is most interesting on: exactly two left if possible. */
function raceVariant(item: BoardItem): BoardVariant {
  const open = item.variants.filter((v) => v.available > 0);
  return open.find((v) => v.available === 2) ?? [...open].sort((a, b) => b.available - a.available)[0] ?? item.variants[0]!;
}

/** A variant with exactly one unit left, so a single earlier claim decides it. */
function lastUnitVariant(item: BoardItem): BoardVariant {
  const open = item.variants.filter((v) => v.available > 0).sort(byAvailableThenQty);
  return open[0] ?? item.variants[0]!;
}

/** The variant with the most stock left, so a basket line is granted rather than waitlisted. */
function openVariant(item: BoardItem): BoardVariant {
  return [...item.variants].sort((a, b) => b.available - a.available)[0] ?? item.variants[0]!;
}

function spread(texts: string[], users: string[], stepMs: number, jitterMs: number): ScriptLine[] {
  return texts.map((text, i) => {
    const tsMs = i * stepMs;
    return { user: users[i % users.length]!, text, tsMs, arriveMs: tsMs + 60 + ((i * 97) % jitterMs) };
  });
}

const CROWD = ["mia.rose", "kendall_b", "shopwithsam", "tasha.j", "priya_k", "lou_lou", "dee.styles", "bree22", "nina.m", "jojo", "aunt_carol", "kat.p"];
const DESI = ["ananya_s", "riya.k", "meera_j", "simran.b", "kavya", "pooja.d", "neha_r", "isha"];

export interface HolderHint {
  user: string;
  itemCode: string;
}

/**
 * Builds a scenario against whatever is on air right now, so it works on any listed item.
 * `holder` lets the cancel scenario reuse a simulated buyer who already holds a unit with a waitlist behind it.
 * `others` are the show's other listed items; the bundle scenario claims across them.
 */
export function buildScript(id: ScenarioId, item: BoardItem, holder?: HolderHint, others: BoardItem[] = []): Script {
  const label = SCENARIOS.find((s) => s.id === id)!.label;
  const code = item.code;

  switch (id) {
    case "race": {
      const v = phrase(item, raceVariant(item));
      return {
        id,
        label,
        lines: [
          { user: "ava", text: `SOLD ${code} ${v}`, tsMs: 0, arriveMs: 40 },
          { user: "dana", text: `${code} ${v} mine!!`, tsMs: 140, arriveMs: 210 },
          { user: "ben", text: `me ${v} please`, tsMs: 230, arriveMs: 300 },
          { user: "cleo", text: `sold ${v} 🙏`, tsMs: 390, arriveMs: 450 },
        ],
        passes: [{ user: "ava" }, { user: "dana", declines: true }, { user: "ben" }],
      };
    }
    case "jitter": {
      const v = phrase(item, lastUnitVariant(item));
      return {
        id,
        label,
        lines: [
          { user: "gia", text: `${code} ${v} sold`, tsMs: 400, arriveMs: 420 },
          // Sent first, but its network path is slow: it lands 900 ms after gia's, inside the settle window.
          { user: "hal", text: `sold ${code} ${v}`, tsMs: 120, arriveMs: 1320 },
        ],
        passes: [{ user: "gia" }],
      };
    }
    case "cancel": {
      if (holder && holder.itemCode === code) {
        return {
          id,
          label,
          lines: [{ user: holder.user, text: `nvm cancel ${code} 😅`, tsMs: 0, arriveMs: 50 }],
          passes: [],
        };
      }
      const v = phrase(item, lastUnitVariant(item));
      return {
        id,
        label,
        lines: [
          { user: "eli", text: `${code} ${v}`, tsMs: 0, arriveMs: 50 },
          { user: "fay", text: `${v} for me pls`, tsMs: 600, arriveMs: 650 },
          { user: "eli", text: `jk cancel ${code}`, tsMs: 2600, arriveMs: 2650 },
        ],
        passes: [{ user: "fay" }],
      };
    }
    case "slang": {
      const v = item.variants[0]!;
      const alt = item.variants[1] ?? v;
      const p = phrase(item, v);
      const texts = [
        "SOLD!!!",
        "me me me 🙋‍♀️",
        `mine ${p}`,
        "omg obsessed",
        `${phrase(item, alt)} plsss`,
        `can i get a ${word(item, v)}`,
        "how much is shipping?",
        `x2 ${p}`,
        `is ${code} in red?`,
        "ME",
        `${word(item, alt)} for me`,
        "this color tho 😍",
      ];
      return { id, label, lines: spread(texts, CROWD, 260, 240), passes: [{ user: "mia.rose" }, { user: "shopwithsam" }] };
    }
    case "hinglish": {
      const v = item.variants[0]!;
      const alt = item.variants[item.variants.length - 1] ?? v;
      const p = phrase(item, v);
      const q = phrase(item, alt);
      const texts = [
        `mujhe ${code} ${p} chahiye`,
        "ye kitne ka hai?",
        `bhaiya ${code} ${q} de do na`,
        `${p} wala mera`,
        "mast hai yaar 😍",
        `kya ${code} red mein hai?`,
        `ek ${p} mere liye`,
        `${code} ${q} pakka`,
      ];
      return { id, label, lines: spread(texts, DESI, 320, 260), passes: [{ user: "ananya_s" }] };
    }
    case "bundle": {
      const p = phrase(item, openVariant(item));
      const [b, c] = others.filter((o) => o.variants.some((v) => v.available > 0));
      const lines: ScriptLine[] = [
        // Items off the screen need a claim word: a bare number for them goes to review.
        { user: "nora", text: b ? `sold ${code} ${p} and ${b.code} ${phrase(b, openVariant(b))}` : `sold ${code} ${p}`, tsMs: 0, arriveMs: 60 },
      ];
      if (c) lines.push({ user: "nora", text: `claim ${c.code} ${phrase(c, openVariant(c))} too 🛍️`, tsMs: 1800, arriveMs: 1870 });
      return { id, label, lines, passes: [{ user: "nora" }] };
    }
  }
}
