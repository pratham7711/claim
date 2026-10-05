/** Nearest-rank percentile; null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

/** Strips the engine's per-intent suffix: "c1#2" -> "c1". */
export function baseCommentId(key: string): string {
  const m = /^(.*)#\d+$/.exec(key);
  return m ? m[1]! : key;
}

export function money(cents: number, currency = "USD"): string {
  const sym = currency === "USD" ? "$" : currency === "INR" ? "₹" : `${currency} `;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = abs % 100;
  return `${sign}${sym}${whole}${frac ? `.${String(frac).padStart(2, "0")}` : ""}`;
}

export function moneyExact(cents: number, currency = "USD"): string {
  const sym = currency === "USD" ? "$" : currency === "INR" ? "₹" : `${currency} `;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${sym}${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/** UTC wall clock with milliseconds, matching the engine's audit strings. */
export function clockMs(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23);
}

export function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function variantLabel(v: { size?: string; color?: string; sku: string }): string {
  return [v.size, v.color].filter(Boolean).join(" · ") || v.sku;
}
