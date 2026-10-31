import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createInvoiceArgs, createMockExecutor, createToolkitExecutor, parseToolkitResult, type InvoiceRequest, type ToolkitCtor } from "../executor.js";

const invoiceReq: InvoiceRequest = {
  proposalId: "show-mabc123-cl3",
  invoiceNumber: "show-mabc123-cl3",
  shopName: "Juniper & Thread",
  buyer: "dana",
  email: "dana@buyers.example.com",
  lines: [
    { name: "#14 Blue dress · M", qty: 1, unitCents: 3500 },
    { name: "#15 Cream cardigan · S", qty: 2, unitCents: 4800 },
  ],
  shippingCents: 700,
  note: "Thanks for shopping the show.",
};

/** A stand-in Toolkit that records what it was built with and answers from a script. */
function fakeToolkit(answer: (name: string, args: Record<string, unknown>) => unknown) {
  const built: { context: Record<string, unknown>; actions: unknown; token?: string }[] = [];
  const calls: { name: string; args: Record<string, unknown>; requestId: unknown }[] = [];
  const Ctor = class {
    client: { _accessToken?: string } = {};
    private ctx: Record<string, unknown>;
    constructor(opts: { configuration: { actions: unknown; context: Record<string, unknown> } }) {
      this.ctx = opts.configuration.context;
      built.push({ context: opts.configuration.context, actions: opts.configuration.actions });
    }
    async handleToolCall(call: { function: { name: string; arguments: string } }) {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      built[built.length - 1]!.token = this.client._accessToken;
      calls.push({ name: call.function.name, args, requestId: this.ctx.request_id });
      const out = answer(call.function.name, args);
      return { content: typeof out === "string" ? out : JSON.stringify(out) };
    }
  } as unknown as ToolkitCtor;
  return { Ctor, built, calls };
}

describe("toolkit executor", () => {
  it("creates then sends an invoice with the Toolkit's flat arguments and a request id per step", async () => {
    const tk = fakeToolkit((name) =>
      name === "create_invoice"
        ? { rel: "self", href: "https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-ABCD-EFGH-IJKL-MNOP", method: "GET" }
        : { rel: "payer-view", href: "https://www.sandbox.paypal.com/invoice/p/#INV2-ABCD-EFGH-IJKL-MNOP", method: "GET" },
    );
    const ex = createToolkitExecutor({ clientId: "id", clientSecret: "secret", accessToken: async () => "cached-token", load: async () => tk.Ctor });
    const res = await ex.sendInvoice(invoiceReq);
    expect(res).toEqual({ ok: true, invoiceId: "INV2-ABCD-EFGH-IJKL-MNOP", status: "SENT", payerViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-ABCD-EFGH-IJKL-MNOP" });
    expect(tk.calls.map((c) => [c.name, c.requestId])).toEqual([
      ["create_invoice", "show-mabc123-cl3-create"],
      ["send_invoice", "show-mabc123-cl3-send"],
    ]);
    expect(tk.calls[0]!.args).toMatchInlineSnapshot(`
      {
        "currency_code": "USD",
        "invoice_number": "show-mabc123-cl3",
        "invoicer_business_name": "Juniper & Thread",
        "items": [
          {
            "name": "#14 Blue dress · M",
            "quantity": "1",
            "unit_amount": {
              "currency_code": "USD",
              "value": "35.00",
            },
          },
          {
            "name": "#15 Cream cardigan · S",
            "quantity": "2",
            "unit_amount": {
              "currency_code": "USD",
              "value": "48.00",
            },
          },
        ],
        "note": "Thanks for shopping the show.",
        "primary_recipients": [
          {
            "billing_info": {
              "email_address": "dana@buyers.example.com",
              "name": {
                "given_name": "dana",
              },
            },
          },
        ],
        "shipping_cost": "7.00",
      }
    `);
    expect(tk.calls[1]!.args).toEqual({ invoice_id: "INV2-ABCD-EFGH-IJKL-MNOP", send_to_recipient: true, note: "Thanks for shopping the show." });
    // Each call gets its own Toolkit, sandboxed, with only Closer's actions on and the gateway's token reused.
    expect(tk.built.map((b) => [b.context.sandbox, b.token])).toEqual([
      [true, "cached-token"],
      [true, "cached-token"],
    ]);
    expect(tk.built[0]!.actions).toEqual({ invoices: { create: true, send: true, sendReminder: true, get: true }, payments: { createRefund: true }, shipment: { create: true } });
  });

  it("maps a 403 to NOT_AUTHORIZED with PayPal's message, and says when an invoice was created but not sent", async () => {
    const denied = { ok: false, status: 403, code: "PAYPAL_API_HTTP_ERROR", message: "Authorization failed due to insufficient permissions." };
    const tk = fakeToolkit(() => denied);
    const ex = createToolkitExecutor({ clientId: "id", clientSecret: "secret", load: async () => tk.Ctor });
    const res = await ex.sendInvoice(invoiceReq);
    expect(res).toMatchObject({ ok: false, status: 403, code: "NOT_AUTHORIZED" });
    expect(!res.ok && res.message).toMatch(/^Authorization failed due to insufficient permissions\. PayPal refused this call/);
    expect(tk.calls).toHaveLength(1);

    const half = fakeToolkit((name) => (name === "create_invoice" ? { id: "INV2-DRAFT-0001" } : { ok: false, status: 422, code: "PAYPAL_API_HTTP_ERROR", message: "Unprocessable Entity" }));
    const res2 = await createToolkitExecutor({ clientId: "id", clientSecret: "s", load: async () => half.Ctor }).sendInvoice(invoiceReq);
    expect(res2).toMatchObject({ ok: false, status: 422, code: "UNPROCESSABLE", partial: { invoiceId: "INV2-DRAFT-0001" } });
    expect(!res2.ok && res2.message).toMatch(/^Invoice INV2-DRAFT-0001 was created as a draft but not sent/);
  });

  it("reads the Toolkit's other result shapes", () => {
    expect(parseToolkitResult(undefined)).toEqual({ ok: true, data: {} });
    expect(parseToolkitResult('""')).toEqual({ ok: true, data: {} });
    expect(parseToolkitResult(JSON.stringify({ error: { message: "Failed to fetch access token: invalid_client", type: "paypal_error" } }))).toEqual({
      ok: false,
      code: "PAYPAL_ERROR",
      message: "Failed to fetch access token: invalid_client",
    });
    expect(parseToolkitResult(JSON.stringify({ ok: false, status: 503, code: "PAYPAL_API_HTTP_ERROR", message: "down" }))).toMatchObject({ code: "PAYPAL_UNAVAILABLE", status: 503 });
    expect(parseToolkitResult(JSON.stringify({ ok: false, code: "PAYPAL_API_NO_RESPONSE", message: "no answer" }))).toMatchObject({ code: "PAYPAL_API_NO_RESPONSE" });
    // The live sandbox's 403 (2026-10-31) came back with the message repeated after ": ".
    const repeated = { ok: false, status: 403, code: "PAYPAL_API_HTTP_ERROR", message: "Authorization failed due to insufficient permissions.: Authorization failed due to insufficient permissions." };
    expect(parseToolkitResult(JSON.stringify(repeated))).toMatchObject({ code: "NOT_AUTHORIZED", message: expect.stringMatching(/^Authorization failed due to insufficient permissions\. PayPal refused/) });
    expect(parseToolkitResult("<html>")).toMatchObject({ ok: false, code: "BAD_RESPONSE" });
  });

  it("reads an invoice's status, payer view and the transaction that paid it", async () => {
    const tk = fakeToolkit(() => ({
      id: "INV2-ABCD",
      status: "PAID",
      detail: { metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#INV2-ABCD" } },
      payments: { paid_amount: { currency_code: "USD", value: "42.00" }, transactions: [{ payment_id: "7AB12345CD678901E", method: "PAYPAL" }] },
    }));
    const res = await createToolkitExecutor({ clientId: "id", clientSecret: "s", load: async () => tk.Ctor }).getInvoice("INV2-ABCD");
    expect(res).toEqual({ ok: true, status: "PAID", payerViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-ABCD", captureId: "7AB12345CD678901E", paidCents: 4200 });
    expect(tk.calls[0]).toMatchObject({ name: "get_invoice", args: { invoice_id: "INV2-ABCD" }, requestId: undefined });
  });

  it("refunds, reminds and tracks with per-proposal request ids", async () => {
    const tk = fakeToolkit((name) =>
      name === "create_refund" ? { id: "1JU08902781691411", status: "COMPLETED" } : name === "create_shipment_tracking" ? { tracker_identifiers: [{ transaction_id: "CAP1", tracking_number: "9400111202" }], errors: [] } : "",
    );
    const ex = createToolkitExecutor({ clientId: "id", clientSecret: "s", load: async () => tk.Ctor });
    expect(await ex.refund({ proposalId: "p-cl7", captureId: "CAP1", amountCents: 500, note: "pulled thread" })).toEqual({ ok: true, refundId: "1JU08902781691411", status: "COMPLETED" });
    expect(await ex.remind({ proposalId: "p-cl8", invoiceId: "INV2-ABCD", subject: "Your invoice", note: "heads-up" })).toEqual({ ok: true });
    expect(await ex.track({ proposalId: "p-cl9", captureId: "CAP1", carrier: "USPS", trackingNumber: "9400111202" })).toEqual({ ok: true, trackerId: "CAP1-9400111202" });
    expect(tk.calls.map((c) => [c.name, c.requestId, c.args])).toEqual([
      ["create_refund", "p-cl7-refund", { capture_id: "CAP1", amount: { currency_code: "USD", value: "5.00" }, note_to_payer: "pulled thread" }],
      ["send_invoice_reminder", "p-cl8-remind", { invoice_id: "INV2-ABCD", subject: "Your invoice", note: "heads-up" }],
      ["create_shipment_tracking", "p-cl9-track", { transaction_id: "CAP1", tracking_number: "9400111202", carrier: "USPS", status: "SHIPPED" }],
    ]);
  });

  it("turns a Toolkit that fails to load into an error value", async () => {
    const ex = createToolkitExecutor({ clientId: "id", clientSecret: "s", load: async () => Promise.reject(new Error("Cannot find module")) });
    expect(await ex.getInvoice("INV2-X")).toEqual({ ok: false, code: "TOOLKIT_ERROR", message: "Cannot find module" });
  });
});

describe("toolkit executor against the real @paypal/agent-toolkit", () => {
  // The Toolkit posts through the axios it bundles; a stand-in adapter captures the HTTP request instead of sending it.
  const toolkitRequire = createRequire(createRequire(import.meta.url).resolve("@paypal/agent-toolkit/openai"));
  const axios = toolkitRequire("axios");
  const original = axios.defaults.adapter;
  afterEach(() => {
    axios.defaults.adapter = original;
  });

  it("sends create_invoice to PayPal's sandbox with the seeded token and the proposal's request id", async () => {
    const seen: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    axios.defaults.adapter = async (config: { url: string; method: string; headers: Record<string, string>; data?: string }) => {
      seen.push({ url: config.url, method: config.method, headers: { ...config.headers }, body: config.data ? JSON.parse(config.data) : undefined });
      const send = config.url.endsWith("/send");
      const data = send ? { rel: "payer-view", href: "https://www.sandbox.paypal.com/invoice/p/#INV2-REAL-0001", method: "GET" } : { rel: "self", href: "https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-REAL-0001", method: "GET" };
      return { data, status: send ? 200 : 201, statusText: "OK", headers: {}, config };
    };
    const ex = createToolkitExecutor({ clientId: "id", clientSecret: "secret", accessToken: async () => "seeded-token" });
    const res = await ex.sendInvoice(invoiceReq);
    expect(res).toMatchObject({ ok: true, invoiceId: "INV2-REAL-0001", payerViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-REAL-0001" });
    expect(seen.map((s) => [s.method, s.url, s.headers.Authorization, s.headers["PayPal-Request-Id"]])).toEqual([
      ["post", "https://api.sandbox.paypal.com/v2/invoicing/invoices", "Bearer seeded-token", "show-mabc123-cl3-create"],
      ["post", "https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-REAL-0001/send", "Bearer seeded-token", "show-mabc123-cl3-send"],
    ]);
    expect(seen[0]!.body).toMatchObject({
      detail: { invoice_number: "show-mabc123-cl3", currency_code: "USD", note: "Thanks for shopping the show." },
      invoicer: { business_name: "Juniper & Thread" },
      primary_recipients: [{ billing_info: { email_address: "dana@buyers.example.com" } }],
      items: [{ quantity: "1", unit_amount: { value: "35.00" } }, { quantity: "2", unit_amount: { value: "48.00" } }],
      amount: { breakdown: { shipping: { amount: { currency_code: "USD", value: "7.00" } } } },
    });
  });

  it("maps PayPal's real 403 body through the Toolkit's error path", async () => {
    axios.defaults.adapter = async (config: unknown) => {
      const response = { data: { name: "NOT_AUTHORIZED", message: "Authorization failed due to insufficient permissions.", details: [{ issue: "PERMISSION_DENIED", description: "You do not have permission to access or perform operations on this resource." }] }, status: 403, statusText: "Forbidden", headers: {}, config };
      throw new axios.AxiosError("Request failed with status code 403", "ERR_BAD_REQUEST", config, null, response);
    };
    const res = await createToolkitExecutor({ clientId: "id", clientSecret: "secret", accessToken: async () => "seeded-token" }).sendInvoice(invoiceReq);
    expect(res).toMatchObject({ ok: false, status: 403, code: "NOT_AUTHORIZED" });
    expect(!res.ok && res.message).toMatch(/^Authorization failed due to insufficient permissions\.: You do not have permission/);
  });
});

describe("mock executor", () => {
  it("returns INV2-MOCK and REF-MOCK ids, replays a repeated request id, and can mark an invoice paid", async () => {
    const ex = createMockExecutor({ seed: "t1" });
    const a = await ex.sendInvoice(invoiceReq);
    const again = await ex.sendInvoice(invoiceReq);
    expect(a).toEqual({ ok: true, invoiceId: "INV2-MOCK-T1-0001", status: "SENT" });
    expect(again).toEqual(a);
    expect(await ex.getInvoice("INV2-MOCK-T1-0001")).toEqual({ ok: true, status: "SENT" });
    ex.pay("INV2-MOCK-T1-0001");
    expect(await ex.getInvoice("INV2-MOCK-T1-0001")).toEqual({ ok: true, status: "PAID", captureId: "CAP-MOCK-T1-0002", paidCents: 3500 + 9600 + 700 });
    expect(await ex.refund({ proposalId: "p-cl2", captureId: "CAP-MOCK-T1-0002", amountCents: 500 })).toEqual({ ok: true, refundId: "REF-MOCK-T1-0003", status: "COMPLETED" });
    expect(createInvoiceArgs(invoiceReq).invoice_number).toBe("show-mabc123-cl3");
  });

  it("scripts a failure for one operation", async () => {
    const ex = createMockExecutor({ fail: (op) => (op === "create_invoice" ? { ok: false, status: 403, code: "NOT_AUTHORIZED", message: "no invoicing" } : undefined) });
    expect(await ex.sendInvoice(invoiceReq)).toEqual({ ok: false, status: 403, code: "NOT_AUTHORIZED", message: "no invoicing" });
  });
});
