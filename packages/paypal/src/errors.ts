export interface PayPalIssue {
  issue: string;
  field?: string;
  value?: string;
  location?: string;
  description?: string;
}

export interface PayPalErrorInit {
  op: string;
  /** HTTP status; 0 when no response arrived (network, timeout) or the request was refused locally. */
  status: number;
  /** PayPal's `name` (e.g. UNPROCESSABLE_ENTITY), or the OAuth `error` (e.g. invalid_client). */
  errorName: string;
  message: string;
  debugId?: string;
  details?: PayPalIssue[];
  cause?: unknown;
}

export class PayPalError extends Error {
  override readonly name = "PayPalError";
  readonly op: string;
  readonly status: number;
  readonly errorName: string;
  readonly debugId: string | undefined;
  readonly details: PayPalIssue[];

  constructor(init: PayPalErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.op = init.op;
    this.status = init.status;
    this.errorName = init.errorName;
    this.debugId = init.debugId;
    this.details = init.details ?? [];
  }

  /** The first issue code, e.g. INSTRUMENT_DECLINED or DUPLICATE_INVOICE_ID. */
  get issue(): string | undefined {
    return this.details[0]?.issue;
  }
}

export function isPayPalError(e: unknown): e is PayPalError {
  return e instanceof PayPalError;
}

/** A request we refuse to send: a programming error such as totals that do not add up. */
export function clientError(message: string, op = "validate"): PayPalError {
  return new PayPalError({ op, status: 0, errorName: "CLIENT_VALIDATION", message });
}

/** Builds a typed error from a PayPal REST error body or an OAuth error body. */
export function errorFromResponse(op: string, status: number, body: unknown, headerDebugId?: string): PayPalError {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const details = Array.isArray(b.details) ? (b.details as PayPalIssue[]).filter((d) => d && typeof d.issue === "string") : [];
  const errorName = str(b.name) ?? str(b.error) ?? `HTTP_${status}`;
  const debugId = str(b.debug_id) ?? headerDebugId;
  const base = str(b.message) ?? str(b.error_description) ?? (typeof body === "string" && body ? body.slice(0, 200) : errorName);
  const issue = details[0]?.issue;
  return new PayPalError({
    op,
    status,
    errorName,
    message: `${op}: ${status} ${errorName}${issue ? ` ${issue}` : ""} - ${base}${debugId ? ` (debug_id ${debugId})` : ""}`,
    ...(debugId ? { debugId } : {}),
    details,
  });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/**
 * 422 issues that mean "this buyer's funding failed", so the cart falls back to a pay-now link.
 * Sourced from the Payments v2 / Orders v2 error indexes on disk; anything else is thrown.
 */
export const DECLINE_ISSUES: ReadonlySet<string> = new Set([
  "INSTRUMENT_DECLINED",
  "TRANSACTION_REFUSED",
  "PAYER_CANNOT_PAY",
  "PAYER_ACCOUNT_RESTRICTED",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
  "PAYEE_BLOCKED_TRANSACTION",
  "COMPLIANCE_VIOLATION",
  "REDIRECT_PAYER_FOR_ALTERNATE_FUNDING",
  "MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED",
  "PAYMENT_DENIED",
  "TRANSACTION_REFUSED_BY_PAYPAL_RISK",
  "AGREEMENT_ALREADY_CANCELLED",
  "CARD_EXPIRED",
]);

/** 422 issues that need the buyer back in a PayPal flow rather than a new funding source. */
export const PAYER_ACTION_ISSUES: ReadonlySet<string> = new Set(["PAYER_ACTION_REQUIRED", "ORDER_NOT_APPROVED"]);
