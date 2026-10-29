import { createAnthropicClient } from "./anthropic.js";
import { createClaudeCliClient } from "./claude-cli.js";
import { createFallbackClient } from "./fallback.js";
import { createMockClient } from "./mock.js";
import { createOpenAiCompatClient, OPENAI_COMPAT_PRESETS, type JsonMode, type ReasoningEffort } from "./openai-compat.js";
import type { LlmClient } from "./types.js";

export type Env = Record<string, string | undefined>;

export const LLM_PROVIDERS = ["anthropic", "openai", "groq", "gemini", "nebius", "openai-compat", "claude-cli", "mock"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export interface FactoryExtras {
  fetchImpl?: typeof fetch;
}

const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

function required(env: Env, key: string, provider: string): string {
  const value = env[key];
  if (!value) throw new Error(`LLM_PROVIDER=${provider} needs ${key} in the environment`);
  return value;
}

/**
 * Build the configured client from env:
 * LLM_PROVIDER (default mock), LLM_MODEL, LLM_TIMEOUT_MS, LLM_RETRIES, plus the provider's key.
 * openai-compat additionally takes LLM_BASE_URL, LLM_API_KEY and LLM_JSON_MODE. The openai, groq, gemini and
 * nebius presets also take LLM_REASONING_EFFORT and LLM_FALLBACK_MODELS (comma list; empty turns fallback off).
 */
export function createLlmClient(env: Env = process.env, extras: FactoryExtras = {}): LlmClient {
  const provider = (env.LLM_PROVIDER || "mock").trim().toLowerCase();
  const model = env.LLM_MODEL || undefined;
  const timeoutMs = num(env.LLM_TIMEOUT_MS);
  const retries = num(env.LLM_RETRIES);
  const http = {
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(retries !== undefined && { retries }),
    ...(extras.fetchImpl && { fetchImpl: extras.fetchImpl }),
  };

  switch (provider) {
    case "anthropic":
      return createAnthropicClient({
        apiKey: required(env, "ANTHROPIC_API_KEY", provider),
        model: model ?? env.ANTHROPIC_MODEL,
        baseUrl: env.ANTHROPIC_BASE_URL,
        ...http,
      });
    case "openai":
    case "groq":
    case "gemini":
    case "nebius": {
      const preset = OPENAI_COMPAT_PRESETS[provider];
      const apiKey = required(env, preset.keyEnv, provider);
      const primary = model ?? preset.model;
      const fallbacks = (env.LLM_FALLBACK_MODELS !== undefined ? list(env.LLM_FALLBACK_MODELS) : (preset.fallbackModels ?? [])).filter((m) => m !== primary);
      const effort = ((env.LLM_REASONING_EFFORT || undefined) as ReasoningEffort | undefined) ?? preset.reasoningEffort;
      // With somewhere to fall over to, a 429 should move on at once rather than back off and retry.
      const chainHttp = fallbacks.length && retries === undefined ? { ...http, retries: 0 } : http;
      const clients = [primary, ...fallbacks].map((m) =>
        createOpenAiCompatClient({
          provider,
          apiKey,
          baseUrl: env.LLM_BASE_URL || preset.baseUrl,
          model: m,
          jsonMode: (env.LLM_JSON_MODE as JsonMode | undefined) ?? preset.jsonMode,
          maxTokensField: preset.maxTokensField,
          ...(effort && m.includes("gpt-oss") ? { reasoningEffort: effort } : {}),
          ...(preset.extraBody && { extraBody: preset.extraBody }),
          ...chainHttp,
        }),
      );
      return createFallbackClient(clients);
    }
    case "openai-compat":
      return createOpenAiCompatClient({
        provider,
        apiKey: required(env, "LLM_API_KEY", provider),
        baseUrl: required(env, "LLM_BASE_URL", provider),
        model: model ?? required(env, "LLM_MODEL", provider),
        jsonMode: (env.LLM_JSON_MODE as JsonMode | undefined) ?? "json_object",
        ...http,
      });
    case "claude-cli":
      return createClaudeCliClient({
        model: model ?? "haiku",
        bin: env.CLAUDE_BIN,
        thinking: env.CLAUDE_THINKING === "1",
        ...(timeoutMs !== undefined && { timeoutMs }),
        ...(retries !== undefined && { retries }),
      });
    case "mock":
      return createMockClient({ model: model ?? "mock-1" });
    default:
      throw new Error(`Unknown LLM_PROVIDER "${provider}"; expected one of ${LLM_PROVIDERS.join(", ")}`);
  }
}

/**
 * The larger reasoning model behind the fast one: LLM_ESCALATE_MODEL, else the preset's escalateModel
 * (nebius: Nemotron Super behind Nemotron Nano). Undefined when neither is set, or LLM_ESCALATE_MODEL is empty.
 */
export function createEscalationClient(env: Env = process.env, extras: FactoryExtras = {}): LlmClient | undefined {
  const provider = (env.LLM_PROVIDER || "mock").trim().toLowerCase();
  if (provider !== "openai" && provider !== "groq" && provider !== "gemini" && provider !== "nebius") return undefined;
  const preset = OPENAI_COMPAT_PRESETS[provider];
  const model = env.LLM_ESCALATE_MODEL !== undefined ? env.LLM_ESCALATE_MODEL.trim() : preset.escalateModel;
  if (!model) return undefined;
  const timeoutMs = num(env.LLM_ESCALATE_TIMEOUT_MS) ?? num(env.LLM_TIMEOUT_MS);
  const retries = num(env.LLM_RETRIES);
  return createOpenAiCompatClient({
    provider,
    apiKey: required(env, preset.keyEnv, provider),
    baseUrl: env.LLM_BASE_URL || preset.baseUrl,
    model,
    jsonMode: (env.LLM_JSON_MODE as JsonMode | undefined) ?? preset.jsonMode,
    maxTokensField: preset.maxTokensField,
    ...(preset.extraBody && { extraBody: preset.extraBody }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(retries !== undefined && { retries }),
    ...(extras.fetchImpl && { fetchImpl: extras.fetchImpl }),
  });
}
