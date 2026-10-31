import path from "node:path";
import { createMockExecutor, createToolkitExecutor } from "@claim/closer";
import type { PaymentsGateway } from "@claim/core";
import { createCloserClient, createEscalationClient, createLlmClient, createTokenBudget, withTokenBudget } from "@claim/llm";
import { MOCK_LABEL, selectGateway } from "./payments";
import { createShowService, type ShowService } from "./service";
import { createFileStore } from "./store";
import type { ViewScope } from "./types";

const g = globalThis as typeof globalThis & { __claimShows?: ShowService };

/** Tokens one server process may send to a paid LLM before it falls back to the rules. Override with LLM_TOKEN_BUDGET. */
const DEFAULT_TOKEN_BUDGET = 300_000;

/** One service per server process; dev HMR re-evaluates modules, so it lives on globalThis. */
export function getService(): ShowService {
  if (!g.__claimShows) {
    // One token allowance for both models, so a public demo cannot run up a pay-per-token bill.
    const budget = createTokenBudget(process.env, { maxTokens: DEFAULT_TOKEN_BUDGET });
    let llm;
    let escalate;
    try {
      llm = withTokenBudget(createLlmClient(process.env), budget);
    } catch {
      llm = undefined;
    }
    try {
      const e = llm ? createEscalationClient(process.env) : undefined;
      escalate = e ? withTokenBudget(e, budget) : undefined;
    } catch {
      escalate = undefined;
    }
    let closerLlm;
    try {
      const c = createCloserClient(process.env);
      closerLlm = c ? withTokenBudget(c, budget) : undefined;
    } catch {
      closerLlm = undefined;
    }
    const gateway = selectGateway(process.env);
    const judgeBuyerEmail = process.env.JUDGE_BUYER_EMAIL?.trim();
    g.__claimShows = createShowService({
      store: createFileStore(process.env.CLAIM_DATA_DIR ?? path.join(process.cwd(), ".data")),
      gateway,
      ...(llm ? { llm } : {}),
      ...(escalate ? { escalate } : {}),
      ...(closerLlm ? { closerLlm } : {}),
      closerExecutor: closerExecutor(gateway.gateway),
      ...(judgeBuyerEmail ? { judgeBuyerEmail } : {}),
    });
  }
  return g.__claimShows;
}

/**
 * Closer runs approved actions through PayPal's Agent Toolkit when the gateway is the real sandbox, reusing
 * the gateway's cached OAuth token; in mock mode it simulates them, and the UI says so.
 */
function closerExecutor(gateway: PaymentsGateway) {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  const sandbox = gateway as PaymentsGateway & { accessToken?: () => Promise<{ token: string }> };
  if (gateway.mode !== "sandbox" || !clientId || !clientSecret) return { executor: createMockExecutor(), label: MOCK_LABEL };
  return {
    executor: createToolkitExecutor({ clientId, clientSecret, ...(sandbox.accessToken ? { accessToken: async () => (await sandbox.accessToken!()).token } : {}) }),
    label: "PayPal sandbox via Agent Toolkit",
  };
}

/**
 * `?scope=seller` asks for the seller view, which adds buyers' ship-to addresses. Buyer rooms never ask
 * for it, so addresses stay out of every buyer's browser. There is no seller login in this demo, so the
 * parameter is a scope, not access control (see the README's limitations).
 */
export function scopeOf(url: string): ViewScope {
  return new URL(url).searchParams.get("scope") === "seller" ? "seller" : "public";
}
