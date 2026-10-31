import { LlmError, type LlmClient, type ToolCall, type ToolChatMessage } from "@claim/llm";
import { usd } from "./format.js";
import { invoiceNote, owesAnswer, readInstruction, refundNote, reminderNote, rulePlan, type Ask } from "./rules.js";
import { summarize } from "./summary.js";
import { CLOSER_SYSTEM, CLOSER_TOOLS, invoiceDigest, ledgerDigest } from "./tools.js";
import { isOpenInvoice, validateDraft } from "./validate.js";
import type { Bill, CloserLedger, Draft, PlanRecord, ProposalDraft, ProposalSource } from "./types.js";

export interface PlanLimits {
  /** Model round trips. */
  turns: number;
  /** Input plus output tokens across the whole plan. */
  tokens: number;
  /** Wall time for the model part; the rule planner takes over after it. */
  budgetMs: number;
  maxTokensPerTurn: number;
}

export const DEFAULT_LIMITS: PlanLimits = { turns: 6, tokens: 6000, budgetMs: 8000, maxTokensPerTurn: 1024 };

export const RULES_LABEL = "Rule-based plan (AI busy)";

export interface PlanInput {
  instruction: string;
  /** Closer's model; without one (or without tool calling) the rule planner plans. */
  client?: LlmClient;
  /** The current ledger. Called again after check_invoices, so it must read live state. */
  ledger: () => CloserLedger;
  /** Refreshes every open invoice from PayPal and returns the bills it found paid. */
  checkInvoices?: () => Promise<Bill[]>;
  limits?: Partial<PlanLimits>;
  now?: () => number;
}

export interface PlanOutcome {
  source: ProposalSource;
  label?: string;
  fallbackReason?: string;
  drafts: ProposalDraft[];
  dropped: PlanRecord["dropped"];
  answer?: string;
  /** Invoices were checked with PayPal during the plan. */
  checked: boolean;
  checkError?: string;
  modelText?: string;
  usage?: PlanRecord["usage"];
  summary: string;
}

function whyFor(d: ProposalDraft): string {
  switch (d.kind) {
    case "charge":
      return `Claim Pass on file; ${usd(d.amountCents)} due`;
    case "invoice":
      return `${usd(d.amountCents)} owed, email on file`;
    case "paylink":
      return `${usd(d.amountCents)} owed, no email for an invoice`;
    case "reminder":
      return "invoice still open";
    default:
      return "seller asked";
  }
}

/** The model is unavailable for this reason; said in the audit, not in the seller's label. */
function unavailable(err: unknown): string {
  if (err instanceof LlmError) {
    if (err.status === 429) return "rate-limited (429)";
    if (err.status === 402) return err.message;
    if (/timed? ?out|abort/i.test(err.message)) return "timed out";
    return err.message.slice(0, 120);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /abort|timed? ?out/i.test(msg) ? "timed out" : msg.slice(0, 120);
}

/**
 * Plans the close-out. With a model: a tool-calling loop, capped in turns, tokens and wall time, where
 * every proposed action is validated against the ledger and a rejection goes back to the model as the
 * tool result. Without one, or when it fails before queuing anything, the rule planner plans instead.
 * Nothing here executes: the result is a list of proposals for the seller to approve.
 */
export async function planCloseout(input: PlanInput): Promise<PlanOutcome> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const now = input.now ?? Date.now;
  const ask = readInstruction(input.instruction);
  const drafts: ProposalDraft[] = [];
  const dropped: PlanRecord["dropped"] = [];
  const paidSince: Bill[] = [];
  let checked = false;
  let checkError: string | undefined;

  const check = async (): Promise<boolean> => {
    if (!input.checkInvoices) return false;
    try {
      paidSince.push(...(await input.checkInvoices()));
      checked = true;
      return true;
    } catch (err) {
      checkError = err instanceof Error ? err.message.slice(0, 160) : String(err);
      return false;
    }
  };

  /** Fills a template note where the planner left none, so the buyer never gets an empty invoice note. */
  const withNote = (p: ProposalDraft, ledger: CloserLedger): ProposalDraft => {
    if (p.note || !["invoice", "reminder", "refund"].includes(p.kind)) return p;
    const bill = ledger.bills.find((b) => b.key === p.billKey);
    if (!bill) return p;
    const note = p.kind === "invoice" ? invoiceNote(bill, ledger.shopName) : p.kind === "reminder" ? reminderNote(bill, ledger.shopName) : refundNote(undefined, ledger.shopName);
    return { ...p, note };
  };

  const queue = (d: Draft): Record<string, unknown> => {
    const ledger = input.ledger();
    const v = validateDraft(d, ledger, { queued: drafts, sellerAskedRelease: ask.release });
    if (!v.ok) {
      dropped.push({ kind: d.kind, ref: String(d.ref ?? "").slice(0, 20), reason: v.reason });
      return { ok: false, ref: d.ref, error: v.reason };
    }
    const p = withNote({ ...v.proposal, why: v.proposal.why || whyFor(v.proposal) }, ledger);
    drafts.push(p);
    return { ok: true, ref: d.ref, queued: `${p.kind} ${p.buyer} ${usd(p.amountCents)}` };
  };

  const answerFor = (a: Ask) => (a.owes || paidSince.length ? owesAnswer(input.ledger(), paidSince) : undefined);

  const outcome = (o: Omit<PlanOutcome, "drafts" | "dropped" | "checked" | "summary" | "answer">): PlanOutcome => {
    const answer = answerFor(ask);
    return {
      ...o,
      drafts,
      dropped,
      checked,
      ...(checkError ? { checkError } : {}),
      ...(answer ? { answer } : {}),
      summary: summarize(drafts, dropped),
    };
  };

  const rules = async (reason: string): Promise<PlanOutcome> => {
    drafts.length = 0;
    dropped.length = 0;
    const wantsCheck = ask.all || ask.owes || ask.remind;
    if (!checked && wantsCheck && input.ledger().invoices.some((i) => isOpenInvoice(i.status))) await check();
    for (const d of rulePlan(input.ledger(), input.instruction).drafts) queue(d);
    return outcome({ source: "rules", label: RULES_LABEL, fallbackReason: reason });
  };

  const client = input.client;
  if (!client?.chat) return rules("no AI model configured");

  const started = now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("Closer timed out")), limits.budgetMs);
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let model = client.model;
  let modelText: string | undefined;
  let stopped: string | undefined;

  async function handle(call: ToolCall): Promise<Record<string, unknown>> {
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(call.arguments || "{}") as unknown;
      args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      dropped.push({ kind: call.name, ref: "?", reason: "arguments were not valid JSON" });
      return { ok: false, error: "arguments were not valid JSON" };
    }
    const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : typeof args[k] === "number" ? String(args[k]) : undefined);
    const ref = s("ref") ?? "";
    const why = s("why");
    const common = { ref, ...(why ? { why } : {}) };
    switch (call.name) {
      case "check_invoices": {
        if (!(await check())) return { ok: false, error: checkError ? `PayPal did not answer: ${checkError}` : "no invoices to check" };
        return { ok: true, ...invoiceDigest(input.ledger()) };
      }
      case "charge_claim_pass": {
        const refs = Array.isArray(args.refs) ? args.refs.map(String) : ref ? [ref] : [];
        if (!refs.length) {
          dropped.push({ kind: "charge", ref: "?", reason: "no refs given" });
          return { ok: false, error: "give at least one ref" };
        }
        return { results: refs.map((r) => queue({ kind: "charge", ref: r, ...(why ? { why } : {}) })) };
      }
      case "invoice_buyer":
        return queue({ kind: "invoice", ...common, ...(s("note") ? { note: s("note") } : {}), ...(s("amount") ? { amount: s("amount") } : {}) });
      case "send_pay_link":
        return queue({ kind: "paylink", ...common });
      case "send_reminder":
        return queue({ kind: "reminder", ...common, ...(s("note") ? { note: s("note") } : {}) });
      case "refund":
        return queue({ kind: "refund", ...common, ...(s("amount") !== undefined ? { amount: s("amount") } : {}), ...(s("note") ? { note: s("note") } : {}) });
      case "add_tracking":
        return queue({ kind: "tracking", ...common, ...(s("carrier") ? { carrier: s("carrier") } : {}), ...(s("tracking_number") ? { trackingNumber: s("tracking_number") } : {}) });
      case "release_hold":
        return queue({ kind: "release", ...common });
      default:
        dropped.push({ kind: call.name.slice(0, 30), ref: ref || "?", reason: `no tool called ${call.name}` });
        return { ok: false, error: `no tool called ${call.name}` };
    }
  }

  const ledger = input.ledger();
  const messages: ToolChatMessage[] = [
    { role: "system", content: CLOSER_SYSTEM },
    {
      role: "user",
      content: [
        input.instruction.trim() ? `Seller: "${input.instruction.trim().slice(0, 300)}"` : "Seller: plan the whole close-out.",
        `Shop: ${ledger.shopName}. Ledger, one bill per line, amounts in USD:`,
        ledgerDigest(ledger),
      ].join("\n"),
    },
  ];

  try {
    while (turns < limits.turns) {
      if (now() - started > limits.budgetMs) throw new Error("Closer timed out");
      const res = await client.chat({ messages: [...messages], tools: CLOSER_TOOLS, maxTokens: limits.maxTokensPerTurn, signal: ac.signal });
      turns += 1;
      model = res.model || model;
      inputTokens += res.usage?.inputTokens ?? 0;
      outputTokens += res.usage?.outputTokens ?? 0;
      messages.push({ role: "assistant", content: res.text, ...(res.toolCalls.length ? { toolCalls: res.toolCalls } : {}) });
      if (!res.toolCalls.length) {
        modelText = res.text.trim().slice(0, 300) || undefined;
        break;
      }
      for (const call of res.toolCalls) messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(await handle(call)) });
      if (inputTokens + outputTokens >= limits.tokens) {
        stopped = `stopped at the ${limits.tokens}-token cap`;
        break;
      }
      if (turns >= limits.turns) stopped = `stopped at the ${limits.turns}-turn cap`;
    }
  } catch (err) {
    clearTimeout(timer);
    const reason = unavailable(err);
    if (!drafts.length) return rules(reason);
    stopped = `stopped early: ${reason}`;
  }
  clearTimeout(timer);

  return outcome({
    source: "closer",
    ...(stopped ? { label: `Closer ${stopped}; the plan may be incomplete` } : {}),
    ...(modelText ? { modelText } : {}),
    usage: { model, turns, inputTokens, outputTokens, latencyMs: now() - started },
  });
}

