import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolverContext, ShowItem } from "@claim/core";

export interface GoldItem {
  code: string;
  size: string | null;
  color: string | null;
  qty: number | null;
}

export interface Gold {
  kind: "claim" | "cancel" | "change" | "waitlist" | "question" | "other";
  items: GoldItem[];
  from: string | null;
}

export interface Example {
  id: string;
  show: string;
  current: string | null;
  text: string;
  gold: Gold;
  tags: string[];
}

export interface Dataset {
  name: string;
  /** How the set may be read: in-sample dev data or a held-out set scored once. */
  label: string;
  examples: Example[];
  ctxOf: (ex: Example) => ResolverContext;
}

interface ShowFile {
  shows: { id: string; current?: string | null; items: ShowItem[] }[];
}

const DATA = join(import.meta.dirname, "..", "data");

const readJsonl = (file: string): Example[] =>
  readFileSync(join(DATA, file), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Example);

/** Synthetic shows list items in presentation order: the context is everything shown so far, newest first. */
export function loadSynthetic(): Dataset {
  const { shows } = JSON.parse(readFileSync(join(DATA, "shows.json"), "utf8")) as ShowFile;
  const byId = new Map(shows.map((s) => [s.id, s]));
  return {
    name: "synthetic",
    label: "dev (in-sample)",
    examples: readJsonl("synthetic.jsonl"),
    ctxOf(ex) {
      const show = byId.get(ex.show);
      if (!show) throw new Error(`unknown show ${ex.show}`);
      const idx = show.items.findIndex((i) => i.code === ex.current);
      const items = show.items.slice(0, idx + 1).reverse();
      return idx >= 0 ? { currentItem: show.items[idx]!, items } : { items: show.items.slice().reverse() };
    },
  };
}

/** Real shows list their whole catalogue newest first; "current" is the item on screen, when known. */
function loadCatalogueSet(name: string, label: string, showsFile: string, dataFile: string): Dataset {
  const { shows } = JSON.parse(readFileSync(join(DATA, showsFile), "utf8")) as ShowFile;
  const byId = new Map(shows.map((s) => [s.id, s]));
  return {
    name,
    label,
    examples: readJsonl(dataFile),
    ctxOf(ex) {
      const show = byId.get(ex.show);
      if (!show) throw new Error(`unknown show ${ex.show}`);
      const code = ex.current ?? show.current ?? null;
      const currentItem = code ? show.items.find((i) => i.code === code) : undefined;
      return currentItem ? { currentItem, items: show.items } : { items: show.items };
    },
  };
}

const BURNED_V1 = "dev (was held-out v1, burned 2026-10-05)";
const BURNED_V2 = "dev (was held-out v2, burned 2026-10-05)";

/**
 * Every set the runner knows. dev-real2/dev-real2-claims were held-out v1 and dev-real3 was held-out v2:
 * each was scored once on 2026-10-05, then turned into dev data. heldout-v3 is the current held-out set.
 */
const SETS: Record<string, () => Dataset> = {
  synthetic: loadSynthetic,
  real: () => loadCatalogueSet("real", "dev (in-sample)", "real-shows.json", "real.jsonl"),
  "dev-real2": () => loadCatalogueSet("dev-real2", BURNED_V1, "dev-real2-shows.json", "dev-real2.jsonl"),
  "dev-real2-claims": () => loadCatalogueSet("dev-real2-claims", BURNED_V1, "dev-real2-shows.json", "dev-real2-claims.jsonl"),
  "dev-real3": () => loadCatalogueSet("dev-real3", BURNED_V2, "dev-real3-shows.json", "dev-real3.jsonl"),
  "heldout-v3": () => loadCatalogueSet("heldout-v3", "held-out v3 (scored once)", "heldout-v3-shows.json", "heldout-v3.jsonl"),
};

export const DEV_SETS = ["synthetic", "real", "dev-real2", "dev-real2-claims", "dev-real3"];

export function loadSets(names: string[]): Dataset[] {
  return names.map((n) => {
    const load = SETS[n];
    if (!load) throw new Error(`unknown set ${n}; known: ${Object.keys(SETS).join(", ")}`);
    return load();
  });
}
