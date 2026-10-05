import path from "node:path";
import { createLlmClient } from "@claim/llm";
import { selectGateway } from "./payments";
import { createShowService, type ShowService } from "./service";
import { createFileStore } from "./store";
import type { ViewScope } from "./types";

const g = globalThis as typeof globalThis & { __claimShows?: ShowService };

/** One service per server process; dev HMR re-evaluates modules, so it lives on globalThis. */
export function getService(): ShowService {
  if (!g.__claimShows) {
    let llm;
    try {
      llm = createLlmClient(process.env);
    } catch {
      llm = undefined;
    }
    g.__claimShows = createShowService({
      store: createFileStore(process.env.CLAIM_DATA_DIR ?? path.join(process.cwd(), ".data")),
      gateway: selectGateway(process.env),
      ...(llm ? { llm } : {}),
    });
  }
  return g.__claimShows;
}

/**
 * `?scope=seller` asks for the seller view, which adds buyers' ship-to addresses. Buyer rooms never ask
 * for it, so addresses stay out of every buyer's browser. There is no seller login in this demo, so the
 * parameter is a scope, not access control (see the README's limitations).
 */
export function scopeOf(url: string): ViewScope {
  return new URL(url).searchParams.get("scope") === "seller" ? "seller" : "public";
}
