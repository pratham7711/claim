import { LlmError } from "./http.js";
import type { CompletionRequest, CompletionResult, LlmClient } from "./types.js";

export interface FallbackOptions {
  /** How long a rate-limited client sits out when the provider sent no Retry-After. */
  defaultCooldownMs?: number;
  now?: () => number;
}

/**
 * Tries each client in order. Groq and similar providers rate-limit per model, so when one model
 * answers 429 the next one still has headroom. A 429'd client sits out until its Retry-After passes;
 * when every client is sitting out the call fails at once, so the comment goes to review instead of waiting.
 */
export function createFallbackClient(clients: LlmClient[], opts: FallbackOptions = {}): LlmClient {
  const [primary] = clients;
  if (!primary) throw new Error("createFallbackClient needs at least one client");
  if (clients.length === 1) return primary;
  const cooldownMs = opts.defaultCooldownMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const benchedUntil = new Map<LlmClient, number>();

  return {
    provider: primary.provider,
    model: primary.model,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      let last: LlmError | undefined;
      for (const client of clients) {
        if ((benchedUntil.get(client) ?? 0) > now()) continue;
        try {
          return await client.complete(req);
        } catch (err) {
          if (!(err instanceof LlmError) || !err.retryable || req.signal?.aborted) throw err;
          if (err.status === 429) benchedUntil.set(client, now() + (err.retryAfterMs ?? cooldownMs));
          last = err;
        }
      }
      if (last) throw last;
      const wait = Math.min(...clients.map((c) => benchedUntil.get(c) ?? 0)) - now();
      throw new LlmError(`all ${clients.length} models are rate-limited for another ${Math.ceil(wait / 1000)}s`, 429, false, wait);
    },
  };
}
