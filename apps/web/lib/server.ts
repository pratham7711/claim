import path from "node:path";
import { createLlmClient } from "@claim/llm";
import { selectGateway } from "./payments";
import { createShowService, type ShowService } from "./service";
import { createFileStore } from "./store";

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
