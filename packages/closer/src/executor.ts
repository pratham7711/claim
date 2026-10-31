import { decimal } from "./format.js";
import type { BillLine } from "./types.js";

export interface ExecError {
  ok: false;
  status?: number;
  /** PayPal's issue or a short code for the row, e.g. NOT_AUTHORIZED. */
  code: string;
  message: string;
  /** Set when the first step worked and a later one failed, e.g. an invoice created but not sent. */
  partial?: { invoiceId?: string };
}

export type Exec<T> = ({ ok: true } & T) | ExecError;

export interface InvoiceRequest {
  proposalId: string;
  /** PayPal's invoice_number: unique per merchant, at most 25 characters. */
  invoiceNumber: string;
  shopName: string;
  buyer: string;
  email: string;
  lines: BillLine[];
  shippingCents: number;
  note?: string;
}

export interface InvoiceStatus {
  status: string;
  payerViewUrl?: string;
  /** The PayPal transaction behind a paid invoice; refunds and tracking use it. */
  captureId?: string;
  paidCents?: number;
}

/**
 * The PayPal calls Closer makes, one method per approved action. Every call carries a request id built
 * from the proposal id, so a retry replays rather than repeats. Errors come back as values, never thrown.
 */
export interface CloserExecutor {
  readonly mode: "toolkit" | "mock";
  sendInvoice(r: InvoiceRequest): Promise<Exec<{ invoiceId: string; status: string; payerViewUrl?: string }>>;
  remind(r: { proposalId: string; invoiceId: string; subject: string; note?: string }): Promise<Exec<Record<never, never>>>;
  getInvoice(invoiceId: string): Promise<Exec<InvoiceStatus>>;
  refund(r: { proposalId: string; captureId: string; amountCents: number; note?: string }): Promise<Exec<{ refundId: string; status: string }>>;
  track(r: { proposalId: string; captureId: string; carrier: string; trackingNumber: string }): Promise<Exec<{ trackerId: string }>>;
}

/** PayPal-Request-Id per proposal and step: `<proposalId>-create`, `-send`, `-remind`, `-refund`, `-track`. */
export const requestId = (proposalId: string, step: string) => `${proposalId}-${step}`.slice(0, 108);

// ---------- PayPal Agent Toolkit ----------

interface ToolkitCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolkitLike {
  client?: unknown;
  handleToolCall(call: ToolkitCall): Promise<{ content?: unknown }>;
}

export type ToolkitCtor = new (opts: {
  clientId: string;
  clientSecret: string;
  configuration: { actions: Record<string, Record<string, boolean>>; context: Record<string, unknown> };
}) => ToolkitLike;

/** Only the Toolkit actions Closer uses are switched on. */
export const TOOLKIT_ACTIONS = {
  invoices: { create: true, send: true, sendReminder: true, get: true },
  payments: { createRefund: true },
  shipment: { create: true },
};

const HTTP_CODES: Record<number, string> = { 400: "INVALID_REQUEST", 401: "AUTH_FAILED", 403: "NOT_AUTHORIZED", 404: "NOT_FOUND", 409: "CONFLICT", 422: "UNPROCESSABLE", 429: "RATE_LIMITED" };

/** The Toolkit joins PayPal's message and its first detail with ": ", which repeats the text when they match. */
function once(message: string): string {
  const m = /^(.+?)\.?: (.+)$/.exec(message);
  return m && m[1]!.replace(/\.$/, "") === m[2]!.replace(/\.$/, "") ? m[2]! : message;
}

function toError(status: number | undefined, code: string | undefined, message: string | undefined): ExecError {
  const c = status ? (HTTP_CODES[status] ?? (status >= 500 ? "PAYPAL_UNAVAILABLE" : `HTTP_${status}`)) : code || "PAYPAL_ERROR";
  const hint = status === 403 ? " PayPal refused this call for the app's account; the feature may not be enabled on the sandbox account yet." : "";
  return { ok: false, ...(status ? { status } : {}), code: c, message: `${once(message || "PayPal returned an error").slice(0, 220)}${hint}` };
}

/**
 * Reads what handleToolCall returns: the API body as JSON text, the Toolkit's LlmError as
 * `{ok:false,status,code,message}`, or `{error:{message,type}}` for a failure before the request
 * (a token fetch, say). An empty body (a 202 or 204) is a success.
 */
export function parseToolkitResult(content: unknown): { ok: true; data: Record<string, unknown> } | ExecError {
  if (content === undefined || content === null || content === "" || content === '""') return { ok: true, data: {} };
  let v: unknown;
  try {
    v = typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    return { ok: false, code: "BAD_RESPONSE", message: String(content).slice(0, 160) };
  }
  if (!v || typeof v !== "object") return { ok: true, data: {} };
  const o = v as Record<string, unknown>;
  if (o.ok === false) return toError(typeof o.status === "number" ? o.status : undefined, typeof o.code === "string" ? o.code : undefined, typeof o.message === "string" ? o.message : undefined);
  const err = o.error as { message?: unknown } | undefined;
  if (err && typeof err === "object") return toError(undefined, "PAYPAL_ERROR", typeof err.message === "string" ? err.message : undefined);
  return { ok: true, data: o };
}

const lastSegment = (href: unknown) => (typeof href === "string" ? href.split(/[/#?]/).filter(Boolean).pop() : undefined);

function payerView(data: Record<string, unknown>): string | undefined {
  if (data.rel === "payer-view" && typeof data.href === "string") return data.href;
  const links = Array.isArray(data.links) ? (data.links as { rel?: string; href?: string }[]) : [];
  const link = links.find((l) => l.rel === "payer-view")?.href;
  if (link) return link;
  const meta = (data.detail as { metadata?: { recipient_view_url?: unknown } } | undefined)?.metadata?.recipient_view_url;
  return typeof meta === "string" ? meta : undefined;
}

const cents = (v: unknown) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Math.round(Number(v) * 100) : undefined);

/** The create_invoice arguments for a bill, in the Toolkit's flat shape. Exported so tests can pin it. */
export function createInvoiceArgs(r: InvoiceRequest): Record<string, unknown> {
  return {
    currency_code: "USD",
    invoice_number: r.invoiceNumber.slice(0, 25),
    invoicer_business_name: r.shopName.slice(0, 300),
    ...(r.note ? { note: r.note.slice(0, 4000) } : {}),
    primary_recipients: [{ billing_info: { name: { given_name: r.buyer.slice(0, 140) }, email_address: r.email } }],
    items: r.lines.map((l) => ({ name: l.name.slice(0, 200), quantity: String(l.qty), unit_amount: { currency_code: "USD", value: decimal(l.unitCents) } })),
    ...(r.shippingCents ? { shipping_cost: decimal(r.shippingCents) } : {}),
  };
}

export interface ToolkitExecutorOptions {
  clientId: string;
  clientSecret: string;
  /** The payments gateway's cached OAuth token, so each Toolkit instance does not fetch its own. */
  accessToken?: () => Promise<string>;
  /** Loads PayPalAgentToolkit; tests inject a fake. */
  load?: () => Promise<ToolkitCtor>;
}

/**
 * Executes through `@paypal/agent-toolkit`'s OpenAI adapter: a fresh Toolkit per call, so each call's
 * PayPal-Request-Id (the Toolkit takes it from its context) is that call's own.
 */
export function createToolkitExecutor(opts: ToolkitExecutorOptions): CloserExecutor {
  let ctor: Promise<ToolkitCtor> | undefined;
  const load =
    opts.load ??
    (async () => {
      const mod = (await import("@paypal/agent-toolkit/openai")) as unknown as { PayPalAgentToolkit: ToolkitCtor };
      return mod.PayPalAgentToolkit;
    });

  async function call(name: string, args: Record<string, unknown>, reqId: string) {
    try {
      ctor ??= load();
      const Toolkit = await ctor;
      const tk = new Toolkit({ clientId: opts.clientId, clientSecret: opts.clientSecret, configuration: { actions: TOOLKIT_ACTIONS, context: { sandbox: true, ...(reqId ? { request_id: reqId } : {}) } } });
      if (opts.accessToken && tk.client && typeof tk.client === "object") {
        const token = await opts.accessToken().catch(() => undefined);
        // The Toolkit's client keeps its bearer token in a private field and fetches one only when it is empty.
        if (token) (tk.client as { _accessToken?: string })._accessToken = token;
      }
      const msg = await tk.handleToolCall({ id: reqId || name, type: "function", function: { name, arguments: JSON.stringify(args) } });
      return parseToolkitResult(msg?.content);
    } catch (err) {
      ctor = undefined;
      return toError(undefined, "TOOLKIT_ERROR", err instanceof Error ? err.message : String(err));
    }
  }

  return {
    mode: "toolkit",
    async sendInvoice(r) {
      const created = await call("create_invoice", createInvoiceArgs(r), requestId(r.proposalId, "create"));
      if (!created.ok) return created;
      const invoiceId = (typeof created.data.id === "string" ? created.data.id : undefined) ?? lastSegment(created.data.href);
      if (!invoiceId) return { ok: false, code: "BAD_RESPONSE", message: "PayPal created the invoice but returned no id" };
      const sent = await call("send_invoice", { invoice_id: invoiceId, send_to_recipient: true, ...(r.note ? { note: r.note.slice(0, 4000) } : {}) }, requestId(r.proposalId, "send"));
      if (!sent.ok) return { ...sent, partial: { invoiceId }, message: `Invoice ${invoiceId} was created as a draft but not sent: ${sent.message}` };
      const url = payerView(sent.data) ?? payerView(created.data);
      return { ok: true, invoiceId, status: "SENT", ...(url ? { payerViewUrl: url } : {}) };
    },
    async remind(r) {
      const res = await call("send_invoice_reminder", { invoice_id: r.invoiceId, subject: r.subject.slice(0, 200), ...(r.note ? { note: r.note.slice(0, 4000) } : {}) }, requestId(r.proposalId, "remind"));
      return res.ok ? { ok: true } : res;
    },
    async getInvoice(invoiceId) {
      // A read: no PayPal-Request-Id.
      const res = await call("get_invoice", { invoice_id: invoiceId }, "");
      if (!res.ok) return res;
      const d = res.data;
      const payments = d.payments as { paid_amount?: { value?: unknown }; transactions?: { payment_id?: unknown }[] } | undefined;
      const tx = payments?.transactions?.find((t) => typeof t.payment_id === "string")?.payment_id as string | undefined;
      const paid = cents(payments?.paid_amount?.value);
      const url = payerView(d);
      return { ok: true, status: typeof d.status === "string" ? d.status : "UNKNOWN", ...(url ? { payerViewUrl: url } : {}), ...(tx ? { captureId: tx } : {}), ...(paid !== undefined ? { paidCents: paid } : {}) };
    },
    async refund(r) {
      const res = await call(
        "create_refund",
        { capture_id: r.captureId, amount: { currency_code: "USD", value: decimal(r.amountCents) }, ...(r.note ? { note_to_payer: r.note.slice(0, 255) } : {}) },
        requestId(r.proposalId, "refund"),
      );
      if (!res.ok) return res;
      const id = typeof res.data.id === "string" ? res.data.id : undefined;
      if (!id) return { ok: false, code: "BAD_RESPONSE", message: "PayPal returned no refund id" };
      return { ok: true, refundId: id, status: typeof res.data.status === "string" ? res.data.status : "COMPLETED" };
    },
    async track(r) {
      const res = await call(
        "create_shipment_tracking",
        { transaction_id: r.captureId, tracking_number: r.trackingNumber, carrier: r.carrier, status: "SHIPPED" },
        requestId(r.proposalId, "track"),
      );
      if (!res.ok) return res;
      const errors = Array.isArray(res.data.errors) ? (res.data.errors as { name?: string; message?: string }[]) : [];
      if (errors.length) return { ok: false, code: errors[0]!.name ?? "TRACKING_FAILED", message: errors[0]!.message ?? "PayPal did not add the tracking number" };
      const ids = Array.isArray(res.data.tracker_identifiers) ? (res.data.tracker_identifiers as { transaction_id?: string; tracking_number?: string }[]) : [];
      const t = ids[0];
      return { ok: true, trackerId: t?.transaction_id ? `${t.transaction_id}-${t.tracking_number ?? r.trackingNumber}` : `${r.captureId}-${r.trackingNumber}` };
    },
  };
}

// ---------- mock ----------

export interface MockExecutor extends CloserExecutor {
  readonly mode: "mock";
  /** Every call with its request id, for tests. */
  readonly calls: { op: string; requestId: string; args: Record<string, unknown> }[];
  /** Marks a mock invoice paid, as if the buyer paid it. */
  pay(invoiceId: string): void;
}

/**
 * Simulated PayPal for mock mode and tests: ids like INV2-MOCK-…, REF-MOCK-…, and a replay of the first
 * result when a request id repeats. `fail` scripts an error for one operation.
 */
export function createMockExecutor(opts: { seed?: string; fail?: (op: string, args: Record<string, unknown>) => ExecError | undefined } = {}): MockExecutor {
  const seed = (opts.seed ?? Date.now().toString(36)).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-6);
  let n = 0;
  const id = (prefix: string) => `${prefix}-MOCK-${seed}-${String(++n).padStart(4, "0")}`;
  const replays = new Map<string, unknown>();
  const invoices = new Map<string, { status: string; amountCents: number; captureId?: string }>();
  const calls: MockExecutor["calls"] = [];

  async function once<T>(op: string, reqId: string, args: Record<string, unknown>, run: () => T): Promise<T | ExecError> {
    calls.push({ op, requestId: reqId, args });
    const failed = opts.fail?.(op, args);
    if (failed) return failed;
    if (replays.has(reqId)) return replays.get(reqId) as T;
    const out = run();
    replays.set(reqId, out);
    return out;
  }

  return {
    mode: "mock",
    calls,
    pay(invoiceId) {
      const inv = invoices.get(invoiceId);
      if (inv) Object.assign(inv, { status: "PAID", captureId: inv.captureId ?? id("CAP") });
    },
    async sendInvoice(r) {
      const args = createInvoiceArgs(r);
      const created = await once("create_invoice", requestId(r.proposalId, "create"), args, () => {
        const invoiceId = id("INV2");
        const amountCents = r.lines.reduce((a, l) => a + l.qty * l.unitCents, 0) + r.shippingCents;
        invoices.set(invoiceId, { status: "DRAFT", amountCents });
        return { invoiceId };
      });
      if ("ok" in created && created.ok === false) return created;
      const { invoiceId } = created as { invoiceId: string };
      const sent = await once("send_invoice", requestId(r.proposalId, "send"), { invoice_id: invoiceId }, () => {
        const inv = invoices.get(invoiceId);
        if (inv && inv.status === "DRAFT") inv.status = "SENT";
        return { ok: true as const };
      });
      if ("ok" in sent && sent.ok === false) return { ...sent, partial: { invoiceId } };
      return { ok: true, invoiceId, status: invoices.get(invoiceId)?.status ?? "SENT" };
    },
    async remind(r) {
      const res = await once("send_invoice_reminder", requestId(r.proposalId, "remind"), { invoice_id: r.invoiceId }, () => ({ ok: true as const }));
      return res;
    },
    async getInvoice(invoiceId) {
      calls.push({ op: "get_invoice", requestId: `get-${invoiceId}`, args: { invoice_id: invoiceId } });
      const failed = opts.fail?.("get_invoice", { invoice_id: invoiceId });
      if (failed) return failed;
      const inv = invoices.get(invoiceId);
      if (!inv) return { ok: false, status: 404, code: "NOT_FOUND", message: `No invoice ${invoiceId}` };
      return { ok: true, status: inv.status, ...(inv.captureId ? { captureId: inv.captureId, paidCents: inv.amountCents } : {}) };
    },
    async refund(r) {
      return once("create_refund", requestId(r.proposalId, "refund"), { capture_id: r.captureId, amount: decimal(r.amountCents) }, () => ({ ok: true as const, refundId: id("REF"), status: "COMPLETED" }));
    },
    async track(r) {
      return once("create_shipment_tracking", requestId(r.proposalId, "track"), { transaction_id: r.captureId, tracking_number: r.trackingNumber, carrier: r.carrier }, () => ({
        ok: true as const,
        trackerId: `${r.captureId}-${r.trackingNumber}`,
      }));
    },
  };
}
