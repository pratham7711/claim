import { describe, expect, it } from "vitest";
import { createAnthropicClient } from "./anthropic.js";
import { buildCliArgs, createClaudeCliClient } from "./claude-cli.js";
import { createTokenBudget, withTokenBudget } from "./budget.js";
import { createEscalationClient, createLlmClient } from "./factory.js";
import { createFallbackClient } from "./fallback.js";
import { backoffMs, LlmError, postJson, retryAfterMs } from "./http.js";
import { parseJsonLoose } from "./json.js";
import { createMockClient } from "./mock.js";
import { buildChatBody, createOpenAiCompatClient } from "./openai-compat.js";
import type { CompletionRequest, CompletionResult, LlmClient } from "./types.js";

const schema = { name: "r", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
const req: CompletionRequest = {
  messages: [
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
  ],
  jsonSchema: schema,
};

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) => new Response("err", { status: code, headers });
const noSleep = async () => {};

describe("nebius preset", () => {
  it("runs Nemotron Nano on Token Factory with Super as the escalation model", async () => {
    const f = fakeFetch([ok({ model: "m", choices: [{ message: { content: '{"ok":true}' } }] })]);
    const c = createLlmClient({ LLM_PROVIDER: "nebius", NEBIUS_API_KEY: "k", LLM_FALLBACK_MODELS: "" }, { fetchImpl: f.impl });
    expect(c.provider).toBe("nebius");
    expect(c.model).toMatch(/nemotron.*nano/i);
    expect((await c.complete(req)).json).toEqual({ ok: true });
    expect(f.calls[0]!.url).toBe("https://api.tokenfactory.nebius.com/v1/chat/completions");
    expect(createEscalationClient({ LLM_PROVIDER: "nebius", NEBIUS_API_KEY: "k" })!.model).toMatch(/nemotron.*super/i);
  });

  it("needs NEBIUS_API_KEY", () => {
    expect(() => createLlmClient({ LLM_PROVIDER: "nebius" })).toThrow(/NEBIUS_API_KEY/);
  });

  it("lets LLM_ESCALATE_MODEL pick or switch off the escalation model", () => {
    expect(createEscalationClient({ LLM_PROVIDER: "nebius", NEBIUS_API_KEY: "k", LLM_ESCALATE_MODEL: "x/y" })!.model).toBe("x/y");
    expect(createEscalationClient({ LLM_PROVIDER: "nebius", NEBIUS_API_KEY: "k", LLM_ESCALATE_MODEL: "" })).toBeUndefined();
    expect(createEscalationClient({ LLM_PROVIDER: "groq", GROQ_API_KEY: "k" })).toBeUndefined();
    expect(createEscalationClient({ LLM_PROVIDER: "mock" })).toBeUndefined();
  });
});

describe("createLlmClient", () => {
  it("defaults to mock", () => {
    const c = createLlmClient({});
    expect(c.provider).toBe("mock");
    expect(c.model).toBe("mock-1");
  });

  it("builds each provider from env with its default model", () => {
    expect(createLlmClient({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }).model).toBe("claude-haiku-4-5");
    expect(createLlmClient({ LLM_PROVIDER: "groq", GROQ_API_KEY: "k" }).provider).toBe("groq");
    expect(createLlmClient({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k" }).provider).toBe("gemini");
    expect(createLlmClient({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "k", LLM_MODEL: "gpt-x" }).model).toBe("gpt-x");
    expect(createLlmClient({ LLM_PROVIDER: "claude-cli" }).model).toBe("haiku");
    expect(createLlmClient({ LLM_PROVIDER: " Mock " }).provider).toBe("mock");
  });

  it("fails loudly on a missing key or unknown provider", () => {
    expect(() => createLlmClient({ LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createLlmClient({ LLM_PROVIDER: "groq" })).toThrow(/GROQ_API_KEY/);
    expect(() => createLlmClient({ LLM_PROVIDER: "openai-compat", LLM_API_KEY: "k" })).toThrow(/LLM_BASE_URL/);
    expect(() => createLlmClient({ LLM_PROVIDER: "bard" })).toThrow(/Unknown LLM_PROVIDER/);
  });

  it("passes the injected fetch and env base URL through", async () => {
    const f = fakeFetch([ok({ choices: [{ message: { content: '{"ok":true}' } }] })]);
    const c = createLlmClient({ LLM_PROVIDER: "groq", GROQ_API_KEY: "k", LLM_BASE_URL: "http://local/v1" }, { fetchImpl: f.impl });
    const res = await c.complete(req);
    expect(res.json).toEqual({ ok: true });
    expect(f.calls[0]?.url).toBe("http://local/v1/chat/completions");
    expect(JSON.parse(f.calls[0]?.init.body as string)).toMatchObject({ model: "openai/gpt-oss-20b", reasoning_effort: "low" });
  });

  it("treats an empty LLM_REASONING_EFFORT from a copied .env.example as unset", async () => {
    const f = fakeFetch([ok({ choices: [{ message: { content: '{"ok":true}' } }] })]);
    const c = createLlmClient({ LLM_PROVIDER: "groq", GROQ_API_KEY: "k", LLM_REASONING_EFFORT: "" }, { fetchImpl: f.impl });
    await c.complete(req);
    expect(JSON.parse(f.calls[0]?.init.body as string)).toMatchObject({ reasoning_effort: "low" });
  });
});

describe("fallback client", () => {
  const result = (model: string): CompletionResult => ({ text: "{}", model, latencyMs: 1 });
  function scripted(model: string, outcomes: (Error | "ok")[]) {
    let calls = 0;
    const client: LlmClient = {
      provider: "groq",
      model,
      async complete() {
        const next = outcomes[Math.min(calls++, outcomes.length - 1)];
        if (next instanceof Error) throw next;
        return result(model);
      },
    };
    return { client, calls: () => calls };
  }
  const limited = (ms?: number) => new LlmError("HTTP 429", 429, true, ms);

  it("falls over on a 429 and benches that model until Retry-After passes", async () => {
    let t = 0;
    const a = scripted("a", [limited(5000), "ok"]);
    const b = scripted("b", ["ok"]);
    const c = createFallbackClient([a.client, b.client], { now: () => t });
    expect((await c.complete(req)).model).toBe("b");
    t = 4999;
    expect((await c.complete(req)).model).toBe("b");
    expect(a.calls()).toBe(1);
    t = 5001;
    expect((await c.complete(req)).model).toBe("a");
  });

  it("fails at once, without a request, when every model is benched", async () => {
    let t = 0;
    const a = scripted("a", [limited()]);
    const b = scripted("b", [limited(2000)]);
    const c = createFallbackClient([a.client, b.client], { now: () => t, defaultCooldownMs: 10_000 });
    await expect(c.complete(req)).rejects.toMatchObject({ status: 429 });
    t = 1000;
    await expect(c.complete(req)).rejects.toThrow(/all 2 models are rate-limited for another 1s/);
    expect([a.calls(), b.calls()]).toEqual([1, 1]);
  });

  it("does not try the next model on a non-retryable error", async () => {
    const a = scripted("a", [new LlmError("HTTP 400", 400, false)]);
    const b = scripted("b", ["ok"]);
    await expect(createFallbackClient([a.client, b.client]).complete(req)).rejects.toMatchObject({ status: 400 });
    expect(b.calls()).toBe(0);
  });

  it("groq chains gpt-oss-20b to qwen without retrying, and sends reasoning_effort only to gpt-oss", async () => {
    const reply = ok({ choices: [{ message: { content: '{"ok":true}' } }] });
    const f = fakeFetch([status(429, { "retry-after": "7" }), reply]);
    const res = await createLlmClient({ LLM_PROVIDER: "groq", GROQ_API_KEY: "k" }, { fetchImpl: f.impl }).complete(req);
    expect(res.json).toEqual({ ok: true });
    const bodies = f.calls.map((c) => JSON.parse(c.init.body as string));
    expect(bodies.map((b) => b.model)).toEqual(["openai/gpt-oss-20b", "qwen/qwen3.8-27b"]);
    expect(bodies[0].reasoning_effort).toBe("low");
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("LLM_FALLBACK_MODELS= turns the chain off", async () => {
    const f = fakeFetch([status(429)]);
    const c = createLlmClient({ LLM_PROVIDER: "groq", GROQ_API_KEY: "k", LLM_FALLBACK_MODELS: "", LLM_RETRIES: "0" }, { fetchImpl: f.impl });
    await expect(c.complete(req)).rejects.toMatchObject({ status: 429 });
    expect(f.calls).toHaveLength(1);
  });
});

describe("mock client", () => {
  it("replays scripted replies in order, then the fallback", async () => {
    const m = createMockClient({ replies: [{ ok: true }, "plain", (_r, n) => ({ call: n })], fallback: '{"done":1}' });
    expect((await m.complete(req)).json).toEqual({ ok: true });
    expect((await m.complete({ messages: [] })).text).toBe("plain");
    expect((await m.complete(req)).json).toEqual({ call: 2 });
    expect((await m.complete(req)).json).toEqual({ done: 1 });
    expect(m.calls).toHaveLength(4);
  });

  it("throws scripted errors and is deterministic", async () => {
    const m = createMockClient({ replies: [new LlmError("boom", 503, true)], latencyMs: 7 });
    await expect(m.complete(req)).rejects.toThrow("boom");
    const a = await createMockClient({ fallback: { x: 1 }, latencyMs: 7 }).complete(req);
    const b = await createMockClient({ fallback: { x: 1 }, latencyMs: 7 }).complete(req);
    expect(a).toEqual(b);
    expect(a.latencyMs).toBe(7);
  });
});

describe("postJson retries", () => {
  it("retries 429 and 5xx, then succeeds", async () => {
    const f = fakeFetch([status(429), status(503), ok({ v: 1 })]);
    const res = await postJson("http://x", {}, {}, { fetchImpl: f.impl, sleep: noSleep, retries: 3 });
    expect(res).toEqual({ json: { v: 1 }, attempts: 3 });
  });

  it("does not retry a 400", async () => {
    const f = fakeFetch([status(400), ok({})]);
    await expect(postJson("http://x", {}, {}, { fetchImpl: f.impl, sleep: noSleep })).rejects.toMatchObject({ status: 400 });
    expect(f.calls).toHaveLength(1);
  });

  it("gives up after the retry budget and honours Retry-After", async () => {
    const waits: number[] = [];
    const f = fakeFetch([status(429, { "retry-after": "1" }), status(500), status(500)]);
    const sleep = async (ms: number) => void waits.push(ms);
    await expect(postJson("http://x", {}, {}, { fetchImpl: f.impl, sleep, retries: 2 })).rejects.toMatchObject({ status: 500 });
    expect(waits[0]).toBe(1000);
    expect(waits).toHaveLength(2);
  });

  it("retries network errors", async () => {
    const f = fakeFetch([new TypeError("fetch failed"), ok({ v: 2 })]);
    expect((await postJson("http://x", {}, {}, { fetchImpl: f.impl, sleep: noSleep })).json).toEqual({ v: 2 });
  });

  it("times out a hung attempt", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    await expect(postJson("http://x", {}, {}, { fetchImpl: hang, timeoutMs: 20, retries: 0 })).rejects.toThrow(/timeout/);
  });

  it("computes backoff and Retry-After", () => {
    expect(backoffMs(0, 100, 1000, () => 0)).toBe(100);
    expect(backoffMs(3, 100, 1000, () => 0)).toBe(800);
    expect(backoffMs(9, 100, 1000, () => 0.9)).toBe(1000);
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs(null)).toBeUndefined();
  });
});

describe("anthropic adapter", () => {
  it("sends system separately with output_config json_schema and parses the reply", async () => {
    const f = fakeFetch([ok({ model: "claude-haiku-4-5", content: [{ type: "text", text: '{"ok":true}' }], usage: { input_tokens: 10, output_tokens: 3 } })]);
    const c = createAnthropicClient({ apiKey: "sk", fetchImpl: f.impl });
    const res = await c.complete(req);
    const body = JSON.parse(String(f.calls[0]?.init.body));
    expect(f.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect((f.calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBe("sk");
    expect(body.system).toBe("be terse");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.temperature).toBeUndefined();
    expect(res.json).toEqual({ ok: true });
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  it("treats a refusal as an error", async () => {
    const f = fakeFetch([ok({ stop_reason: "refusal", content: [] })]);
    await expect(createAnthropicClient({ apiKey: "k", fetchImpl: f.impl }).complete(req)).rejects.toThrow(/refusal/);
  });
});

describe("openai-compatible adapter", () => {
  const base = { apiKey: "k", baseUrl: "https://api.groq.com/openai/v1", model: "m" };
  it("uses strict json_schema when supported", () => {
    const body = buildChatBody({ ...req, maxTokens: 50 }, { ...base, jsonMode: "json_schema", maxTokensField: "max_completion_tokens" });
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "r", strict: true } });
    expect(body.max_completion_tokens).toBe(50);
  });

  it("falls back to JSON mode with the schema in a system message", () => {
    const body = buildChatBody(req, { ...base, jsonMode: "json_object" }) as { messages: { content: string }[]; response_format: unknown };
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages.at(-1)?.content).toContain("JSON Schema");
  });

  it("sends reasoning_effort only when set", () => {
    expect(buildChatBody(req, { ...base, reasoningEffort: "low" }).reasoning_effort).toBe("low");
    expect(buildChatBody(req, base)).not.toHaveProperty("reasoning_effort");
  });

  it("parses choices and usage", async () => {
    const f = fakeFetch([ok({ choices: [{ message: { content: '```json\n{"ok":false}\n```' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } })]);
    const res = await createOpenAiCompatClient({ ...base, fetchImpl: f.impl }).complete(req);
    expect((f.calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(res.json).toEqual({ ok: false });
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });
});

describe("claude-cli adapter", () => {
  const cliOut = (result: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "result", is_error: false, result, total_cost_usd: 0.001, usage: { input_tokens: 400, output_tokens: 20 }, modelUsage: { "claude-haiku-4-5-20251001": {} }, ...extra });

  it("builds an isolated, tool-less invocation", () => {
    const args = buildCliArgs("haiku", "sys");
    expect(args.slice(0, 5)).toEqual(["-p", "--model", "haiku", "--output-format", "json"]);
    expect(args).toContain("--safe-mode");
    expect(args[args.indexOf("--settings") + 1]).toBe('{"alwaysThinkingEnabled":false}');
    expect(args.at(-1)).toBe("sys");
    expect(buildCliArgs("haiku", "", true)).not.toContain("--settings");
  });

  it("puts the prompt on stdin and parses the fenced result", async () => {
    const seen: string[] = [];
    const c = createClaudeCliClient({
      run: async (_a, stdin) => {
        seen.push(stdin);
        return { code: 0, stdout: cliOut('```json\n{"ok":true}\n```'), stderr: "", timedOut: false };
      },
    });
    const res = await c.complete(req);
    expect(seen[0]).toContain("hi");
    expect(seen[0]).toContain("JSON Schema");
    expect(res.json).toEqual({ ok: true });
    expect(res.costUsd).toBe(0.001);
    expect(res.model).toBe("claude-haiku-4-5-20251001");
  });

  it("surfaces a timeout and retries a retryable API error", async () => {
    const timeout = createClaudeCliClient({ run: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
    await expect(timeout.complete(req)).rejects.toThrow(/timeout/);
    const outs = [cliOut("overloaded", { is_error: true, api_error_status: 529 }), cliOut('{"ok":true}')];
    const flaky = createClaudeCliClient({ run: async () => ({ code: 0, stdout: outs.shift()!, stderr: "", timedOut: false }) });
    const res = await flaky.complete(req);
    expect(res.attempts).toBe(2);
  });
});

describe("parseJsonLoose", () => {
  it("handles plain, fenced and embedded JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('Sure:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonLoose('Here you go {"a":3} thanks')).toEqual({ a: 3 });
    expect(parseJsonLoose("nope")).toBeUndefined();
  });
});

describe("withTokenBudget", () => {
  const reply = (inputTokens: number, outputTokens: number): CompletionResult => ({ text: "{}", json: {}, model: "m", latencyMs: 1, usage: { inputTokens, outputTokens }, attempts: 1 });
  const client = (n: { calls: number }, usage = reply(100, 50)): LlmClient => ({
    provider: "nebius",
    model: "m",
    async complete() {
      n.calls++;
      return usage;
    },
  });

  it("counts real usage and stops calling the provider once the allowance is spent", async () => {
    const n = { calls: 0 };
    const budget = createTokenBudget({}, { maxTokens: 400 });
    const c = withTokenBudget(client(n), budget);
    await c.complete({ ...req, maxTokens: 10 });
    expect(budget.used).toBe(150);
    await c.complete({ ...req, maxTokens: 10 });
    await c.complete({ ...req, maxTokens: 10 });
    await expect(c.complete({ ...req, maxTokens: 10 })).rejects.toThrow(/budget spent/);
    expect(n.calls).toBe(3);
  });

  it("shares one allowance between clients and honours LLM_TOKEN_BUDGET", async () => {
    const budget = createTokenBudget({ LLM_TOKEN_BUDGET: "200" }, { maxTokens: 1_000_000 });
    const n = { calls: 0 };
    await withTokenBudget(client(n), budget).complete({ ...req, maxTokens: 10 });
    await withTokenBudget(client(n), budget).complete({ ...req, maxTokens: 10 });
    await expect(withTokenBudget(client(n), budget).complete({ ...req, maxTokens: 10 })).rejects.toThrow(/budget spent/);
    expect(n.calls).toBe(2);
  });

  it("makes no calls on or after LLM_DISABLE_AFTER, and keeps the reservation of a failed call", async () => {
    const budget = createTokenBudget({ LLM_DISABLE_AFTER: "2026-11-27T00:00:00Z" }, { maxTokens: 1_000_000 });
    const n = { calls: 0 };
    const late = withTokenBudget(client(n), budget, () => Date.parse("2026-11-27T00:00:00Z"));
    await expect(late.complete(req)).rejects.toThrow(/LLM_DISABLE_AFTER/);
    expect(n.calls).toBe(0);
    const failing: LlmClient = { provider: "nebius", model: "m", complete: async () => { throw new Error("timeout"); } };
    const b2 = createTokenBudget({}, { maxTokens: 1_000_000 });
    await expect(withTokenBudget(failing, b2).complete({ ...req, maxTokens: 100 })).rejects.toThrow("timeout");
    expect(b2.used).toBeGreaterThan(100);
  });
});
