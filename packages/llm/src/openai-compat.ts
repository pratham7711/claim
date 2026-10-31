import { postJson, type RetryOptions } from "./http.js";
import { parseJsonLoose, schemaInstruction } from "./json.js";
import type { ChatMessage, CompletionRequest, CompletionResult, LlmClient, ToolCall, ToolChatMessage, ToolChatRequest, ToolChatResult } from "./types.js";

/** json_schema = native strict structured output; json_object = JSON mode with the schema in the prompt. */
export type JsonMode = "json_schema" | "json_object" | "none";
export type ReasoningEffort = "low" | "medium" | "high";

export interface OpenAiCompatOptions extends Omit<RetryOptions, "signal"> {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider?: string;
  jsonMode?: JsonMode;
  /** OpenAI's newer models only take max_completion_tokens; Groq and Gemini take max_tokens. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Reasoning models (gpt-oss) think before answering; "low" keeps a comment batch inside the latency budget. */
  reasoningEffort?: ReasoningEffort;
  /** Provider-specific fields merged into the request body. */
  extraBody?: Record<string, unknown>;
}

export interface OpenAiPreset {
  baseUrl: string;
  keyEnv: string;
  model: string;
  jsonMode: JsonMode;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  /** Sent only to gpt-oss models; other reasoning models (qwen3) start thinking when they get it. */
  reasoningEffort?: ReasoningEffort;
  /** Tried in order when the model ahead is rate-limited. Groq's free tier limits each model separately. */
  fallbackModels?: string[];
  /** A larger reasoning model for the comments the fast model cannot settle, and for listings. */
  escalateModel?: string;
  /** Provider-specific request fields. Nemotron 3 reasons by default; its chat template takes enable_thinking. */
  extraBody?: Record<string, unknown>;
}

/** Default models are starting points; set LLM_MODEL to pin one. */
export const OPENAI_COMPAT_PRESETS: Record<"openai" | "groq" | "gemini" | "nebius", OpenAiPreset> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    model: "gpt-4.1-mini",
    jsonMode: "json_schema",
    maxTokensField: "max_completion_tokens",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    model: "openai/gpt-oss-20b",
    jsonMode: "json_object",
    maxTokensField: "max_tokens",
    reasoningEffort: "low",
    fallbackModels: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"],
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    model: "gemini-2.5-flash-lite",
    jsonMode: "json_schema",
    maxTokensField: "max_tokens",
  },
  nebius: {
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    keyEnv: "NEBIUS_API_KEY",
    model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    jsonMode: "json_schema",
    maxTokensField: "max_tokens",
    escalateModel: "nvidia/nemotron-3-super-120b-a12b",
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  },
};

interface WireToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null; tool_calls?: WireToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toWire(m: ToolChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant") {
    // Some providers refuse an empty tool_calls array, and want null content beside calls.
    const calls = m.toolCalls?.length ? m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) : undefined;
    return { role: "assistant", content: m.content || (calls ? null : ""), ...(calls ? { tool_calls: calls } : {}) };
  }
  return { role: m.role, content: m.content };
}

export function buildToolChatBody(req: ToolChatRequest, opts: OpenAiCompatOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: req.messages.map(toWire),
    tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_choice: req.toolChoice ?? "auto",
    parallel_tool_calls: req.parallelToolCalls ?? true,
  };
  if (req.maxTokens !== undefined) body[opts.maxTokensField ?? "max_tokens"] = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  return { ...body, ...opts.extraBody };
}

function toolCallsFrom(calls: WireToolCall[] | undefined): ToolCall[] {
  return (calls ?? []).flatMap((c, i) => {
    const name = c.function?.name;
    if (!name) return [];
    const args = c.function?.arguments;
    return [{ id: c.id || `call_${i}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) }];
  });
}

export function buildChatBody(req: CompletionRequest, opts: OpenAiCompatOptions): Record<string, unknown> {
  const mode = req.jsonSchema ? (opts.jsonMode ?? "json_schema") : "none";
  let messages: ChatMessage[] = req.messages;
  const body: Record<string, unknown> = { model: opts.model };
  if (req.jsonSchema && mode === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true },
    };
  } else if (req.jsonSchema) {
    // JSON mode (and no-mode) providers need the schema spelled out, and OpenAI's JSON mode needs the word "JSON".
    messages = [...messages, { role: "system", content: schemaInstruction(req.jsonSchema.schema) }];
    if (mode === "json_object") body.response_format = { type: "json_object" };
  }
  body.messages = messages.map((m) => ({ role: m.role, content: m.content }));
  if (req.maxTokens !== undefined) body[opts.maxTokensField ?? "max_tokens"] = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  return { ...body, ...opts.extraBody };
}

/** One adapter for OpenAI, Groq, Gemini and Nebius Token Factory's OpenAI-compatible endpoints. */
export function createOpenAiCompatClient(opts: OpenAiCompatOptions): LlmClient {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = { authorization: `Bearer ${opts.apiKey}` };
  return {
    provider: opts.provider ?? "openai-compat",
    model: opts.model,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const started = performance.now();
      const { json, attempts } = await postJson(url, buildChatBody(req, opts), headers, { ...opts, signal: req.signal });
      const res = json as ChatResponse;
      const text = res.choices?.[0]?.message?.content ?? "";
      return {
        text,
        json: req.jsonSchema ? parseJsonLoose(text) : undefined,
        model: res.model ?? opts.model,
        latencyMs: performance.now() - started,
        usage: { inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens },
        attempts,
      };
    },
    async chat(req: ToolChatRequest): Promise<ToolChatResult> {
      const started = performance.now();
      const { json, attempts } = await postJson(url, buildToolChatBody(req, opts), headers, { ...opts, signal: req.signal });
      const res = json as ChatResponse;
      const message = res.choices?.[0]?.message;
      return {
        text: message?.content ?? "",
        toolCalls: toolCallsFrom(message?.tool_calls),
        model: res.model ?? opts.model,
        latencyMs: performance.now() - started,
        usage: { inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens },
        attempts,
      };
    },
  };
}
