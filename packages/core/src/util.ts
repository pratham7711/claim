import type { ChatComment } from "./contract.js";
import type { BuyerRef, ClaimKey } from "./types.js";

/** Orders claims by platformTs, then comment id (code-unit order), then unit index. */
export function compareKeys(a: ClaimKey, b: ClaimKey): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.n - b.n;
}

export function buyerKeyOf(platform: string, userId: string): string {
  return `${platform}:${userId}`;
}

export function buyerFromComment(c: ChatComment): BuyerRef {
  return { buyerKey: buyerKeyOf(c.platform, c.userId), displayName: c.displayName, platform: c.platform, userId: c.userId };
}

const SIZE_ALIASES: Record<string, string> = {
  xs: "XS", xsmall: "XS", extrasmall: "XS",
  s: "S", sm: "S", small: "S",
  m: "M", med: "M", medium: "M",
  l: "L", lg: "L", large: "L",
  xl: "XL", xlarge: "XL", extralarge: "XL",
  xxl: "XXL", "2xl": "XXL", xxlarge: "XXL", doublexl: "XXL",
  xxxl: "3XL", "3xl": "3XL", triplexl: "3XL",
  os: "FREE", onesize: "FREE", free: "FREE", freesize: "FREE",
};

/** Canonical size label: "medium" and "M" compare equal. Unknown labels are upper-cased. */
export function normalizeSize(size: string): string {
  const k = size.toLowerCase().replace(/[\s.\-_]/g, "");
  const direct = SIZE_ALIASES[k];
  if (direct) return direct;
  const singular = k.length > 2 && k.endsWith("s") ? SIZE_ALIASES[k.slice(0, -1)] : undefined;
  return singular ?? size.trim().toUpperCase();
}

const COLOR_ALIASES: Record<string, string> = { grey: "gray", colour: "color" };

export function normalizeColor(color: string): string {
  const c = color.trim().toLowerCase().replace(/\s+/g, " ");
  return COLOR_ALIASES[c] ?? c;
}

/** UTC wall-clock with milliseconds, e.g. 12:01:03.120. Deterministic regardless of host timezone. */
export function fmtTs(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23);
}

const SYMBOLS: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£" };

export function fmtMoney(cents: number, currency: string): string {
  const sym = SYMBOLS[currency] ?? `${currency} `;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${sym}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** FNV-1a 32-bit, hex. Used only to keep provider ids within length limits deterministically. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Keeps `s` if it fits, else truncates and appends a hash so distinct inputs stay distinct. */
export function fitId(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 9)}-${fnv1a(s)}`;
}
