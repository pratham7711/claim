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

/** A function the model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** The arguments as the model wrote them, JSON text; the caller parses and checks them. */
  arguments: string;
}

export type ToolChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolChatRequest {
  messages: ToolChatMessage[];
  tools: ToolSpec[];
  /** Defaults to "auto": the model may answer in text instead. */
  toolChoice?: "auto" | "none" | "required";
  /** Defaults to true: several calls in one turn. */
  parallelToolCalls?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ToolChatResult {
  text: string;
  toolCalls: ToolCall[];
  model: string;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  attempts?: number;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** Tool calling. Only the OpenAI-compatible adapters and the mock have it. */
  chat?(req: ToolChatRequest): Promise<ToolChatResult>;
}
