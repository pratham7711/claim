import { spawn } from "node:child_process";
import { backoffMs, isRetryableStatus, LlmError, sleep } from "./http.js";
import { parseJsonLoose, schemaInstruction, splitSystem } from "./json.js";
import type { CompletionRequest, CompletionResult, LlmClient } from "./types.js";

export interface ClaudeCliOptions {
  model?: string;
  bin?: string;
  /** Hard wall-clock limit per spawn; the child is SIGKILLed when it passes. */
  timeoutMs?: number;
  retries?: number;
  /** Extended thinking is on by default in the CLI; it multiplied output tokens ~10x for no gain here. Default false. */
  thinking?: boolean;
  /** Injected in tests. */
  run?: (args: string[], stdin: string, timeoutMs: number, signal?: AbortSignal, env?: Record<string, string>) => Promise<RunResult>;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface CliResult {
  result?: string;
  is_error?: boolean;
  api_error_status?: number | null;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

// A nested `claude` refuses to start, or inherits the parent session, when these leak through.
const STRIP_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

function runProcess(bin: string) {
  return (args: string[], stdin: string, timeoutMs: number, signal?: AbortSignal, extraEnv: Record<string, string> = {}) =>
    new Promise<RunResult>((resolve, reject) => {
      const env = { ...process.env, ...extraEnv };
      for (const key of STRIP_ENV) delete env[key];
      const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const kill = () => child.kill("SIGKILL");
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      signal?.addEventListener("abort", kill, { once: true });
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new LlmError(`claude-cli spawn failed: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        resolve({ code, stdout, stderr, timedOut });
      });
      child.stdin.end(stdin);
    });
}

export function buildCliArgs(model: string, system: string, thinking = false): string[] {
  // --safe-mode drops CLAUDE.md, hooks, MCP and skills; --tools "" makes it a plain completion.
  const args = ["-p", "--model", model, "--output-format", "json", "--safe-mode", "--tools", "", "--no-session-persistence", "--strict-mcp-config"];
  if (!thinking) args.push("--settings", JSON.stringify({ alwaysThinkingEnabled: false }));
  if (system) args.push("--system-prompt", system);
  return args;
}

export function buildCliPrompt(req: CompletionRequest): { system: string; prompt: string } {
  const { system, rest } = splitSystem(req.messages);
  const turns = rest.length === 1 ? (rest[0]?.content ?? "") : rest.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  const prompt = req.jsonSchema ? `${turns}\n\n${schemaInstruction(req.jsonSchema.schema)}` : turns;
  return { system, prompt };
}

/** Dev adapter: shells out to `claude -p --model haiku --output-format json` using the local login. */
export function createClaudeCliClient(opts: ClaudeCliOptions = {}): LlmClient {
  const model = opts.model || "haiku";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const retries = opts.retries ?? 1;
  const run = opts.run ?? runProcess(opts.bin ?? "claude");

  return {
    provider: "claude-cli",
    model,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const { system, prompt } = buildCliPrompt(req);
      const args = buildCliArgs(model, system, opts.thinking);
      const env: Record<string, string> = opts.thinking ? {} : { MAX_THINKING_TOKENS: "0" };
      const started = performance.now();
      let lastError: LlmError | undefined;

      for (let attempt = 0; attempt <= retries; attempt++) {
        const out = await run(args, prompt, timeoutMs, req.signal, env);
        if (out.timedOut) throw new LlmError(`claude-cli timeout after ${timeoutMs}ms`, undefined, true);
        if (req.signal?.aborted) throw req.signal.reason;
        const parsed = parseJsonLoose(out.stdout) as CliResult | undefined;
        if (parsed && !parsed.is_error && typeof parsed.result === "string") {
          const usage = parsed.usage ?? {};
          return {
            text: parsed.result,
            json: req.jsonSchema ? parseJsonLoose(parsed.result) : undefined,
            model: Object.keys(parsed.modelUsage ?? {})[0] ?? model,
            latencyMs: performance.now() - started,
            usage: {
              inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
              outputTokens: usage.output_tokens,
            },
            costUsd: parsed.total_cost_usd,
            attempts: attempt + 1,
          };
        }
        const status = parsed?.api_error_status ?? undefined;
        const retryable = status === undefined ? out.code !== 0 : isRetryableStatus(status);
        lastError = new LlmError(
          `claude-cli failed (exit ${out.code}${status ? `, api ${status}` : ""}): ${(parsed?.result ?? out.stderr ?? out.stdout).slice(0, 300)}`,
          status,
          retryable,
        );
        if (!retryable || attempt === retries) break;
        await sleep(backoffMs(attempt, 500, 4000), req.signal);
      }
      throw lastError ?? new LlmError("claude-cli failed");
    },
  };
}
