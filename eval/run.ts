/**
 * npm run eval [-- --llm claude-cli] [--sets synthetic,real,dev-real2,dev-real2-claims,dev-real3] [--skip llm-only,mock]
 *                 [--budget 120] [--batch 20] [--latency-sample 12] [--no-cache]
 *
 * Scores the resolver on the dev sets (default; all were read while writing the rules) or on a
 * held-out set (--sets heldout-v3, scored once): a naive regex bot, the rule stage alone, rules + mock
 * LLM, and, with --llm, rules + that LLM and the LLM alone. --skip drops configs to save LLM calls.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ResolverContext } from "@claim/core";
import { createLlmClient, createMockClient, type CompletionResult, type LlmClient } from "@claim/llm";
import { resolveBatch, ruleResolve, type ResolvedIntent, type ResolveMode } from "@claim/resolver";
import { DEV_SETS, loadSets, type Dataset, type Example } from "./lib/data.js";
import { withBudget, withCache, withRateLimitWait, type CallLog } from "./lib/llm-wrappers.js";
import { pct, score, type Metrics, type Scored } from "./lib/metrics.js";

const { values: args } = parseArgs({
  options: {
    llm: { type: "string" },
    budget: { type: "string", default: "120" },
    batch: { type: "string", default: "20" },
    "llm-batch": { type: "string", default: "50" },
    "latency-sample": { type: "string", default: "12" },
    concurrency: { type: "string", default: "3" },
    "no-cache": { type: "boolean", default: false },
    sets: { type: "string", default: DEV_SETS.join(",") },
    skip: { type: "string", default: "" },
  },
});

const ROOT = import.meta.dirname;
const HAIKU_IN = 1 / 1e6; // USD per token, Claude Haiku 4.5 list price
const HAIKU_OUT = 5 / 1e6;

interface ConfigResult {
  dataset: string;
  role: string;
  config: string;
  metrics: Metrics;
  llmCalls: number;
  costUsd: number;
  apiCostUsd: number;
  rows: Scored[];
}

/** The bot most sellers start with: "sold N" grants item N, everything else is ignored. */
function naive(ex: Example, ctx: ResolverContext): ResolvedIntent[] {
  const m = /\bsold\s*#?\s*(\d+)/i.exec(ex.text);
  const code = m?.[1];
  if (code && ctx.items.some((i) => i.code === code)) return [{ commentId: ex.id, kind: "claim", itemCode: code, confidence: 1, method: "rule" }];
  return [{ commentId: ex.id, kind: code ? "question" : "other", confidence: 1, method: "rule" }];
}

function ruleLatencies(ds: Dataset): Map<string, number> {
  const out = new Map<string, number>();
  for (const ex of ds.examples) {
    const ctx = ds.ctxOf(ex);
    ruleResolve(ex.text, ctx); // warm
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) ruleResolve(ex.text, ctx);
    out.set(ex.id, (performance.now() - t0) / 20);
  }
  return out;
}

async function runResolver(ds: Dataset, config: string, ruleMs: Map<string, number>, opts: { llm?: LlmClient; mode: ResolveMode; batchSize: number; concurrency: number }): Promise<ConfigResult> {
  const byShow = new Map<string, Example[]>();
  for (const ex of ds.examples) byShow.set(ex.show, [...(byShow.get(ex.show) ?? []), ex]);
  const rows: Scored[] = [];
  let llmCalls = 0;
  let costUsd = 0;
  let apiCostUsd = 0;
  const account = (c: CompletionResult) => {
    llmCalls++;
    costUsd += c.costUsd ?? 0;
    if (opts.llm?.provider !== "mock") apiCostUsd += (c.usage?.inputTokens ?? 0) * HAIKU_IN + (c.usage?.outputTokens ?? 0) * HAIKU_OUT;
  };
  // Shows run one after another; inside a show the resolver batches and parallelises its own calls.
  for (const examples of byShow.values()) {
    const callMs = new Map<number, number>();
    const preds = await resolveBatch(
      examples.map((ex) => ({ id: ex.id, text: ex.text })),
      (_c, i) => ds.ctxOf(examples[i]!),
      {
        ...opts,
        llmTimeoutMs: 120_000,
        onLlmCall: ({ indices, completion, error }) => {
          if (completion) account(completion);
          if (error) console.error(`  ${config}: LLM call failed: ${String((error as Error).message ?? error).slice(0, 160)}`);
          for (const i of indices) callMs.set(i, completion?.latencyMs ?? 0);
        },
      },
    );
    const abstained = [...callMs.keys()].filter((i) => preds[i]!.every((p) => p.method === "rule")).length;
    if (opts.llm && opts.llm.provider !== "mock" && abstained) console.error(`  ${config}: ${abstained} routed comments got no usable LLM answer`);
    examples.forEach((ex, i) => {
      const viaLlm = callMs.has(i);
      rows.push({ ex, pred: preds[i]!, latencyMs: (ruleMs.get(ex.id) ?? 0) + (callMs.get(i) ?? 0), viaLlm });
    });
  }
  return { dataset: ds.name, role: ds.label, config, metrics: score(rows), llmCalls, costUsd, apiCostUsd, rows };
}

const f3 = (x: number) => x.toFixed(3);
const ms = (x: number) => (x < 10 ? x.toFixed(2) : Math.round(x).toString());
const usd = (x: number) => (x === 0 ? "0" : `$${x.toFixed(x < 0.1 ? 4 : 2)}`);

function table(results: ConfigResult[]): string {
  const head =
    "| set | role | config | n | kind acc | item P | item R | variant acc | grants | grant precision (target 0.95) | harmful grants | grant recall | harmful rate | LLM calls | routed to LLM | p50 ms | p95 ms | p95 ms (LLM-routed) | $/1k comments (CLI-reported) | $/1k (Haiku API list) |";
  const sep = `|${head.split("|").slice(1, -1).map(() => "---").join("|")}|`;
  const lines = results.map((r) => {
    const m = r.metrics;
    const per1k = (x: number) => usd((x / m.n) * 1000);
    const meets = m.grantPrecision >= 0.95 ? "yes" : "NO";
    return `| ${r.dataset} | ${r.role} | ${r.config} | ${m.n} | ${f3(m.kindAcc)} | ${f3(m.itemP)} | ${f3(m.itemR)} | ${f3(m.variantAcc)} (${m.variantN}) | ${m.grants} | ${f3(m.grantPrecision)} ${meets} | ${m.harmful} | ${f3(m.grantRecall)} (${m.grantableN}) | ${f3(m.harmfulRate)} | ${r.llmCalls} | ${m.llmRouted} | ${ms(m.p50)} | ${ms(m.p95)} | ${m.llmRouted ? ms(m.llmP95) : "-"} | ${per1k(r.costUsd)} | ${per1k(r.apiCostUsd)} |`;
  });
  return [head, sep, ...lines].join("\n");
}

/** Grant precision by confidence band: where the harmful grants sit relative to the 0.8 auto-accept line. */
function bucketTable(results: ConfigResult[]): string {
  const labels = results[0]?.metrics.buckets.map((b) => b.label) ?? [];
  const head = `| set | config | ${labels.map((l) => `${l} precision (grants)`).join(" | ")} |`;
  const sep = `|${head.split("|").slice(1, -1).map(() => "---").join("|")}|`;
  const cell = (b: { grants: number; harmful: number }) => (b.grants ? `${f3((b.grants - b.harmful) / b.grants)} (${b.grants}, ${b.harmful} harmful)` : "- (0)");
  const lines = results.filter((r) => r.config !== "naive regex (sold N)").map((r) => `| ${r.dataset} | ${r.config} | ${r.metrics.buckets.map(cell).join(" | ")} |`);
  return [head, sep, ...lines].join("\n");
}

async function latencySample(datasets: Dataset[], llm: LlmClient, k: number): Promise<number[]> {
  const picks: { ex: Example; ctx: ResolverContext }[] = [];
  for (const ds of datasets) {
    for (const ex of ds.examples) {
      const ctx = ds.ctxOf(ex);
      if (ruleResolve(ex.text, ctx).needsLlm) picks.push({ ex, ctx });
    }
  }
  const step = Math.max(1, Math.floor(picks.length / k));
  const chosen = picks.filter((_, i) => i % step === 0).slice(0, k);
  const out: number[] = [];
  for (const { ex, ctx } of chosen) {
    await resolveBatch([{ id: ex.id, text: ex.text }], ctx, {
      llm,
      mode: "llm",
      llmTimeoutMs: 60_000,
      onLlmCall: ({ completion }) => completion && out.push(completion.latencyMs),
    });
  }
  return out;
}

async function main() {
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const datasets = loadSets(list(args.sets));
  const skip = new Set(list(args.skip));
  const batchSize = Number(args.batch);
  const concurrency = Number(args.concurrency);
  const results: ConfigResult[] = [];
  const log: CallLog = { calls: 0, cacheHits: 0, refused: 0, rateLimitWaits: 0 };
  const provider = args.llm ?? (process.env.LLM_PROVIDER && process.env.LLM_PROVIDER !== "mock" ? process.env.LLM_PROVIDER : undefined);
  let llm: LlmClient | undefined;
  if (provider) {
    const base = createLlmClient({ ...process.env, LLM_PROVIDER: provider, LLM_TIMEOUT_MS: process.env.LLM_TIMEOUT_MS ?? "120000" });
    const budgeted = withBudget(withRateLimitWait(base, log), Number(args.budget), log);
    llm = args["no-cache"] ? budgeted : withCache(budgeted, join(ROOT, ".cache"), log);
  }

  for (const ds of datasets) {
    console.log(`\n${ds.name}: ${ds.examples.length} comments`);
    const ruleMs = ruleLatencies(ds);
    const naiveRows: Scored[] = ds.examples.map((ex) => ({ ex, pred: naive(ex, ds.ctxOf(ex)), latencyMs: 0.001, viaLlm: false }));
    results.push({ dataset: ds.name, role: ds.label, config: "naive regex (sold N)", metrics: score(naiveRows), llmCalls: 0, costUsd: 0, apiCostUsd: 0, rows: naiveRows });
    results.push(await runResolver(ds, "rules only", ruleMs, { mode: "rules", batchSize, concurrency }));
    if (!skip.has("mock")) results.push(await runResolver(ds, "rules + mock LLM (abstains)", ruleMs, { llm: createMockClient(), mode: "auto", batchSize, concurrency }));
    if (llm) {
      console.log(`  rules + ${provider} ...`);
      results.push(await runResolver(ds, `rules + ${provider}`, ruleMs, { llm, mode: "auto", batchSize, concurrency }));
      if (!skip.has("llm-only")) {
        console.log(`  ${provider} only ...`);
        results.push(await runResolver(ds, `${provider} only`, ruleMs, { llm, mode: "llm", batchSize: Number(args["llm-batch"]), concurrency }));
      }
    }
  }

  let latencyNote = "";
  if (llm && Number(args["latency-sample"]) > 0) {
    console.log(`\nsingle-comment latency sample (${args["latency-sample"]} calls) ...`);
    const lat = await latencySample(datasets, llm, Number(args["latency-sample"]));
    latencyNote = `Single-comment ${provider} calls (batch of 1, n=${lat.length}): p50 ${ms(pct(lat, 50))} ms, p95 ${ms(pct(lat, 95))} ms.`;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const md = [
    `# Resolver eval ${stamp}`,
    "",
    table(results),
    "",
    "Grant precision by confidence:",
    "",
    bucketTable(results),
    "",
    latencyNote,
    provider ? `LLM calls made this run: ${log.calls} (budget ${args.budget}), replayed from cache: ${log.cacheHits}, refused by budget: ${log.refused}, rate-limit waits: ${log.rateLimitWaits}.` : "No real LLM configured (pass --llm claude-cli).",
    "",
    "Definitions:",
    "- kind acc: first intent's kind equals the label. A labelled claim that cannot be placed on a catalogue code counts as correct when nothing is granted.",
    "- item P/R: item codes over claim/change/waitlist intents vs the labelled codes.",
    "- variant acc: among labelled items with a size or colour whose code was predicted, size and colour both match (n in brackets).",
    "- grant: a claim or change with an item code and confidence >= 0.8, i.e. what the engine would hold without the seller. Harmful grant: the comment was not a claim/change, or the granted item is not one the viewer named. Grant precision = 1 - harmful/grants. Harmful rate is per comment.",
    "- grant recall: labelled claims/changes that name a catalogue item and received a correct grant, over all such labels (n in brackets). Everything else lands in the seller's review lane.",
    "- role: dev sets were read while writing the rules, so their numbers are in-sample; a held-out set is scored once and never tuned on.",
    "- latency: rule time per comment, plus the full LLM call time for comments routed to the LLM (batched calls; the comment waits for its batch).",
    "- $/1k comments: total LLM spend divided by all comments in the set (rule-settled comments cost nothing). CLI-reported is claude-cli's own total_cost_usd; Haiku API list is tokens x $1/M in, $5/M out.",
  ].join("\n");

  const dir = join(ROOT, "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp}.md`), md);
  writeFileSync(join(dir, "latest.md"), md);
  const preds = results
    .filter((r) => r.config !== "naive regex (sold N)")
    .flatMap((r) => r.rows.map((row) => JSON.stringify({ set: r.dataset, config: r.config, id: row.ex.id, text: row.ex.text, gold: row.ex.gold, pred: row.pred, viaLlm: row.viaLlm })));
  writeFileSync(join(dir, `${stamp}-predictions.jsonl`), preds.join("\n") + "\n");
  console.log(`\n${md}\n\nwrote eval/results/${stamp}.md and latest.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
