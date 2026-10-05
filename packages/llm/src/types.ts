export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** JSON Schema the reply must satisfy. Adapters use native structured output where the provider has it. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  /** Parsed JSON when jsonSchema was supplied and the reply parsed. */
  json?: unknown;
  model: string;
  /** Wall time of the whole call, retries included. */
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Set when the provider reports a price (claude-cli does); otherwise derive it from usage. */
  costUsd?: number;
  /** Attempts made, 1 when the first try succeeded. */
  attempts?: number;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
