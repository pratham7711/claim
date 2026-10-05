import type { ResolvedIntent } from "@claim/resolver";
import type { Example, GoldItem } from "./data.js";

export const GRANT_AT = 0.8;
const ITEM_KINDS = new Set(["claim", "change", "waitlist"]);
const GRANT_KINDS = new Set(["claim", "change"]);

const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
export const isGrant = (i: ResolvedIntent) => GRANT_KINDS.has(i.kind) && !!i.itemCode && i.confidence >= GRANT_AT;

export interface Scored {
  ex: Example;
  pred: ResolvedIntent[];
  latencyMs: number;
  viaLlm: boolean;
}

export interface Metrics {
  n: number;
  kindAcc: number;
  itemP: number;
  itemR: number;
  variantAcc: number;
  variantN: number;
  grants: number;
  grantPrecision: number;
  /** Labelled claims/changes naming a catalogue item that received a correct grant, over all such labels. */
  grantRecall: number;
  grantableN: number;
  /** Grants whose item was right but size/colour wrong. */
  wrongVariantGrants: number;
  harmful: number;
  harmfulRate: number;
  /** Grants split by confidence, so the engine's auto-accept line can be checked. */
  buckets: ConfidenceBucket[];
  llmRouted: number;
  p50: number;
  p95: number;
  llmP50: number;
  llmP95: number;
}

export interface ConfidenceBucket {
  label: string;
  lo: number;
  hi: number;
  grants: number;
  harmful: number;
}

const BUCKETS: [string, number, number][] = [
  ["0.80-0.85", 0.8, 0.85],
  ["0.85-0.90", 0.85, 0.9],
  [">=0.90", 0.9, Infinity],
];

export function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/**
 * A gold claim nobody can place (an ambiguous or absent code) is answered correctly by anything that
 * does not grant: it belongs in the seller's review lane.
 */
export function kindCorrect(ex: Example, pred: ResolvedIntent[]): boolean {
  const kind = pred[0]?.kind ?? "other";
  if (kind === ex.gold.kind) return true;
  const unplaceable = ITEM_KINDS.has(ex.gold.kind) && ex.gold.items.length === 0;
  return unplaceable && !pred.some(isGrant);
}

export interface GrantVerdict {
  intent: ResolvedIntent;
  harmful: boolean;
  wrongVariant: boolean;
}

const variantMatches = (g: GoldItem, p: ResolvedIntent) => (!g.size || norm(g.size) === norm(p.size)) && (!g.color || norm(g.color) === norm(p.color));

export function judgeGrants(ex: Example, pred: ResolvedIntent[]): GrantVerdict[] {
  return pred.filter(isGrant).map((intent) => {
    const same = ex.gold.items.filter((g) => g.code.toLowerCase() === intent.itemCode!.toLowerCase());
    const harmful = !GRANT_KINDS.has(ex.gold.kind) || same.length === 0;
    const wrongVariant = !harmful && !same.some((g) => variantMatches(g, intent));
    return { intent, harmful, wrongVariant };
  });
}

export function score(rows: Scored[]): Metrics {
  let kindOk = 0;
  let tp = 0;
  let predN = 0;
  let goldN = 0;
  let variantOk = 0;
  let variantN = 0;
  let grants = 0;
  let harmful = 0;
  let wrongVariant = 0;
  let grantable = 0;
  let granted = 0;
  const buckets: ConfidenceBucket[] = BUCKETS.map(([label, lo, hi]) => ({ label, lo, hi, grants: 0, harmful: 0 }));
  for (const { ex, pred } of rows) {
    if (kindCorrect(ex, pred)) kindOk++;
    const goldItems = ITEM_KINDS.has(ex.gold.kind) ? ex.gold.items : [];
    const predCodes = new Set(pred.filter((p) => ITEM_KINDS.has(p.kind) && p.itemCode).map((p) => p.itemCode!.toLowerCase()));
    const goldCodes = new Set(goldItems.map((g) => g.code.toLowerCase()));
    predN += predCodes.size;
    goldN += goldCodes.size;
    for (const c of predCodes) if (goldCodes.has(c)) tp++;
    for (const g of goldItems) {
      if (!g.size && !g.color) continue;
      const hits = pred.filter((p) => ITEM_KINDS.has(p.kind) && p.itemCode?.toLowerCase() === g.code.toLowerCase());
      if (!hits.length) continue;
      variantN++;
      if (hits.some((h) => variantMatches(g, h))) variantOk++;
    }
    const verdicts = judgeGrants(ex, pred);
    for (const v of verdicts) {
      grants++;
      if (v.harmful) harmful++;
      const b = buckets.find((x) => v.intent.confidence >= x.lo && v.intent.confidence < x.hi)!;
      b.grants++;
      if (v.harmful) b.harmful++;
      if (v.wrongVariant) wrongVariant++;
    }
    if (GRANT_KINDS.has(ex.gold.kind) && ex.gold.items.length > 0) {
      grantable++;
      if (verdicts.some((v) => !v.harmful)) granted++;
    }
  }
  const lat = rows.map((r) => r.latencyMs);
  const llmLat = rows.filter((r) => r.viaLlm).map((r) => r.latencyMs);
  const n = rows.length;
  return {
    n,
    kindAcc: kindOk / n,
    itemP: predN ? tp / predN : 1,
    itemR: goldN ? tp / goldN : 1,
    variantAcc: variantN ? variantOk / variantN : 1,
    variantN,
    grants,
    grantPrecision: grants ? (grants - harmful) / grants : 1,
    grantRecall: grantable ? granted / grantable : 1,
    grantableN: grantable,
    wrongVariantGrants: wrongVariant,
    harmful,
    harmfulRate: harmful / n,
    buckets,
    llmRouted: llmLat.length,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    llmP50: pct(llmLat, 50),
    llmP95: pct(llmLat, 95),
  };
}
