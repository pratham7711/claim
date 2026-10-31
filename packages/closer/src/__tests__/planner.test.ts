import { createMockClient, LlmError } from "@claim/llm";
import { describe, expect, it } from "vitest";
import { planCloseout, RULES_LABEL } from "../planner.js";
import type { Bill, CloserLedger } from "../types.js";
import { ledger, T0, withInvoice } from "./fixtures.js";

const fixed = (l: CloserLedger) => () => l;
const toolResults = (req: { messages: { role: string; content?: string }[] }) => req.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content!) as Record<string, unknown>);

describe("planCloseout with a model", () => {
  it("runs the tool loop, validates each call, and stops when the model answers in text", async () => {
    const client = createMockClient({
      toolTurns: [
        {
          toolCalls: [
            { name: "charge_claim_pass", arguments: { refs: ["c1", "c3"], why: "Claim Pass on file" } },
            { name: "invoice_buyer", arguments: { ref: "c2", note: "Thanks for shopping with us.", why: "pass declined, email on file" } },
            { name: "send_pay_link", arguments: { ref: "c4" } },
          ],
        },
        { text: "Queued 4 actions." },
      ],
    });
    const out = await planCloseout({ instruction: "Charge every Claim Pass, invoice everyone else", client, ledger: fixed(ledger()) });
    expect(out.source).toBe("closer");
    expect(out.label).toBeUndefined();
    expect(out.drafts.map((d) => `${d.kind}:${d.buyer}:${d.amountCents}`)).toEqual(["charge:ava:4200", "charge:nora:11100", "invoice:dana:4200", "paylink:hal:5600"]);
    expect(out.drafts[2]!.note).toBe("Thanks for shopping with us.");
    expect(out.drafts[3]!.why).toBe("$56 owed, no email for an invoice");
    expect(out.summary).toBe("4 actions: charge 2 Claim Pass carts, invoice 1 buyer, send 1 pay-now link");
    expect(out.modelText).toBe("Queued 4 actions.");
    expect(out.usage).toMatchObject({ turns: 2, model: "mock-1" });
    // The second turn carries the first turn's calls and their results.
    const second = client.chatCalls[1]!;
    expect(second.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "tool"]);
    expect(toolResults(second)[0]).toEqual({ results: [expect.objectContaining({ ok: true, ref: "c1" }), expect.objectContaining({ ok: true, ref: "c3" })] });
    // The model sees whether an email exists, never the address.
    expect(client.chatCalls[0]!.messages[1]!.content).toContain('"email":true');
    expect(client.chatCalls[0]!.messages[1]!.content).not.toContain("@buyers.example.com");
  });

  it("feeds a rejected proposal back to the model, which corrects it, and counts the drop", async () => {
    const client = createMockClient({
      toolTurns: [
        { toolCalls: [{ name: "refund", arguments: { ref: "c5", amount: "500", note: "pulled thread" } }] },
        (req) => {
          const [res] = toolResults(req);
          expect(res).toEqual({ ok: false, ref: "c5", error: "refund larger than the charge: $500 asked, $42 left of cleo's $42" });
          return { toolCalls: [{ name: "refund", arguments: { ref: "c5", amount: "5.00", note: "pulled thread" } }] };
        },
        { text: "Refund queued." },
      ],
    });
    const out = await planCloseout({ instruction: "Refund cleo $5, pulled thread", client, ledger: fixed(ledger()) });
    expect(out.drafts).toEqual([expect.objectContaining({ kind: "refund", amountCents: 500, note: "pulled thread" })]);
    expect(out.dropped).toEqual([{ kind: "refund", ref: "c5", reason: "refund larger than the charge: $500 asked, $42 left of cleo's $42" }]);
    expect(out.summary).toBe("1 action: refund $5 to cleo. 1 proposal dropped: refund larger than the charge: $500 asked, $42 left of cleo's $42");
  });

  it("falls back to the rule planner on a 429, labelled, with the reason kept for the audit", async () => {
    const client = createMockClient({ toolTurns: [new LlmError("HTTP 429", 429, true)] });
    const out = await planCloseout({ instruction: "", client, ledger: fixed(ledger()) });
    expect(out.source).toBe("rules");
    expect(out.label).toBe(RULES_LABEL);
    expect(out.fallbackReason).toBe("rate-limited (429)");
    expect(out.drafts.map((d) => `${d.kind}:${d.buyer}`)).toEqual(["charge:ava", "invoice:dana", "charge:nora", "paylink:hal"]);
    expect(out.dropped).toEqual([]);
  });

  it("falls back on a timeout, and plans with rules when no model is configured", async () => {
    const slow = createMockClient({ toolTurns: [new Error("This operation was aborted")] });
    expect((await planCloseout({ instruction: "", client: slow, ledger: fixed(ledger()) })).fallbackReason).toBe("timed out");
    const none = await planCloseout({ instruction: "", ledger: fixed(ledger()) });
    expect(none).toMatchObject({ source: "rules", label: RULES_LABEL, fallbackReason: "no AI model configured" });
  });

  it("stops at the turn cap and keeps what was queued", async () => {
    const loop = () => ({ toolCalls: [{ name: "send_reminder", arguments: { ref: "c2", note: "hi" } }] });
    const client = createMockClient({ toolTurns: Array.from({ length: 10 }, () => loop) });
    const l = { ...withInvoice(ledger(), "c2"), now: T0 };
    const out = await planCloseout({ instruction: "nudge dana", client, ledger: fixed(l), limits: { tokens: 1_000_000 } });
    expect(client.chatCalls).toHaveLength(6);
    expect(out.label).toBe("Closer stopped at the 6-turn cap; the plan may be incomplete");
    expect(out.drafts).toHaveLength(1);
    expect(out.dropped).toHaveLength(5);
    expect(out.dropped[0]!.reason).toBe("a reminder for dana is already queued");
  });

  it("stops at the token cap", async () => {
    const client = createMockClient({ toolTurns: [{ toolCalls: [{ name: "charge_claim_pass", arguments: { refs: ["c1"] } }] }, { text: "never reached" }] });
    const out = await planCloseout({ instruction: "", client, ledger: fixed(ledger()), limits: { tokens: 50 } });
    expect(client.chatCalls).toHaveLength(1);
    expect(out.label).toMatch(/50-token cap/);
    expect(out.drafts).toHaveLength(1);
  });

  it("keeps a partial plan when the model fails after queuing something", async () => {
    const client = createMockClient({ toolTurns: [{ toolCalls: [{ name: "charge_claim_pass", arguments: { refs: ["c1"] } }] }, new LlmError("HTTP 429", 429, true)] });
    const out = await planCloseout({ instruction: "", client, ledger: fixed(ledger()) });
    expect(out.source).toBe("closer");
    expect(out.label).toBe("Closer stopped early: rate-limited (429); the plan may be incomplete");
    expect(out.drafts).toHaveLength(1);
  });

  it("checks invoices through the read tool, answers who owes from PayPal's status, then reminds", async () => {
    let current = withInvoice(withInvoice(ledger(), "c2"), "c4", { invoiceId: "INV2-BBBB-2222", email: "hal@x.example.com" });
    current = { ...current, bills: current.bills.map((b) => (b.ref === "c4" ? { ...b, email: "hal@x.example.com" } : b)) };
    let checks = 0;
    const checkInvoices = async (): Promise<Bill[]> => {
      checks += 1;
      // PayPal says hal paid: the ledger now shows his bill paid.
      const hal = current.bills.find((b) => b.ref === "c4")!;
      const paid: Bill = { ...hal, state: "paid", invoice: { ...hal.invoice!, status: "PAID" } };
      current = { ...current, bills: current.bills.map((b) => (b.ref === "c4" ? paid : b)) };
      return [paid];
    };
    const client = createMockClient({
      toolTurns: [
        { toolCalls: [{ name: "check_invoices", arguments: {} }] },
        (req) => {
          const [res] = toolResults(req);
          expect(res).toMatchObject({ ok: true, open: [{ ref: "c2", buyer: "dana", amount: "$42", status: "SENT" }], paid: [{ ref: "c4", buyer: "hal" }] });
          return { toolCalls: [{ name: "send_reminder", arguments: { ref: "c2", note: "Hey dana, just a heads-up the invoice is still open." } }] };
        },
        { text: "dana still owes $42; reminder queued." },
      ],
    });
    const out = await planCloseout({ instruction: "Who still owes me? Nudge them, nicely", client, ledger: () => current, checkInvoices });
    expect(checks).toBe(1);
    expect(out.checked).toBe(true);
    expect(out.answer).toBe("3 unpaid: ava $42, dana $42, nora $111; paid since the last check: hal $56.");
    expect(out.drafts).toEqual([expect.objectContaining({ kind: "reminder", buyer: "dana", invoiceId: "INV2-AAAA-1111" })]);
  });

  it("the rule fallback checks open invoices too, and survives a check that fails", async () => {
    const l = withInvoice(ledger(), "c2");
    const failing = async (): Promise<Bill[]> => {
      throw new Error("NOT_AUTHORIZED");
    };
    const out = await planCloseout({ instruction: "who owes me?", ledger: fixed(l), checkInvoices: failing });
    expect(out.checkError).toBe("NOT_AUTHORIZED");
    expect(out.checked).toBe(false);
    expect(out.answer).toBe("4 unpaid: ava $42, dana $42, nora $111, hal $56.");
    expect(out.drafts.map((d) => d.kind)).toEqual(["reminder"]);
  });

  it("drops unknown tools and unparseable arguments without crashing", async () => {
    const client = createMockClient({
      toolTurns: [{ toolCalls: [{ name: "wire_money", arguments: { ref: "c1" } }, { name: "invoice_buyer", arguments: "{not json" }] }, { text: "ok" }],
    });
    const out = await planCloseout({ instruction: "", client, ledger: fixed(ledger()) });
    expect(out.dropped.map((d) => d.reason)).toEqual(["no tool called wire_money", "arguments were not valid JSON"]);
    expect(out.drafts).toEqual([]);
  });
});
