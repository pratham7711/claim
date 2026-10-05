import { normalizeColor, normalizeSize } from "@claim/core";
import type { CompletionRequest, LlmClient } from "@claim/llm";
import type { Currency, ListingContext } from "./types.js";

export interface LlmListing {
  code?: string;
  title?: string;
  /** Major units, as the model heard it. */
  price?: number;
  currency?: Currency;
  variants: { size?: string; color?: string; qty?: number }[];
}

const nullable = (type: string) => ({ type: [type, "null"] });

export const LISTING_SCHEMA = {
  name: "listing_draft",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["code", "title", "price", "currency", "variants"],
    properties: {
      code: { ...nullable("string"), description: "The item number the host says on air, e.g. \"14\"" },
      title: { ...nullable("string"), description: "Short product title without filler adjectives" },
      price: { ...nullable("number"), description: "Price in major units, e.g. 38 or 2400" },
      currency: { type: ["string", "null"], enum: ["USD", "INR", null] },
      variants: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["size", "color", "qty"],
          properties: { size: nullable("string"), color: nullable("string"), qty: nullable("integer") },
        },
      },
    },
  },
} as const;

export function listingPrompt(transcript: string, ctx: ListingContext, currency: Currency): CompletionRequest["messages"] {
  const system = [
    "You turn a live-sale host's spoken words into a product listing draft for a boutique.",
    "Return JSON only. Use null for anything the host did not say; never invent a price, code or count.",
    `The show's currency is ${currency}${currency === "INR" ? " (Hindi number words such as 'sau' = hundred and 'hazaar' = thousand may appear)" : ""}.`,
    "Sizes: use S, M, L, XL, XXL, 3XL, XS, FREE, or the number for numeric sizes. Colours: lower-case words.",
    "One variant per size/colour combination, with the number of pieces the host has.",
    ctx.existingCodes?.length ? `Codes already used in this show: ${ctx.existingCodes.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: transcript },
  ];
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model reply holds no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

const str = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.toLowerCase() !== "null" ? s : undefined;
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^0-9.]/g, "")) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Validates the model's JSON by hand; anything malformed is dropped rather than trusted. */
export function readLlmListing(data: unknown): LlmListing {
  if (!data || typeof data !== "object") throw new Error("model reply is not an object");
  const o = data as Record<string, unknown>;
  const code = str(o.code)?.replace(/^#/, "");
  const title = str(o.title);
  const price = num(o.price);
  const currency = o.currency === "USD" || o.currency === "INR" ? o.currency : undefined;
  const variants = (Array.isArray(o.variants) ? o.variants : [])
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
    .map((v) => {
      const size = str(v.size);
      const color = str(v.color);
      const q = num(v.qty);
      return {
        ...(size ? { size: normalizeSize(size) } : {}),
        ...(color ? { color: normalizeColor(color) } : {}),
        ...(q !== undefined && Number.isInteger(q) && q > 0 ? { qty: q } : {}),
      };
    })
    .filter((v) => v.size || v.color || v.qty !== undefined);
  return { ...(code ? { code } : {}), ...(title ? { title } : {}), ...(price !== undefined ? { price } : {}), ...(currency ? { currency } : {}), variants };
}

/** Calls the model with a hard deadline; adapters that ignore the abort signal are raced against a timer. */
export async function askLlm(transcript: string, ctx: ListingContext, currency: Currency, llm: LlmClient): Promise<LlmListing> {
  const ms = ctx.llmTimeoutMs ?? 8000;
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`model timed out after ${ms}ms`));
    }, ms);
  });
  try {
    const res = await Promise.race([
      llm.complete({ messages: listingPrompt(transcript, ctx, currency), jsonSchema: LISTING_SCHEMA as unknown as { name: string; schema: Record<string, unknown> }, temperature: 0, maxTokens: 400, signal: ctrl.signal }),
      deadline,
    ]);
    return readLlmListing(res.json ?? extractJson(res.text));
  } finally {
    clearTimeout(timer);
  }
}
