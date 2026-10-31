/** "$42" for whole dollars, "$5.50" otherwise: how a seller says an amount. */
export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${abs % 100 === 0 ? String(abs / 100) : (abs / 100).toFixed(2)}`;
}

/** "42.00": PayPal's decimal string. */
export function decimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Cents from what a model or a person wrote: "5", "$5.50", 5.5. More than two decimals, a negative,
 * or anything that is not a plain number is refused rather than rounded.
 */
export function parseUsd(v: unknown): { ok: true; cents: number } | { ok: false; reason: string } {
  const text = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : typeof v === "string" ? v.trim().replace(/^\$\s*/, "").replace(/\s*(usd|dollars?)$/i, "") : "";
  if (!text) return { ok: false, reason: "say how much, in dollars" };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, reason: `"${String(v).slice(0, 20)}" is not an amount in dollars` };
  if (/\.\d{3,}$/.test(text)) return { ok: false, reason: `${text} has more than two decimals` };
  const [whole, frac = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: `${text} is not an amount in dollars` };
  return { ok: true, cents };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Blue dress (M) and Cream cardigan (S) x2". */
export function itemsText(lines: { name: string; qty: number }[]): string {
  const parts = lines.map((l) => `${l.name}${l.qty > 1 ? ` x${l.qty}` : ""}`);
  if (parts.length <= 1) return parts[0] ?? "your items";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
