import { parseJsonLoose } from "./json.js";
import type { CompletionRequest, CompletionResult, LlmClient } from "./types.js";

/** A scripted reply: text, a JSON-able value, an Error to throw, or a function of the request. */
export type MockReply =
  | string
  | Error
  | Record<string, unknown>
  | unknown[]
  | ((req: CompletionRequest, call: number) => string | Error | Record<string, unknown> | unknown[]);

export interface MockOptions {
  /** Consumed in order, one per call. */
  replies?: MockReply[];
  /** Used once `replies` runs out. Defaults to "{}". */
  fallback?: MockReply;
  /** Reported latency; nothing actually waits. */
  latencyMs?: number;
  model?: string;
}

export interface MockClient extends LlmClient {
  readonly calls: CompletionRequest[];
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

/** Deterministic stand-in for tests and the zero-key eval path. */
export function createMockClient(opts: MockOptions = {}): MockClient {
  const replies = [...(opts.replies ?? [])];
  const calls: CompletionRequest[] = [];
  const model = opts.model ?? "mock-1";

  return {
    provider: "mock",
    model,
    calls,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const call = calls.length;
      calls.push(req);
      let reply = replies.length ? replies.shift()! : (opts.fallback ?? "{}");
      if (typeof reply === "function") reply = reply(req, call);
      if (reply instanceof Error) throw reply;
      const text = typeof reply === "string" ? reply : JSON.stringify(reply);
      const prompt = req.messages.map((m) => m.content).join("\n");
      return {
        text,
        json: req.jsonSchema ? parseJsonLoose(text) : undefined,
        model,
        latencyMs: opts.latencyMs ?? 0,
        usage: { inputTokens: approxTokens(prompt), outputTokens: approxTokens(text) },
        costUsd: 0,
        attempts: 1,
      };
    },
  };
}
