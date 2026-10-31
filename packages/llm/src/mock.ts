import { parseJsonLoose } from "./json.js";
import type { CompletionRequest, CompletionResult, LlmClient, ToolCall, ToolChatRequest, ToolChatResult } from "./types.js";

/** A scripted reply: text, a JSON-able value, an Error to throw, or a function of the request. */
export type MockReply =
  | string
  | Error
  | Record<string, unknown>
  | unknown[]
  | ((req: CompletionRequest, call: number) => string | Error | Record<string, unknown> | unknown[]);

/** One scripted tool-calling turn: calls (arguments as text or an object), a final text, or an Error to throw. */
export type MockToolTurn =
  | { text?: string; toolCalls?: { name: string; arguments: string | Record<string, unknown>; id?: string }[] }
  | Error
  | ((req: ToolChatRequest, call: number) => MockToolTurn);

export interface MockOptions {
  /** Consumed in order, one per call. */
  replies?: MockReply[];
  /** Consumed in order, one per chat() call; once spent, chat() answers with empty text and no calls. */
  toolTurns?: MockToolTurn[];
  /** Used once `replies` runs out. Defaults to "{}". */
  fallback?: MockReply;
  /** Reported latency; nothing actually waits. */
  latencyMs?: number;
  model?: string;
}

export interface MockClient extends LlmClient {
  readonly calls: CompletionRequest[];
  readonly chatCalls: ToolChatRequest[];
  chat(req: ToolChatRequest): Promise<ToolChatResult>;
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

/** Deterministic stand-in for tests and the zero-key eval path. */
export function createMockClient(opts: MockOptions = {}): MockClient {
  const replies = [...(opts.replies ?? [])];
  const turns = [...(opts.toolTurns ?? [])];
  const calls: CompletionRequest[] = [];
  const chatCalls: ToolChatRequest[] = [];
  const model = opts.model ?? "mock-1";

  return {
    provider: "mock",
    model,
    calls,
    chatCalls,
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
    async chat(req: ToolChatRequest): Promise<ToolChatResult> {
      const call = chatCalls.length;
      chatCalls.push(req);
      let turn: MockToolTurn = turns.length ? turns.shift()! : { text: "" };
      while (typeof turn === "function") turn = turn(req, call);
      if (turn instanceof Error) throw turn;
      const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((c, i) => ({
        id: c.id ?? `mock_${call}_${i}`,
        name: c.name,
        arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
      }));
      const prompt = req.messages.map((m) => m.content).join("\n") + JSON.stringify(req.tools);
      const text = turn.text ?? "";
      return {
        text,
        toolCalls,
        model,
        latencyMs: opts.latencyMs ?? 0,
        usage: { inputTokens: approxTokens(prompt), outputTokens: approxTokens(text + toolCalls.map((c) => c.arguments).join("")) },
        attempts: 1,
      };
    },
  };
}
