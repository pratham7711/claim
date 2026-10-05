import type { ChatComment, ClaimIntent, ResolverContext } from "@claim/core";
import type { CompletionResult, LlmClient } from "@claim/llm";
import { llmResolveBatch } from "./llm-stage.js";
import { commentEvidence, REVIEW_CAP, ruleResolve, type RuleIntent, type RuleOutcome } from "./rules.js";

/** A ClaimIntent plus the claim a "change" gives up (not yet in the shared contract). */
export interface ResolvedIntent extends ClaimIntent {
  fromItemCode?: string;
}

export type ResolveMode = "auto" | "rules" | "llm";

export interface ResolveOptions {
  llm?: LlmClient;
  /** auto: rules first, the LLM only for comments the rules could not settle. Default auto. */
  mode?: ResolveMode;
  /** Comments per LLM call. Default 20. */
  batchSize?: number;
  /** LLM calls in flight at once. Default 2. */
  concurrency?: number;
  /** Abort a single LLM call after this long and keep the rule answer. Default 20s. */
  llmTimeoutMs?: number;
  /** Called once per LLM call; indices point into the comments passed to resolveBatch. */
  onLlmCall?: (info: { indices: number[]; completion?: CompletionResult; error?: unknown }) => void;
}

/** Below this the engine should not grant; the comment goes to the seller's review lane. */
export const GRANT_THRESHOLD = 0.8;
/** A comment that yields several intents is never auto-granted from resolve()'s single answer. */
const MULTI_INTENT_CAP = 0.6;

type CommentLike = Pick<ChatComment, "id" | "text">;
/** One context for the whole batch, or one per comment (the on-screen item moves during a show). */
export type ContextSource = ResolverContext | ((comment: CommentLike, index: number) => ResolverContext);

function toClaimIntents(commentId: string, intents: RuleIntent[], method: ClaimIntent["method"]): ResolvedIntent[] {
  return intents.map((r, i) => {
    const out: ResolvedIntent = { commentId, kind: r.kind, confidence: r.confidence, method, rationale: r.rationale };
    if (intents.length > 1) out.intentIndex = i;
    if (r.itemCode !== undefined) out.itemCode = r.itemCode;
    if (r.size !== undefined) out.size = r.size;
    if (r.color !== undefined) out.color = r.color;
    if (r.qty !== undefined) out.qty = r.qty;
    if (r.fromItemCode !== undefined) out.fromItemCode = r.fromItemCode;
    return out;
  });
}

/**
 * The LLM may not silently drop a claim the comment states in words. "question" and "other" are ignored by the
 * engine, so when the rules read a claim and the comment carries a claim word, a not-a-claim answer keeps the
 * rule claim in the seller's review lane with the model's reading attached. A bare size or colour with no
 * claim word still follows the model.
 */
function keepForReview(rule: RuleIntent[], got: RuleIntent[], text: string, ctx: ResolverContext): RuleIntent[] | undefined {
  if (!got.every((g) => g.kind === "question" || g.kind === "other")) return undefined;
  if (!rule.some((r) => (r.kind === "claim" || r.kind === "change") && r.itemCode)) return undefined;
  if (!commentEvidence(text, ctx).cue) return undefined;
  const read = got[0]!.rationale?.replace(/^llm: /, "");
  const note = `llm read it as ${got[0]!.kind}${read ? ` (${read})` : ""}; kept for review`;
  return rule.map((r) => ({ ...r, confidence: Math.min(r.confidence, REVIEW_CAP), rationale: r.rationale ? `${r.rationale}; ${note}` : note }));
}

/**
 * The model can confirm a claim yet leave out what the rules already read off the screen: "M wala mera"
 * while #12 is on air comes back as a claim with no item. When the model gives exactly one claim and the
 * rules read exactly one, the model's blanks are filled from the rule claim for the same item, so the
 * review card arrives ready to approve. The llmCap applied afterwards still holds it below the grant line.
 */
function fillFromRule(rule: RuleIntent[], got: RuleIntent[]): RuleIntent[] {
  const ruleClaims = rule.filter((r) => (r.kind === "claim" || r.kind === "change") && r.itemCode);
  const gotClaims = got.filter((g) => g.kind === "claim" || g.kind === "change");
  if (ruleClaims.length !== 1 || gotClaims.length !== 1) return got;
  const r = ruleClaims[0]!;
  return got.map((g) => {
    if (g !== gotClaims[0] || g.kind !== r.kind || (g.itemCode && g.itemCode !== r.itemCode)) return g;
    const filled: RuleIntent = { ...g };
    const took: string[] = [];
    for (const key of ["itemCode", "size", "color"] as const) {
      if (filled[key] === undefined && r[key] !== undefined) {
        filled[key] = r[key];
        took.push(key === "itemCode" ? "item" : key);
      }
    }
    if (!took.length) return g;
    return { ...filled, confidence: Math.max(g.confidence, r.confidence), rationale: `${g.rationale ?? "llm"}; ${took.join(", ")} from the rules` };
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Rules only, synchronous. Every intent the comment yields, in comment order. */
export function resolveWithRules(comment: CommentLike, ctx: ResolverContext): ResolvedIntent[] {
  return toClaimIntents(comment.id, ruleResolve(comment.text, ctx).intents, "rule");
}

/**
 * Resolve many comments from one show. Order is preserved: result[i] holds the intents of comments[i].
 * Ambiguous comments go to the LLM in batches; if a call fails or times out, those comments keep
 * their rule answer.
 */
export async function resolveBatch(comments: CommentLike[], source: ContextSource, opts: ResolveOptions = {}): Promise<ResolvedIntent[][]> {
  const mode = opts.mode ?? "auto";
  const ctxs = comments.map((c, i) => (typeof source === "function" ? source(c, i) : source));
  const outcomes: RuleOutcome[] = comments.map((c, i) => ruleResolve(c.text, ctxs[i]!));
  const results = outcomes.map((o, i) => toClaimIntents(comments[i]!.id, o.intents, "rule"));
  if (mode === "rules" || !opts.llm) return results;

  const routed = comments.map((_, i) => i).filter((i) => mode === "llm" || outcomes[i]!.needsLlm);
  const size = Math.max(1, opts.batchSize ?? 20);
  const batches: number[][] = [];
  for (let i = 0; i < routed.length; i += size) batches.push(routed.slice(i, i + size));

  const llm = opts.llm;
  await mapLimit(batches, Math.max(1, opts.concurrency ?? 2), async (batch) => {
    const payload = batch.map((i, n) => ({ id: `c${n + 1}`, text: comments[i]!.text, ctx: ctxs[i]! }));
    try {
      const { intents, completion } = await llmResolveBatch(payload, llm, { signal: AbortSignal.timeout(opts.llmTimeoutMs ?? 20_000) });
      opts.onLlmCall?.({ indices: batch, completion });
      batch.forEach((i, n) => {
        const got = intents[n];
        if (!got?.length) return;
        const kept = keepForReview(outcomes[i]!.intents, got, comments[i]!.text, ctxs[i]!);
        if (kept) {
          results[i] = toClaimIntents(comments[i]!.id, kept, "rule");
          return;
        }
        const cap = outcomes[i]!.llmCap;
        const why = outcomes[i]!.capReason ?? "rules asked for review";
        const merged = fillFromRule(outcomes[i]!.intents, got);
        const capped = cap === undefined ? merged : merged.map((g) => (g.confidence > cap ? { ...g, confidence: cap, rationale: `${g.rationale} (capped: ${why})` } : g));
        results[i] = toClaimIntents(comments[i]!.id, capped, "llm");
      });
    } catch (error) {
      opts.onLlmCall?.({ indices: batch, error });
    }
  });
  return results;
}

/** Every intent one comment yields ("sold 4 and 7" gives two). */
export async function resolveAll(comment: CommentLike, ctx: ResolverContext, opts: ResolveOptions = {}): Promise<ResolvedIntent[]> {
  return (await resolveBatch([comment], ctx, opts))[0]!;
}

/**
 * The single intent for a comment. When the comment yields several, the first is returned with its
 * confidence capped below the grant threshold so the seller reviews it; use resolveAll to see them all.
 */
export async function resolve(comment: CommentLike, ctx: ResolverContext, opts: ResolveOptions = {}): Promise<ResolvedIntent> {
  const all = await resolveAll(comment, ctx, opts);
  const first = all[0]!;
  if (all.length === 1) return first;
  return { ...first, confidence: Math.min(first.confidence, MULTI_INTENT_CAP), rationale: `${first.rationale ?? ""} (+${all.length - 1} more intents)`.trim() };
}
