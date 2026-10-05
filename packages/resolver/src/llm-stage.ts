import type { IntentKind, ResolverContext, ShowItem } from "@claim/core";
import type { CompletionResult, LlmClient } from "@claim/llm";
import { canonColor, colorAliases, colorsOf, matchSize, SIZE_WORDS, sizesOf, variantFit } from "./lexicon.js";
import { commentEvidence, REVIEW_CAP, type CommentEvidence, type RuleIntent } from "./rules.js";

export const INTENT_KINDS: IntentKind[] = ["claim", "cancel", "change", "waitlist", "question", "other"];

const nullable = (type: string) => ({ type: [type, "null"] });

/** Strict-mode compatible: every property required, no additional properties. */
export const RESOLVE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: INTENT_KINDS },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { code: { type: "string" }, size: nullable("string"), color: nullable("string"), qty: nullable("integer") },
              required: ["code", "size", "color", "qty"],
              additionalProperties: false,
            },
          },
          from: nullable("string"),
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: ["id", "kind", "items", "from", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

export const SYSTEM_PROMPT = `You read comments from a live-sale stream (a seller shows items on camera; viewers claim them in chat) and decide what each comment means for the seller's claim desk. Giving an item to the wrong person costs the seller far more than sending a comment to their review queue, so when in doubt lower your confidence.

kind:
- claim: THIS viewer is taking an item now. Statements and requests both count: "sold 12", "me!", "mine", "I'll take the black M", "can I get one", "ye mere liye kar do", "mera book karo", "mujhe de do", "lo quiero".
- cancel: withdraws an earlier claim ("cancel", "jk", "nahi chahiye").
- change: swaps an earlier claim to another item or variant ("make mine a L", "cancel 7 take 8", "8 instead of 7", "dusra wala kar do" = make it the other one).
- waitlist: wants it only if someone else drops out ("waitlist 5", "if anyone cancels I'll take it").
- question: asks for information: price, size, measurements, stock, colours, shipping, payment, or how/where to order ("how do I book", "kaise book kare", "which number do I book"). A request to reserve an item is a claim even when it ends with "?" or "please"; asking HOW to claim is a question.
- other: chatter, greetings, compliments, wishes, complaints, hypotheticals, auction bids, game picks, ratings like "10/10", and requests to SHOW something ("show the back", "red dikhao", "zoom in"): showing is not claiming.

Not the speaker's claim. These are never claims (use other, or question if they ask something), even when they contain "claim", "want", "sold", "me" or "book":
- someone else wants or took it: "Sam wants it", "she needs the blue", "my friend claimed it", "usko chahiye";
- negated: "not me", "not mine", "mera nahi";
- a report of something already done: "I claimed it earlier", "got one already", "booking ho gayi", "maine kal book kiya tha", "payment kar diya";
- aimed at something that is not an item in the catalogue: "claim the giveaway", "the claim line was fast".

No claim word, no claim. A claim needs a claim word or a clear request to reserve ("sold", "claim", "mine", "me", "I'll take", "can I get", "book", "rakh do", "chahiye", "mera ... kar do"), or is nothing but the item's code typed on its own. A size or colour alone ("green 38", "maroon colour", "black size 44 only") is not a claim: it is usually a stock question (question) or a request to see it (other). "testing 22", "yes", "yep", "ok", "same" are not claims.

Which item. Use only a code the viewer wrote, an item whose title the viewer names and no other item shares, or the item ON SCREEN NOW for "this", "it", "sold", "me". Never work out a code from position or description words ("the last kurta", "the previous one", "the grey one", "that one from before") unless exactly one item fits; otherwise give items [] and confidence at most 0.4, and the seller will place it. Codes can be letters (A-J) when the catalogue uses them.

items: one entry per item taken. code MUST be one of the catalogue codes; never invent one. A bare "sold"/"me"/"mine" means the item marked ON SCREEN NOW. A number is a size, not a code, when it matches a size of the item in play and has no "#"/"number" marker ("size 12", "12 please" on an item sold in 12). A decimal after "claim" on a graded item ("claim 9.4") is a grade, not a code. If the comment claims something you cannot place on exactly one catalogue code, keep its kind (claim) with items [] and confidence at most 0.4. Copy size and colour spelled as in the catalogue, or null when not given. qty only when stated.
from: for change, the code being given up if the comment names it, else null.
confidence: the probability a careful seller would agree with your reading. Use 0.9+ only when unambiguous. If you cannot tell what a comment means, answer other with confidence at most 0.4; do not use question as a fallback.
reason: at most 8 words.
Glossary. Hinglish: chahiye/chaiye = want; book kar do / rakh do / rakh lo = reserve it for me; mera/meri/mujhe = mine/me; mere liye = for me; wala/wali = the one; dusra wala = the other one; kala = black, laal = red, neela = blue, safed = white, peela = yellow, hara = green, gulabi = pink; ki jagah / ke badle = instead of; nahi chahiye = don't want; kitne ka / price kya hai = how much; kaise / kis / kaunsa = how / which (a question); batao = tell me (a question); dikhao / dikha do = show (other); maine ... kiya / liya / ho gaya = I did / it is done (a report, other); koi nahi lega to = if nobody takes it (waitlist). Spanish: lo quiero = I want it; apartame / me lo apartas = hold it for me; talla = size; cancela = cancel; en vez de = instead of.`;

function catalogueLine(item: ShowItem, onScreen: boolean): string {
  const sizes = sizesOf(item);
  const colors = colorsOf(item);
  const parts = [`#${item.code} ${item.title}`];
  if (sizes.length) parts.push(`sizes ${sizes.join(", ")}`);
  if (colors.length) parts.push(`colours ${colors.join(", ")}`);
  if (onScreen) parts.push("ON SCREEN NOW");
  return parts.join(" | ");
}

/**
 * The on-screen item, every item a comment in the batch names, then the rest up to maxLines, in catalogue
 * order. Large plain grids (a 240-lot sale) are summarised as a code range instead.
 */
export function buildCatalogue(ctx: ResolverContext, maxLines = 60, named: Iterable<string> = []): string {
  const current = ctx.currentItem;
  const items = ctx.items.filter((i) => i.code !== current?.code);
  const lines = current ? [catalogueLine(current, true)] : ["(nothing on screen right now)"];
  const simple = items.every((i) => sizesOf(i).length === 0 && colorsOf(i).length === 0 && /^(lot|item) \d+$/i.test(i.title));
  if (items.length > maxLines && simple) {
    const codes = items.map((i) => Number(i.code)).filter(Number.isFinite);
    lines.push(`Lots #${Math.min(...codes)}-#${Math.max(...codes)} (single pieces, no sizes or colours; any of these codes is valid)`);
  } else {
    const pinned = new Set(named);
    const keep = new Set([...items.filter((i) => pinned.has(i.code)), ...items.filter((i) => !pinned.has(i.code))].slice(0, maxLines));
    for (const item of items) if (keep.has(item)) lines.push(catalogueLine(item, false));
    if (items.length > keep.size) lines.push(`(+${items.length - keep.size} more items not listed)`);
  }
  return lines.join("\n");
}

export interface LlmComment {
  id: string;
  text: string;
  /** The show context when this comment was posted; comments in one call may sit on different on-screen items. */
  ctx: ResolverContext;
}

/** Union of several contexts from one show, newest first. */
export function mergeContexts(ctxs: ResolverContext[]): ResolverContext {
  const items = new Map<string, ShowItem>();
  for (const ctx of [...ctxs].sort((a, b) => b.items.length - a.items.length)) {
    for (const item of ctx.items) if (!items.has(item.code)) items.set(item.code, item);
    if (ctx.currentItem && !items.has(ctx.currentItem.code)) items.set(ctx.currentItem.code, ctx.currentItem);
  }
  const screens = new Set(ctxs.map((c) => c.currentItem?.code));
  const currentItem = screens.size === 1 ? ctxs[0]?.currentItem : undefined;
  return currentItem ? { items: [...items.values()], currentItem } : { items: [...items.values()] };
}

export function buildUserPrompt(comments: LlmComment[]): string {
  const merged = mergeContexts(comments.map((c) => c.ctx));
  const perComment = new Set(comments.map((c) => c.ctx.currentItem?.code)).size > 1;
  const body = comments
    .map((c) => JSON.stringify(perComment ? { id: c.id, on_screen: c.ctx.currentItem?.code ?? null, text: c.text } : { id: c.id, text: c.text }))
    .join("\n");
  const note = perComment ? "\nEach comment carries on_screen: the code on screen when it was posted (that is what a bare \"sold\"/\"me\" means).\n" : "";
  const named = comments.flatMap((c) => [...commentEvidence(c.text, c.ctx).codes]);
  return `Catalogue:\n${buildCatalogue(merged, 60, named)}\n${note}\nComments, one JSON object per line:\n${body}\n\nReturn one result per comment id, in the same order.`;
}

interface RawItem {
  code?: unknown;
  size?: unknown;
  color?: unknown;
  qty?: unknown;
}
interface RawResult {
  id?: unknown;
  kind?: unknown;
  items?: unknown;
  from?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function findItem(ctx: ResolverContext, code: string | undefined): ShowItem | undefined {
  if (!code) return undefined;
  const c = code.replace(/^#/, "").toLowerCase();
  return ctx.items.find((i) => i.code.toLowerCase() === c) ?? (ctx.currentItem?.code.toLowerCase() === c ? ctx.currentItem : undefined);
}

function canonSize(item: ShowItem, size: string | undefined) {
  if (!size) return { size: undefined, ok: true };
  const hit = matchSize(item, [size, ...(SIZE_WORDS[size.toLowerCase()] ?? [])]);
  return { size: hit ?? size, ok: !!hit };
}

function canonicalColor(item: ShowItem, color: string | undefined) {
  if (!color) return { color: undefined, ok: true };
  const aliases = colorAliases(item);
  const key = color.toLowerCase().trim();
  const hit = aliases.get(key) ?? aliases.get(canonColor(key)) ?? key.split(/\s+/).map((w) => aliases.get(canonColor(w))).find(Boolean);
  return { color: hit ?? color, ok: !!hit };
}

/**
 * Turn one raw model result into intents the engine can trust:
 * - codes outside the catalogue are dropped (the comment becomes a low-confidence question);
 * - given the comment text, a code the comment does not name is dropped unless it is the item on screen
 *   and the comment does not point elsewhere by position; a claim left with no item goes to review;
 * - a claim or change with no claim word in the comment is capped below the grant line;
 * - variants are mapped onto the item's own spelling, and confidence is capped by how well the variant
 *   is pinned down.
 */
export function validateLlmResult(raw: RawResult, ctx: ResolverContext, text?: string): RuleIntent[] {
  const kind = INTENT_KINDS.includes(raw.kind as IntentKind) ? (raw.kind as IntentKind) : "other";
  let confidence = clamp(typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : 0.5, 0, 0.97);
  let reason = str(raw.reason) ?? "llm";
  const evidence: CommentEvidence | undefined = text === undefined ? undefined : commentEvidence(text, ctx);
  const from = findItem(ctx, str(raw.from))?.code;
  const rawItems = Array.isArray(raw.items) ? (raw.items as RawItem[]) : [];
  const invented = rawItems.map((i) => str(i.code)).filter((c) => c && !findItem(ctx, c));
  const found = rawItems.flatMap((i) => {
    const item = findItem(ctx, str(i.code));
    return item ? [{ item, raw: i }] : [];
  });
  const named = (code: string) => !evidence || evidence.codes.has(code) || (code === ctx.currentItem?.code && !evidence.position);
  const placed = found.filter(({ item }) => named(item.code));
  const needsItem = kind === "claim" || kind === "change" || kind === "waitlist";
  if (placed.length < found.length) reason += " (item not named in the comment)";
  if (evidence && !evidence.cue && (kind === "claim" || kind === "change") && confidence > REVIEW_CAP) {
    confidence = REVIEW_CAP;
    reason += " (no claim word)";
  }

  if (needsItem && placed.length === 0) {
    if (invented.length) return [{ kind: "question", confidence: Math.min(confidence, 0.3), rationale: `llm: code ${invented[0]} is not in this show` }];
    return [{ kind, confidence: Math.min(confidence, 0.5), rationale: `llm: ${reason}`, ...(kind === "change" && from && { fromItemCode: from }) }];
  }
  if (invented.length) confidence = Math.min(confidence, 0.6);
  if (placed.length > 1) confidence = Math.min(confidence, 0.9);
  if (placed.length === 0) return [{ kind, confidence, rationale: `llm: ${reason}` }];

  return placed.map(({ item, raw: r }) => {
    const s = canonSize(item, str(r.size));
    const c = canonicalColor(item, str(r.color));
    const fit = variantFit(item, s.size, c.color).fit;
    let conf = confidence;
    if (needsItem && (!s.ok || !c.ok || fit === "unavailable")) conf = Math.min(conf, 0.6);
    else if (needsItem && fit === "underspecified") conf = Math.min(conf, 0.75);
    const intent: RuleIntent = { kind, itemCode: item.code, confidence: Math.round(conf * 100) / 100, rationale: `llm: ${reason}` };
    if (s.size) intent.size = s.size;
    if (c.color) intent.color = c.color;
    if (typeof r.qty === "number" && Number.isInteger(r.qty) && r.qty > 0) intent.qty = r.qty;
    if (from && kind === "change" && from !== item.code) intent.fromItemCode = from;
    return intent;
  });
}

export interface LlmBatchResult {
  /** Same order as the input comments; undefined where the model gave no usable answer. */
  intents: (RuleIntent[] | undefined)[];
  completion: CompletionResult;
}

/** One model call for a batch of comments from one show. Each answer is validated against its own comment's context. */
export async function llmResolveBatch(
  comments: LlmComment[],
  llm: LlmClient,
  opts: { signal?: AbortSignal; maxTokens?: number } = {},
): Promise<LlmBatchResult> {
  const completion = await llm.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(comments) },
    ],
    jsonSchema: { name: "claim_intents", schema: RESOLVE_SCHEMA as unknown as Record<string, unknown> },
    temperature: 0,
    maxTokens: opts.maxTokens ?? 200 + comments.length * 100,
    signal: opts.signal,
  });
  const json = completion.json as { results?: unknown } | undefined;
  const results = Array.isArray(json?.results) ? (json.results as RawResult[]) : [];
  const byId = new Map(results.map((r) => [String(r.id), r]));
  return {
    intents: comments.map((c) => {
      const r = byId.get(c.id);
      return r ? validateLlmResult(r, c.ctx, c.text) : undefined;
    }),
    completion,
  };
}
