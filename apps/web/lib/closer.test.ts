import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMockExecutor, RULES_LABEL, type MockExecutor, type Proposal } from "@claim/closer";
import { createMockClient, LlmError, type LlmClient } from "@claim/llm";
import type { MockGateway } from "@claim/paypal";
import { afterEach, describe, expect, it } from "vitest";
import { MOCK_LABEL, selectGateway } from "./payments";
import { createShowService, type ShowService } from "./service";
import { createFileStore, createMemoryStore, type ShowStore } from "./store";
import type { CloserView } from "./types";

const T0 = Date.UTC(2026, 9, 31, 18, 0, 0);
const MIN = 60_000;

let services: ShowService[] = [];
afterEach(() => {
  for (const s of services) s.dispose();
  services = [];
});

function setup(opts: { store?: ShowStore; closerLlm?: LlmClient; executor?: MockExecutor; judgeBuyerEmail?: string } = {}) {
  let t = T0;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const selected = selectGateway({});
  const executor = opts.executor ?? createMockExecutor({ seed: "test" });
  const svc = createShowService({
    store: opts.store ?? createMemoryStore(),
    gateway: selected,
    now: clock.now,
    tickMs: false,
    broadcastMs: 0,
    closerExecutor: { executor, label: MOCK_LABEL },
    ...(opts.closerLlm ? { closerLlm: opts.closerLlm } : {}),
    ...(opts.judgeBuyerEmail ? { judgeBuyerEmail: opts.judgeBuyerEmail } : {}),
  });
  services.push(svc);
  return { svc, clock, executor, gw: selected.gateway as MockGateway };
}

/** Race (ava passes, dana's card declines) plus bundle (nora), then End show. */
async function endedShow(svc: ShowService) {
  const id = await svc.create({ seed: true });
  await svc.runScenario(id, "race", { instant: true });
  await svc.runScenario(id, "bundle", { instant: true });
  expect((await svc.act(id, { action: "end" })).ok).toBe(true);
  return id;
}

const closer = (svc: ShowService, id: string): CloserView => svc.view(id, "seller")!.closer!;
const rows = (c: CloserView) => c.proposals.map((p) => `${p.kind}:${p.buyer}:${p.status}`);

describe("Closer in the show service", () => {
  it("plans the close-out with rules when no model is set, then approve all charges the passes and fails the decline", async () => {
    const { svc } = setup();
    const id = await endedShow(svc);
    const plan = await svc.act(id, { action: "closerPlan" });
    expect(plan).toMatchObject({ ok: true, data: { label: RULES_LABEL, proposals: 3 } });
    let c = closer(svc, id);
    expect(c.planner).toBe("rules");
    expect(c.plans[0]).toMatchObject({ source: "rules", fallbackReason: "no AI model configured", summary: "3 actions: charge 3 Claim Pass carts" });
    expect(rows(c)).toEqual(["charge:ava:proposed", "charge:dana:proposed", "charge:nora:proposed"]);
    expect(c.proposals.map((p) => p.amountCents)).toEqual([4200, 4200, 5600]);

    expect(await svc.act(id, { action: "closerApproveAll" })).toMatchObject({ ok: true, data: { done: 2, failed: 1 } });
    c = closer(svc, id);
    expect(rows(c)).toEqual(["charge:ava:done", "charge:dana:failed", "charge:nora:done"]);
    expect(c.proposals[1]!.result).toMatchObject({ ok: false, code: "INSTRUMENT_DECLINED" });
    const v = svc.view(id, "seller")!;
    expect(v.charges.filter((x) => x.status === "COMPLETED").map((x) => x.amountCents).sort()).toEqual([4200, 5600]);
    expect(c.log.map((l) => l.type)).toEqual(["plan", "proposed", "proposed", "proposed", "approved", "done", "failed", "done"]);
  });

  it("invoices the declined buyer on the next plan, keeps her holds while it is open, and settles it when PayPal says paid", async () => {
    const { svc, executor, clock } = setup();
    const id = await endedShow(svc);
    await svc.act(id, { action: "closerPlan" });
    await svc.act(id, { action: "closerApproveAll" });

    const plan = await svc.act(id, { action: "closerPlan", instruction: "Charge every Claim Pass, invoice everyone else" });
    expect(plan).toMatchObject({ ok: true, data: { proposals: 1, summary: "1 action: invoice 1 buyer" } });
    const inv = closer(svc, id).proposals[0]!;
    expect(inv).toMatchObject({ kind: "invoice", buyer: "dana", amountCents: 4200, call: "create_invoice → send_invoice", status: "proposed" });
    expect(inv.note).toMatch(/^Thanks for shopping/);

    const edited = await svc.act(id, { action: "closerDecide", proposalId: inv.id, decision: "edit", note: "Hi dana, here is your invoice from the show." });
    expect(edited.ok).toBe(true);
    const done = await svc.act(id, { action: "closerDecide", proposalId: inv.id, decision: "approve" });
    expect(done).toMatchObject({ ok: true, data: { status: "done", result: { ok: true, id: "INV2-MOCK-TEST-0001" } } });
    const create = executor.calls.find((x) => x.op === "create_invoice")!;
    expect(create.requestId).toBe(`${inv.id}-create`);
    expect(create.args).toMatchObject({ invoice_number: inv.id, note: "Hi dana, here is your invoice from the show.", primary_recipients: [{ billing_info: { email_address: "dana@buyers.example.com" } }] });

    // The hold would lapse in 15 minutes; the open invoice keeps it with dana.
    clock.advance(30 * MIN);
    svc.tick(id);
    let v = svc.view(id, "seller")!;
    expect(v.units.filter((u) => u.displayName === "dana").map((u) => u.status)).toEqual(["held"]);
    expect(v.closer!.invoices[0]).toMatchObject({ invoiceId: "INV2-MOCK-TEST-0001", status: "SENT", buyer: "dana" });
    expect(v.closer!.invoices[0]).not.toHaveProperty("email");

    // Who still owes? One open invoice: a reminder, and a one-line answer.
    const owes = await svc.act(id, { action: "closerPlan", instruction: "Who still owes me? Nudge them, nicely" });
    expect(owes).toMatchObject({ ok: true, data: { answer: "1 unpaid: dana $42.", summary: "1 action: remind 1 buyer" } });

    executor.pay("INV2-MOCK-TEST-0001");
    expect(await svc.act(id, { action: "closerCheck" })).toMatchObject({ ok: true, data: { paid: 1, answer: "Nobody owes you anything; paid since the last check: dana $42." } });
    v = svc.view(id, "seller")!;
    const dana = v.carts.find((b) => b.displayName === "dana")!;
    expect(dana.finalized.map((x) => x.status)).toEqual(["declined", "charged"]);
    expect(v.charges.at(-1)).toMatchObject({ via: "invoice", status: "COMPLETED", amountCents: 4200, captureId: expect.stringMatching(/^CAP-MOCK/) });
    expect(v.closer!.invoices[0]).toMatchObject({ status: "PAID", paidAt: expect.any(Number) });
    // The pending reminder is now stale: approving it fails without calling PayPal.
    const reminder = v.closer!.proposals.find((p) => p.kind === "reminder")!;
    expect(await svc.act(id, { action: "closerDecide", proposalId: reminder.id, decision: "approve" })).toMatchObject({ ok: true, data: { status: "failed", result: { code: "STALE" } } });
    expect(executor.calls.filter((x) => x.op === "send_invoice_reminder")).toHaveLength(0);
  });

  it("runs a double approve once, and treats approving a finished row as a no-op", async () => {
    const { svc } = setup();
    const id = await endedShow(svc);
    await svc.act(id, { action: "closerPlan" });
    const ava = closer(svc, id).proposals[0]!;
    const [a, b] = await Promise.all([
      svc.act(id, { action: "closerDecide", proposalId: ava.id, decision: "approve" }),
      svc.act(id, { action: "closerDecide", proposalId: ava.id, decision: "approve" }),
    ]);
    expect(a).toEqual(b);
    expect(await svc.act(id, { action: "closerDecide", proposalId: ava.id, decision: "approve" })).toMatchObject({ ok: true, data: { status: "done" } });
    expect(await svc.act(id, { action: "closerDecide", proposalId: ava.id, decision: "reject" })).toMatchObject({ ok: true, data: { status: "done" } });
    const v = svc.view(id, "seller")!;
    const avaCart = v.carts.find((x) => x.displayName === "ava")!.finalized[0]!;
    expect(v.charges.filter((x) => x.cartId === avaCart.cartId)).toHaveLength(1);
    expect(await svc.act(id, { action: "closerApproveAll" })).toMatchObject({ ok: true, data: { done: 1, failed: 1 } });
  });

  it("refunds through the chip's instruction, and drops a refund larger than the charge", async () => {
    const { svc, executor } = setup();
    const id = await endedShow(svc);
    await svc.act(id, { action: "closerPlan" });
    await svc.act(id, { action: "closerApproveAll" });
    const chips = closer(svc, id).suggestions;
    expect(chips[2]).toMatch(/^Refund (ava|nora) \$5, the \w+ had a pulled thread$/);

    await svc.act(id, { action: "closerPlan", instruction: "Refund nora $5, the cardigan had a pulled thread" });
    const refund = closer(svc, id).proposals[0]!;
    expect(refund).toMatchObject({ kind: "refund", buyer: "nora", amountCents: 500, call: "create_refund" });
    await svc.act(id, { action: "closerDecide", proposalId: refund.id, decision: "approve" });
    const v = svc.view(id, "seller")!;
    expect(v.refunds).toEqual([expect.objectContaining({ amountCents: 500, refundId: "REF-MOCK-TEST-0001", requestId: `${refund.id}-refund` })]);
    expect(executor.calls.filter((x) => x.op === "create_refund")).toHaveLength(1);

    const big = await svc.act(id, { action: "closerPlan", instruction: "Refund nora $500" });
    expect(big).toMatchObject({ ok: true, data: { proposals: 0 } });
  });

  it("feeds a scripted model's plan through validation, and falls back to rules on a 429", async () => {
    const client = createMockClient({
      model: "openai/gpt-oss-120b",
      toolTurns: [
        (req) => {
          const ledger = req.messages[1]!.content;
          const ref = (name: string) => new RegExp(`"ref":"(c\\d+)","buyer":"${name}"`).exec(ledger)![1]!;
          return {
            toolCalls: [
              { name: "charge_claim_pass", arguments: { refs: [ref("ava"), ref("nora")], why: "Claim Pass on file" } },
              { name: "invoice_buyer", arguments: { ref: ref("dana"), note: "Thanks for shopping", why: "pass on file but plan to invoice" } },
            ],
          };
        },
        { text: "Queued." },
        new LlmError("HTTP 429", 429, true),
      ],
    });
    const { svc } = setup({ closerLlm: client });
    const id = await endedShow(svc);
    expect(await svc.act(id, { action: "closerPlan" })).toMatchObject({ ok: true, data: { proposals: 3 } });
    let c = closer(svc, id);
    expect(c.planner).toBe("closer");
    expect(c.model).toBe("openai/gpt-oss-120b");
    expect(c.plans[0]).toMatchObject({ source: "closer", modelText: "Queued.", usage: { turns: 2 } });
    expect(rows(c)).toEqual(["charge:ava:proposed", "charge:nora:proposed", "invoice:dana:proposed"]);
    expect(c.proposals.every((p) => p.source === "closer")).toBe(true);

    expect(await svc.act(id, { action: "closerPlan" })).toMatchObject({ ok: true, data: { label: RULES_LABEL } });
    c = closer(svc, id);
    expect(c.plans[0]).toMatchObject({ source: "rules", fallbackReason: "rate-limited (429)" });
    // The new plan replaced the rows still waiting from the first.
    expect(rows(c)).toEqual(["charge:ava:proposed", "charge:dana:proposed", "charge:nora:proposed"]);
    expect(c.log.find((l) => l.type === "plan")!.reason).toMatch(/^Closer \(openai\/gpt-oss-120b\) planned the whole close-out/);
  });

  it("keeps proposals, decisions, results and invoices across a restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claim-closer-"));
    try {
      const first = setup({ store: createFileStore(dir) });
      const id = await endedShow(first.svc);
      await first.svc.act(id, { action: "closerPlan" });
      await first.svc.act(id, { action: "closerApproveAll" });
      await first.svc.act(id, { action: "closerPlan", instruction: "invoice everyone else" });
      const inv = closer(first.svc, id).proposals[0]!;
      await first.svc.act(id, { action: "closerDecide", proposalId: inv.id, decision: "approve" });
      const before = closer(first.svc, id);
      first.svc.dispose();

      const second = setup({ store: createFileStore(dir) });
      const after = closer(second.svc, id);
      expect(after.proposals).toEqual(before.proposals);
      expect(after.invoices).toEqual(before.invoices);
      expect(after.plans).toEqual(before.plans);
      expect(after.log).toEqual(before.log);
      // New proposal ids continue after the restored ones.
      await second.svc.act(id, { action: "closerPlan", instruction: "who owes me?" });
      const ids = closer(second.svc, id).proposals.map((p: Proposal) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settles an invoice from PayPal's INVOICING.INVOICE.PAID webhook", async () => {
    const { svc, gw } = setup();
    const id = await endedShow(svc);
    await svc.act(id, { action: "closerPlan" });
    await svc.act(id, { action: "closerApproveAll" });
    await svc.act(id, { action: "closerPlan", instruction: "invoice everyone else" });
    await svc.act(id, { action: "closerDecide", proposalId: closer(svc, id).proposals[0]!.id, decision: "approve" });
    const raw = JSON.stringify({
      id: "WH-INV-1",
      event_type: "INVOICING.INVOICE.PAID",
      resource: { invoice: { id: "INV2-MOCK-TEST-0001", status: "PAID", payments: { transactions: [{ payment_id: "TX1234567890ABCD" }] } } },
    });
    expect(await svc.webhook(gw.signWebhook(raw), raw)).toMatchObject({ status: 200, body: { matched: 1 } });
    const v = svc.view(id, "seller")!;
    expect(v.charges.at(-1)).toMatchObject({ via: "invoice", captureId: "TX1234567890ABCD" });
    expect(v.webhooks.at(-1)).toMatchObject({ type: "INVOICING.INVOICE.PAID", summary: "PayPal says invoice INV2-MOCK-TEST-0001 is paid" });
    expect(v.carts.find((b) => b.displayName === "dana")!.finalized.at(-1)!.status).toBe("charged");
  });

  it("offers a pay-now link to a buyer with no email, invoices jess at the judge's address, and rate-limits planning", async () => {
    const { svc } = setup({ judgeBuyerEmail: "judge@example.com" });
    const id = await svc.create({ seed: true });
    const t = T0;
    await svc.ingest(id, { id: "j1", platform: "room", userId: "jess-abc12", displayName: "jess", text: "sold 12 L", platformTs: t, receivedTs: t });
    await svc.ingest(id, { id: "u1", platform: "room", userId: "uma", displayName: "uma", text: "sold 7 M", platformTs: t + 1, receivedTs: t + 1 });
    expect((await svc.act(id, { action: "closerPlan" })).ok).toBe(false);
    await svc.act(id, { action: "end" });
    await svc.act(id, { action: "closerPlan" });
    const c = closer(svc, id);
    expect(rows(c)).toEqual(["invoice:jess:proposed", "paylink:uma:proposed"]);
    const link = await svc.act(id, { action: "closerDecide", proposalId: c.proposals[1]!.id, decision: "approve" }, { origin: "http://x" });
    expect(link).toMatchObject({ ok: true, data: { status: "done", result: { url: expect.stringContaining("http") } } });
    for (let i = 0; i < 5; i++) expect((await svc.act(id, { action: "closerPlan" })).ok).toBe(true);
    expect(await svc.act(id, { action: "closerPlan" })).toMatchObject({ ok: false, status: 429, error: expect.stringMatching(/at most 6 times a minute/) });
    expect(svc.view(id)!.closer).toBeUndefined();
  });
});
