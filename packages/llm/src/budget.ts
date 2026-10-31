import { LlmError } from "./http.js";
import type { CompletionRequest, CompletionResult, LlmClient, ToolChatRequest, ToolChatResult } from "./types.js";

/**
 * A hard ceiling on what a pay-per-token provider can spend from one process. Shared by every client it
 * wraps, so the fast model and its escalation model draw on one allowance. Once it is spent, or after
 * `until`, calls fail at once without reaching the provider, and the resolver keeps its rule answer.
 */
export interface TokenBudget {
  maxTokens: number;
  used: number;
  /** ISO date or timestamp; no provider calls on or after it. */
  until?: number;
}

export function createTokenBudget(env: Record<string, string | undefined>, defaults: { maxTokens: number }): TokenBudget {
  const max = Number(env.LLM_TOKEN_BUDGET);
  const until = env.LLM_DISABLE_AFTER ? Date.parse(env.LLM_DISABLE_AFTER) : NaN;
  return {
    maxTokens: Number.isFinite(max) && env.LLM_TOKEN_BUDGET !== "" && env.LLM_TOKEN_BUDGET !== undefined ? max : defaults.maxTokens,
    used: 0,
    ...(Number.isFinite(until) && { until }),
  };
}

export function budgetExhausted(budget: TokenBudget, now = Date.now()): string | undefined {
  if (budget.until !== undefined && now >= budget.until) return "LLM switched off after LLM_DISABLE_AFTER";
  if (budget.used >= budget.maxTokens) return `LLM token budget spent (${budget.used}/${budget.maxTokens})`;
  return undefined;
}

export function withTokenBudget(client: LlmClient, budget: TokenBudget, now: () => number = Date.now): LlmClient {
  async function metered<T extends { usage?: { inputTokens?: number; outputTokens?: number } }>(chars: number, maxTokens: number | undefined, call: () => Promise<T>): Promise<T> {
    const stop = budgetExhausted(budget, now());
    if (stop) throw new LlmError(stop, 402, false);
    // Reserve the worst case up front so concurrent calls cannot overshoot together.
    const reserve = Math.ceil(chars / 3) + (maxTokens ?? 1024);
    budget.used += reserve;
    // A failed or timed-out call may still have been billed, so its reservation is kept.
    const res = await call();
    const actual = (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0);
    budget.used += (actual || reserve) - reserve;
    return res;
  }
  const chat = client.chat?.bind(client);
  return {
    provider: client.provider,
    model: client.model,
    complete: (req: CompletionRequest): Promise<CompletionResult> =>
      metered(
        req.messages.reduce((n, m) => n + m.content.length, 0),
        req.maxTokens,
        () => client.complete(req),
      ),
    ...(chat
      ? {
          chat: (req: ToolChatRequest): Promise<ToolChatResult> =>
            metered(
              req.messages.reduce((n, m) => n + m.content.length, 0) + JSON.stringify(req.tools).length,
              req.maxTokens,
              () => chat(req),
            ),
        }
      : {}),
  };
}
