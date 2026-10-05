import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ChatComment, ClaimIntent, EngineConfig, EngineEvent } from "@claim/core";
import type { ChargeRecord, OrderRecord, RefundRecord, TrackingRecord } from "./types";

/** One line of `<showId>.jsonl`. Engine events are the source of truth; the rest is show furniture. */
export type ShowRecord =
  | { k: "meta"; showId: string; title: string; shopName: string; createdAt: number; config: EngineConfig }
  | { k: "set"; at: number; startedAt?: number; streamUrl?: string; onAir?: string }
  | { k: "item"; code: string; transcript?: string }
  | { k: "event"; e: EngineEvent }
  | { k: "comment"; comment: ChatComment; intents: ClaimIntent[]; latencyMs: number }
  | { k: "pass"; buyerKey: string; vaultId: string; customerId: string; capCents?: number; setupKey?: string }
  | { k: "order"; order: OrderRecord }
  | { k: "charge"; charge: ChargeRecord }
  | { k: "refund"; refund: RefundRecord }
  | { k: "tracking"; tracking: TrackingRecord };

const SHOW_ID = /^[a-z0-9][a-z0-9-]{2,47}$/;

export function isShowId(id: string): boolean {
  return SHOW_ID.test(id);
}

export interface ShowStore {
  append(showId: string, rec: ShowRecord): void;
  load(showId: string): ShowRecord[] | undefined;
  list(): string[];
}

export function createFileStore(dir: string): ShowStore {
  const file = (showId: string) => {
    if (!isShowId(showId)) throw new Error(`bad show id ${showId}`);
    return path.join(dir, `${showId}.jsonl`);
  };
  return {
    append(showId, rec) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file(showId), `${JSON.stringify(rec)}\n`);
    },
    load(showId) {
      if (!isShowId(showId)) return undefined;
      const f = file(showId);
      if (!existsSync(f)) return undefined;
      const out: ShowRecord[] = [];
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as ShowRecord);
        } catch {
          // A torn last line from a crash mid-write: everything before it is intact.
        }
      }
      return out;
    },
    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.slice(0, -".jsonl".length))
        .filter(isShowId);
    },
  };
}

export function createMemoryStore(): ShowStore & { files: Map<string, ShowRecord[]> } {
  const files = new Map<string, ShowRecord[]>();
  return {
    files,
    append(showId, rec) {
      const list = files.get(showId) ?? [];
      list.push(structuredClone(rec));
      files.set(showId, list);
    },
    load(showId) {
      const list = files.get(showId);
      return list ? structuredClone(list) : undefined;
    },
    list() {
      return [...files.keys()];
    },
  };
}
