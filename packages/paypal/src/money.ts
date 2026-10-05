import { clientError } from "./errors.js";

/** PayPal rejects decimals for these currencies; everything else uses two. */
const ZERO_DECIMAL = new Set(["HUF", "JPY", "TWD"]);

export function decimalsFor(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function assertCents(cents: number, what: string): void {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw clientError(`${what} must be a non-negative integer of minor units, got ${String(cents)}`);
  }
}

/** Integer minor units to PayPal's decimal string, by string slicing only (1999 -> "19.99"). */
export function toValue(cents: number, currency = "USD"): string {
  assertCents(cents, "amount");
  const d = decimalsFor(currency);
  if (d === 0) return String(cents);
  const s = String(cents).padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
}

/** PayPal decimal string to integer minor units ("19.9" -> 1990). Throws on anything but plain decimals. */
export function toCents(value: string, currency = "USD"): number {
  const d = decimalsFor(currency);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw clientError(`not a PayPal amount: ${JSON.stringify(value)}`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > d) throw clientError(`${value} has more than ${d} decimals for ${currency}`);
  const cents = Number(whole + frac.padEnd(d, "0"));
  assertCents(cents, "amount");
  return cents;
}

export function money(cents: number, currency = "USD"): { currency_code: string; value: string } {
  return { currency_code: currency, value: toValue(cents, currency) };
}
