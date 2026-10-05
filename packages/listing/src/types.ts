import type { ShowItem } from "@claim/core";

export type Currency = "USD" | "INR";
export type ListingField = "code" | "title" | "price" | "variants";

export interface VariantDraft {
  sku: string;
  size?: string;
  color?: string;
  /** Undefined when the host named the variant but not how many. */
  qty?: number;
}

export interface ListingDraft {
  code?: string;
  title?: string;
  /** Minor units of `currency` (cents or paise). */
  priceCents?: number;
  currency: Currency;
  variants: VariantDraft[];
}

export interface ListingContext {
  /** The show's currency. When absent it is inferred from the utterance ("$", "rupees", "sau", "saree"). */
  currency?: Currency;
  /** Codes already listed in this show, to flag collisions. */
  existingCodes?: string[];
  /** Code to assign when the host does not say one. */
  nextCode?: string;
  llmTimeoutMs?: number;
  /** Ask the LLM when rules leave a field missing or confidence falls below this. Default 0.7. */
  llmBelowConfidence?: number;
}

export interface ListingResult {
  draft: ListingDraft;
  /** Fields the seller must fill before the item can go live. */
  missing: ListingField[];
  warnings: string[];
  confidence: number;
  method: "rule" | "rule+llm";
  /** The host's words, kept as the item's as-described record. */
  transcript: string;
  /** Present once nothing is missing. It is still a draft: the seller confirms it before it goes live. */
  item?: ShowItem;
}
