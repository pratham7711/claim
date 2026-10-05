import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmError, type CompletionResult, type LlmClient } from "@claim/llm";

export interface CallLog {
  calls: number;
  cacheHits: number;
  refused: number;
  /** Times a call waited out a provider rate limit before being sent again. */
  rateLimitWaits: number;
}

/**
 * Replays identical requests from disk so re-running the eval costs nothing. The stored latency and
 * cost are those of the original call, so reported numbers stay honest across replays.
 */
export function withCache(client: LlmClient, dir: string, log: CallLog): LlmClient {
  mkdirSync(dir, { recursive: true });
  return {
    provider: client.provider,
    model: client.model,
    async complete(req) {
      const key = createHash("sha256")
        .update(JSON.stringify([client.provider, client.model, req.messages, req.jsonSchema ?? null]))
        .digest("hex")
        .slice(0, 32);
      const file = join(dir, `${key}.json`);
      if (existsSync(file)) {
        log.cacheHits++;
        return JSON.parse(readFileSync(file, "utf8")) as CompletionResult;
      }
      const res = await client.complete(req);
      if (res.json !== undefined) writeFileSync(file, JSON.stringify(res));
      return res;
    },
  };
}

/**
 * The eval measures accuracy, not throughput: on a free tier a 429 would drop a batch to its rule answer
 * and score the provider's quota instead of the model. So wait out the rate limit and send again.
 * The latency the inner client reports excludes the wait. The live app does not do this; it fails fast to review.
 */
export function withRateLimitWait(client: LlmClient, log: CallLog, maxWaits = 8): LlmClient {
  return {
    provider: client.provider,
    model: client.model,
    async complete(req) {
      for (let waits = 0; ; waits++) {
        try {
          return await client.complete(req);
        } catch (err) {
          if (!(err instanceof LlmError) || err.status !== 429 || waits >= maxWaits) throw err;
          log.rateLimitWaits++;
          await new Promise((r) => setTimeout(r, Math.max(1000, err.retryAfterMs ?? 10_000)));
        }
      }
    },
  };
}

/** Hard ceiling on real (uncached) calls; past it the call fails and the resolver keeps its rule answer. */
export function withBudget(client: LlmClient, max: number, log: CallLog): LlmClient {
  return {
    provider: client.provider,
    model: client.model,
    async complete(req) {
      if (log.calls >= max) {
        log.refused++;
        throw new LlmError(`LLM call budget of ${max} exhausted`);
      }
      log.calls++;
      return client.complete(req);
    },
  };
}
