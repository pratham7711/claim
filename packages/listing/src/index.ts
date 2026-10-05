import type { ShowItem } from "@claim/core";
import type { LlmClient } from "@claim/llm";
import { askLlm, type LlmListing } from "./llm.js";
import { assignSkus, missingFields, parseListingRules, scoreConfidence, toItem } from "./rules.js";
import type { ListingContext, ListingDraft, ListingField, ListingResult } from "./types.js";

export * from "./types.js";
export { parseListingRules, assignSkus, missingFields } from "./rules.js";
export { parseSpokenNumber, mergeNumbers } from "./numbers.js";
export { LISTING_SCHEMA, listingPrompt, readLlmListing, type LlmListing } from "./llm.js";

/**
 * Host utterance -> ShowItem draft. Rules run first and are deterministic; the LLM is asked only when
 * they leave a field missing or confidence is low, and it may fill gaps but never overrides a field the
 * rules read. The result is a draft either way: the seller confirms it before the item goes live.
 */
export async function parseListing(transcript: string, ctx: ListingContext = {}, llm?: LlmClient): Promise<ListingResult> {
  const rules = parseListingRules(transcript, ctx);
  const threshold = ctx.llmBelowConfidence ?? 0.7;
  if (!llm || (rules.missing.length === 0 && rules.confidence >= threshold)) return rules;

  let heard: LlmListing;
  try {
    heard = await askLlm(transcript, ctx, rules.draft.currency, llm);
  } catch (err) {
    return { ...rules, warnings: [...rules.warnings, `model fallback failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return mergeLlm(rules, heard);
}

function mergeLlm(rules: ListingResult, heard: LlmListing): ListingResult {
  const d = rules.draft;
  const warnings = [...rules.warnings];
  const filled: ListingField[] = [];
  const money = (cents: number) => `${d.currency === "INR" ? "₹" : "$"}${(cents / 100).toFixed(2)}`;

  const code = d.code ?? heard.code;
  if (!d.code && heard.code) filled.push("code");
  const title = d.title ?? heard.title;
  if (!d.title && heard.title) filled.push("title");

  const heardCents = heard.price !== undefined ? Math.round(heard.price * 100) : undefined;
  let priceCents = d.priceCents;
  if (priceCents === undefined && heardCents !== undefined) {
    priceCents = heardCents;
    filled.push("price");
  } else if (priceCents !== undefined && heardCents !== undefined && heardCents !== priceCents) {
    warnings.push(`model heard ${money(heardCents)} for the price; kept ${money(priceCents)}`);
  }
  if (heard.currency && heard.currency !== d.currency) warnings.push(`model heard ${heard.currency}; show currency is ${d.currency}`);

  let variants = d.variants.map(({ size, color, qty }) => ({ ...(size ? { size } : {}), ...(color ? { color } : {}), ...(qty !== undefined ? { qty } : {}) }));
  const incomplete = !variants.length || variants.some((v) => v.qty === undefined);
  const heardComplete = heard.variants.length > 0 && heard.variants.every((v) => v.qty !== undefined);
  if (incomplete && heardComplete) {
    variants = heard.variants;
    filled.push("variants");
  } else if (incomplete) {
    for (const v of variants) {
      if (v.qty !== undefined) continue;
      const match = heard.variants.find((h) => h.qty !== undefined && h.size === v.size && h.color === v.color);
      if (match) {
        v.qty = match.qty!;
        if (!filled.includes("variants")) filled.push("variants");
      }
    }
  }

  const draft: ListingDraft = {
    ...(code ? { code } : {}),
    ...(title ? { title } : {}),
    ...(priceCents !== undefined ? { priceCents } : {}),
    currency: d.currency,
    variants: assignSkus(code, variants),
  };
  if (filled.length) warnings.push(`filled by the model, please check: ${filled.join(", ")}`);
  const missing = missingFields(draft);
  const item = toItem(draft);
  return {
    draft,
    missing,
    warnings,
    confidence: scoreConfidence(missing.length, warnings.length, 0.1 * filled.length),
    method: filled.length ? "rule+llm" : "rule",
    transcript: rules.transcript,
    ...(item ? { item } : {}),
  };
}

export interface ListingEdits {
  code?: string;
  title?: string;
  priceCents?: number;
  variants?: { size?: string; color?: string; qty: number }[];
}

/** The seller's approval step: apply their edits and get a listable item, or the fields still missing. */
export function confirmListing(
  draft: ListingDraft,
  edits: ListingEdits = {},
): { ok: true; item: ShowItem } | { ok: false; missing: ListingField[] } {
  const code = edits.code ?? draft.code;
  const next: ListingDraft = {
    ...draft,
    ...(code !== undefined ? { code } : {}),
    ...(edits.title !== undefined ? { title: edits.title.trim() } : {}),
    ...(edits.priceCents !== undefined ? { priceCents: edits.priceCents } : {}),
    variants: assignSkus(code, (edits.variants ?? draft.variants).map(({ size, color, qty }) => ({ ...(size ? { size } : {}), ...(color ? { color } : {}), ...(qty !== undefined ? { qty } : {}) }))),
  };
  const item = toItem(next);
  return item ? { ok: true, item } : { ok: false, missing: missingFields(next) };
}
