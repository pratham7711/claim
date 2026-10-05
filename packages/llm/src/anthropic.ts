import { LlmError, postJson, type RetryOptions } from "./http.js";
import { parseJsonLoose, splitSystem } from "./json.js";
import type { CompletionRequest, CompletionResult, LlmClient } from "./types.js";

export interface AnthropicOptions extends Omit<RetryOptions, "signal"> {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
}

export const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";

interface MessagesResponse {
  model?: string;
  stop_reason?: string;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Messages API over fetch. A jsonSchema becomes `output_config.format` (native structured output). */
export function createAnthropicClient(opts: AnthropicOptions): LlmClient {
  const model = opts.model || ANTHROPIC_DEFAULT_MODEL;
  const url = `${(opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
  const headers = { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" };

  return {
    provider: "anthropic",
    model,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const { system, rest } = splitSystem(req.messages);
      const body: Record<string, unknown> = {
        model,
        max_tokens: req.maxTokens ?? opts.maxTokens ?? 1024,
        messages: rest.map((m) => ({ role: m.role, content: m.content })),
      };
      if (system) body.system = system;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.jsonSchema) body.output_config = { format: { type: "json_schema", schema: req.jsonSchema.schema } };

      const started = performance.now();
      const { json, attempts } = await postJson(url, body, headers, { ...opts, signal: req.signal });
      const res = json as MessagesResponse;
      if (res.stop_reason === "refusal") throw new LlmError("anthropic: refusal");
      const text = (res.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return {
        text,
        json: req.jsonSchema ? parseJsonLoose(text) : undefined,
        model: res.model ?? model,
        latencyMs: performance.now() - started,
        usage: { inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens },
        attempts,
      };
    },
  };
}
