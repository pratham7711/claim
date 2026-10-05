/**
 * Merges two independent annotations of a held-out set into its gold file and reports agreement.
 * Usage: npx tsx eval/merge-labels.ts <a.jsonl> <b.jsonl> <gold-out.jsonl> <report-out.md>
 *
 * Annotator A labelled every row. Annotator B, without seeing A, labelled the claim candidates: rows A
 * called claim/change/cancel/waitlist plus rows matching claim keywords. Disagreements are resolved by
 * this rule, fixed before either label set was read (never by looking at resolver output):
 *  - Same kind: kept. For claim/change/cancel/waitlist, items keep only the codes both chose; a size,
 *    colour or qty they disagree on becomes null. No shared code leaves items [] (review-only).
 *  - Different kinds, and either annotator says claim or change: kind "claim", items [], tag "disputed".
 *    A grant on such a row counts as harmful; leaving it to the seller counts as correct.
 *  - Different kinds otherwise: A's kind, tag "disputed".
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Example, Gold, GoldItem } from "./lib/data.js";

type Row = Example & { gold: Gold };
const read = (f: string): Row[] =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);

const ITEM_KINDS = new Set(["claim", "change", "cancel", "waitlist"]);
const GRANT_KINDS = new Set(["claim", "change"]);

function mergeItems(a: GoldItem[], b: GoldItem[]): GoldItem[] {
  return a.flatMap((x) => {
    const y = b.find((i) => i.code === x.code);
    if (!y) return [];
    const same = <T>(p: T, q: T) => (p === q ? p : null);
    return [{ code: x.code, size: same(x.size, y.size), color: same(x.color, y.color), qty: same(x.qty, y.qty) }];
  });
}

export function merge(a: Row, b: Row | undefined): Row {
  if (!b) return a;
  const ka = a.gold.kind;
  const kb = b.gold.kind;
  if (ka === kb) {
    if (!ITEM_KINDS.has(ka)) return a;
    const items = mergeItems(a.gold.items, b.gold.items);
    const disputed = items.length !== a.gold.items.length || items.length !== b.gold.items.length || JSON.stringify(items) !== JSON.stringify(a.gold.items);
    return { ...a, gold: { ...a.gold, items, from: a.gold.from === b.gold.from ? a.gold.from : null }, tags: disputed ? [...a.tags, "disputed-items"] : a.tags };
  }
  if (GRANT_KINDS.has(ka) || GRANT_KINDS.has(kb)) return { ...a, gold: { kind: "claim", items: [], from: null }, tags: [...a.tags, "disputed"] };
  return { ...a, tags: [...a.tags, "disputed"] };
}

/** Cohen's kappa over paired labels. */
export function kappa(pairs: [string, string][]): number {
  const n = pairs.length;
  if (!n) return NaN;
  const po = pairs.filter(([x, y]) => x === y).length / n;
  const cats = new Set(pairs.flat());
  let pe = 0;
  for (const c of cats) pe += (pairs.filter(([x]) => x === c).length / n) * (pairs.filter(([, y]) => y === c).length / n);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

function main() {
  const [aFile, bFile, outFile, reportFile] = process.argv.slice(2);
  if (!aFile || !bFile || !outFile || !reportFile) throw new Error("usage: merge-labels <a> <b> <gold-out> <report-out>");
  const a = read(aFile);
  const b = new Map(read(bFile).map((r) => [r.id, r]));
  const both = a.filter((r) => b.has(r.id));
  const kinds = both.map((r): [string, string] => [r.gold.kind, b.get(r.id)!.gold.kind]);
  const claimish = (k: string) => (GRANT_KINDS.has(k) ? "claim/change" : "not");
  const binary = kinds.map(([x, y]): [string, string] => [claimish(x), claimish(y)]);
  const bothClaim = both.filter((r) => r.gold.kind === "claim" && b.get(r.id)!.gold.kind === "claim");
  const itemAgree = bothClaim.filter((r) => JSON.stringify(r.gold.items.map((i) => i.code).sort()) === JSON.stringify(b.get(r.id)!.gold.items.map((i) => i.code).sort())).length;
  const merged = a.map((r) => merge(r, b.get(r.id)));
  writeFileSync(outFile, merged.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const confusion = new Map<string, number>();
  for (const [x, y] of kinds) if (x !== y) confusion.set(`${x} / ${y}`, (confusion.get(`${x} / ${y}`) ?? 0) + 1);
  const count = (k: string) => merged.filter((r) => r.gold.kind === k).length;
  const report = [
    `# Annotator agreement: ${outFile.split("/").pop()}`,
    "",
    `- Rows: ${a.length}, all labelled by A. B labelled ${both.length} candidate rows blind to A.`,
    `- Kind agreement on those rows: ${kinds.filter(([x, y]) => x === y).length}/${both.length}; Cohen's kappa (6 kinds) ${kappa(kinds).toFixed(3)}; kappa (claim/change vs not) ${kappa(binary).toFixed(3)}.`,
    `- Rows both called claim: ${bothClaim.length}; same item codes on ${itemAgree}.`,
    `- Disagreements (A / B): ${[...confusion].map(([k, v]) => `${k} x${v}`).join(", ") || "none"}.`,
    `- Merged gold: ${["claim", "change", "cancel", "waitlist", "question", "other"].map((k) => `${k} ${count(k)}`).join(", ")}; disputed ${merged.filter((r) => r.tags.includes("disputed")).length}, disputed items ${merged.filter((r) => r.tags.includes("disputed-items")).length}.`,
    "",
    "Resolution rule (fixed before labels were read): same kind is kept, with items reduced to the codes both chose and disputed size/colour/qty set to null; different kinds where either says claim or change become a review-only claim (items [], tag disputed), so any grant on them is harmful; other different kinds keep A's kind, tagged disputed.",
  ].join("\n");
  writeFileSync(reportFile, report + "\n");
  console.log(report);
}

if (process.argv[1]?.endsWith("merge-labels.ts")) main();
