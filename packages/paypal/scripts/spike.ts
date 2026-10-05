/**
 * Claim! PayPal sandbox spike: the Day-0/Day-1 checks from final-build §4.4, riskiest first.
 * Refuses to run without sandbox credentials. Run from the repo root:
 *
 *   npx tsx packages/paypal/scripts/spike.ts
 *
 * Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (and optional PAYPAL_WEBHOOK_ID) from the environment,
 * or from the repo-root .env. See packages/paypal/README.md for the sandbox setup it expects.
 */
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CartChargeInput, ChargeResult } from "@claim/core";
import { PayPalError, WEBHOOK_EVENTS, createSandboxGateway, type SandboxGateway } from "../src/index.js";

type Verdict = "PASS" | "FAIL" | "SKIP";
interface StepResult {
  n: number;
  name: string;
  verdict: Verdict;
  note: string;
  debugId?: string;
}

const results: StepResult[] = [];

function record(name: string, verdict: Verdict, note: string, debugId?: string): void {
  const r: StepResult = { n: results.length + 1, name, verdict, note, ...(debugId ? { debugId } : {}) };
  results.push(r);
  console.log(`${verdict.padEnd(4)} ${String(r.n).padStart(2)} ${name.padEnd(28)} ${note}${debugId ? `  [debug_id ${debugId}]` : ""}`);
}

/** Runs one step; `judge` returns true for PASS or a reason string for FAIL. Never throws. */
async function step<T>(name: string, run: () => Promise<T>, judge: (v: T) => true | string, describe: (v: T) => string, debugOf?: (v: T) => string | undefined): Promise<T | undefined> {
  try {
    const v = await run();
    const verdict = judge(v);
    record(name, verdict === true ? "PASS" : "FAIL", verdict === true ? describe(v) : `${verdict} | ${describe(v)}`, debugOf?.(v));
    return v;
  } catch (e) {
    if (e instanceof PayPalError) record(name, "FAIL", `${e.status} ${e.errorName}${e.issue ? ` ${e.issue}` : ""}: ${e.message}`, e.debugId);
    else record(name, "FAIL", String((e as Error)?.stack ?? e));
    return undefined;
  }
}

function loadEnv(): void {
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) return;
  const file = process.env.SPIKE_ENV_FILE ?? join(dirname(fileURLToPath(import.meta.url)), "../../../.env");
  if (existsSync(file)) process.loadEnvFile(file);
}

loadEnv();
const env = process.env;
const clientId = env.PAYPAL_CLIENT_ID?.trim();
const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error(
    [
      "REFUSING TO RUN: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set.",
      "This spike only talks to the PayPal SANDBOX and needs your sandbox app's credentials.",
      "Set them in the repo-root .env (see .env.example) or the environment, then re-run.",
      "Setup steps: packages/paypal/README.md#sandbox-setup",
    ].join("\n"),
  );
  process.exit(2);
}

// 3011 is the web dev server's port; the spike page stays off it so both can run.
const port = Number(env.SPIKE_PORT ?? 3012);
const origin = `http://localhost:${port}`;
const waitMs = Number(env.SPIKE_WAIT_MS ?? 15 * 60_000);
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const webhookId = env.PAYPAL_WEBHOOK_ID?.trim();
const base = { clientId, clientSecret, ...(webhookId ? { webhookId } : {}), brandName: "Claim! spike", setupDescription: "Claim Pass spike: pay for live-show claims after the show" };
const gw = createSandboxGateway({ ...base, storedCredential: true });
const plain = createSandboxGateway({ ...base, storedCredential: false });
const declining = createSandboxGateway({ ...base, storedCredential: false, mockResponse: (c) => (c.op === "chargeVaulted" ? "INSTRUMENT_DECLINED" : undefined) });

function spikeCart(tag: string, cents = 1234): CartChargeInput {
  const invoiceId = `claim-spike-${stamp}-${tag}`;
  return {
    invoiceId,
    requestId: invoiceId,
    currency: "USD",
    lines: [{ name: `#1 Spike tee (${tag})`, sku: `SPIKE-${tag}`, qty: 1, unitCents: cents }],
    shippingCents: 500,
    totalCents: cents + 500,
    customId: "spike:buyer",
  };
}

const describeCharge = (r: ChargeResult) =>
  `status=${r.status} order=${r.orderId || "-"} capture=${r.captureId ?? "-"}${r.declineCode ? ` code=${r.declineCode}` : ""}`;
const completed = (r: ChargeResult) => (r.status === "COMPLETED" && !!r.captureId ? true : "expected COMPLETED with a capture id");

// ---------- local page for the v6 save session (mirrors the official sample) ----------

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><title>Claim! spike: save PayPal (v6)</title>
<meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 3rem auto">
<h1>Claim Pass spike</h1>
<p id="status">Loading the PayPal v6 SDK...</p>
<paypal-button id="paypal-button" hidden></paypal-button>
<script>
function say(t) { document.getElementById("status").textContent = t; }
function report(kind, data) {
  return fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, data }) });
}
async function onPayPalWebSdkLoaded() {
  try {
    const { accessToken } = await (await fetch("/client-token")).json();
    const sdkInstance = await window.paypal.createInstance({ clientToken: accessToken, components: ["paypal-payments"], pageType: "checkout" });
    const paymentMethods = await sdkInstance.findEligibleMethods({ currencyCode: "USD", paymentFlow: "VAULT_WITHOUT_PAYMENT" });
    const eligible = paymentMethods.isEligible("paypal");
    await report("eligibility", { eligible });
    if (!eligible) { say("PayPal is NOT eligible for VAULT_WITHOUT_PAYMENT. Use the redirect link in the terminal."); return; }
    const session = sdkInstance.createPayPalSavePaymentSession({
      async onApprove(data) { say("Approved. Back to the terminal."); await report("approved", data); },
      onCancel(data) { say("Cancelled. Click again to retry."); report("cancel", data); },
      onError(error) { say("onError: " + error); report("error", String(error)); },
    });
    const button = document.querySelector("#paypal-button");
    button.removeAttribute("hidden");
    say("Click the PayPal button and log in with the US sandbox PERSONAL account.");
    button.addEventListener("click", async () => {
      try {
        // Not awaited before start(), as in the sample (transient activation).
        const createVaultSetupTokenPromise = fetch("/setup-token", { method: "POST" })
          .then((r) => r.json())
          .then(({ id }) => ({ vaultSetupToken: id }));
        await session.start({ presentationMode: "auto" }, createVaultSetupTokenPromise);
      } catch (e) { say("start failed: " + e); report("error", String(e)); }
    });
  } catch (e) { say("Setup failed: " + (e && e.message ? e.message : e)); report("error", String(e && e.message ? e.message : e)); }
}
</script>
<script async src="https://www.sandbox.paypal.com/web-sdk/v6/core" onload="onPayPalWebSdkLoaded()"></script>
</body></html>`;

interface Approval {
  setupTokenId: string;
  via: string;
}

async function startPageServer(redirectSetupTokenId: string | undefined, onApproval: (a: Approval) => void, onReport: (kind: string, data: unknown) => void) {
  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { "Content-Type": type });
    res.end(body);
  };
  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", origin);
    try {
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html", PAGE);
      if (req.method === "GET" && url.pathname === "/client-token") return send(res, 200, "application/json", JSON.stringify({ accessToken: await gw.clientToken() }));
      if (req.method === "POST" && url.pathname === "/setup-token") {
        const d = await gw.createSetupTokenDetailed({ buyerKey: "spike:v6", returnUrl: `${origin}/return`, cancelUrl: `${origin}/cancel` });
        console.log(`     v6 page created setup token ${d.setupTokenId} (status ${d.status})`);
        return send(res, 200, "application/json", JSON.stringify({ id: d.setupTokenId }));
      }
      if (req.method === "POST" && url.pathname === "/report") {
        const body = (await readJson(req)) as { kind?: string; data?: unknown } | undefined;
        onReport(body?.kind ?? "unknown", body?.data);
        if (body?.kind === "approved") {
          const id = (body.data as { vaultSetupToken?: string } | undefined)?.vaultSetupToken;
          if (id) onApproval({ setupTokenId: id, via: "v6 save session (onApprove.vaultSetupToken)" });
        }
        return send(res, 204, "text/plain", "");
      }
      if (url.pathname === "/return") {
        const id = url.searchParams.get("approval_token_id") ?? redirectSetupTokenId;
        if (id) onApproval({ setupTokenId: id, via: `redirect return_url (${url.search || "no query"})` });
        return send(res, 200, "text/plain", "Approved via redirect. Back to the terminal.");
      }
      if (url.pathname === "/cancel") {
        onReport("cancel", Object.fromEntries(url.searchParams));
        return send(res, 200, "text/plain", "Cancelled. Re-open the approval link to retry.");
      }
      send(res, 404, "text/plain", "not found");
    } catch (e) {
      const msg = e instanceof PayPalError ? `${e.errorName} ${e.issue ?? ""} debug_id ${e.debugId ?? "-"}` : String(e);
      console.log(`     page server error: ${msg}`);
      send(res, 500, "application/json", JSON.stringify({ error: msg }));
    }
  };
  // Loopback only, on both stacks, because browsers may resolve "localhost" to ::1 first.
  const listen = (host: string) =>
    new Promise<ReturnType<typeof createServer> | undefined>((resolve) => {
      const server = createServer(handler);
      server.once("error", () => resolve(undefined));
      server.listen(port, host, () => resolve(server));
    });
  const servers = (await Promise.all(["127.0.0.1", "::1"].map(listen))).filter((s) => s !== undefined);
  if (servers.length === 0) {
    console.log(`     could not listen on ${origin}; set SPIKE_PORT. Continuing with the redirect link + polling only.`);
    return undefined;
  }
  return { close: () => servers.forEach((s) => s.close()) };
}

async function waitForApproval(setup: { setupTokenId: string; approveUrl?: string }): Promise<Approval | undefined> {
  let done: (a: Approval | undefined) => void = () => {};
  const approved = new Promise<Approval | undefined>((r) => (done = r));
  let eligibility: boolean | undefined;
  const server = await startPageServer(setup.setupTokenId, (a) => done(a), (kind, data) => {
    if (kind === "eligibility") {
      eligibility = !!(data as { eligible?: boolean } | undefined)?.eligible;
      record("v6 VAULT_WITHOUT_PAYMENT", eligibility ? "PASS" : "FAIL", eligibility ? "findEligibleMethods: paypal eligible" : "paypal NOT eligible for VAULT_WITHOUT_PAYMENT on this app");
    } else if (kind === "error" || kind === "cancel") {
      console.log(`     page reported ${kind}: ${JSON.stringify(data)}`);
    }
  });

  console.log("");
  console.log("  ACTION NEEDED: approve the Claim Pass as the US sandbox PERSONAL (buyer) account, either way:");
  if (server) console.log(`    (a) the product path, v6 popup:  open ${origin}/  and click the PayPal button`);
  if (setup.approveUrl) console.log(`    (b) the redirect link:           ${setup.approveUrl}`);
  console.log(`  Waiting up to ${waitMs >= 60000 ? `${Math.round(waitMs / 60000)} min` : `${Math.round(waitMs / 1000)} s`}. (Re-run later with SPIKE_SETUP_TOKEN=<id> or SPIKE_VAULT_ID=<id> to skip this.)`);
  console.log("");

  const poll = setInterval(async () => {
    try {
      const s = await gw.getSetupToken(setup.setupTokenId);
      if (s.status === "APPROVED" || s.status === "VAULTED") done({ setupTokenId: setup.setupTokenId, via: `polling GET setup-token (status ${s.status})` });
    } catch {
      // Transient; keep polling.
    }
  }, 5000);
  const timer = setTimeout(() => done(undefined), waitMs);
  const result = await approved;
  clearInterval(poll);
  clearTimeout(timer);
  server?.close();
  if (eligibility === undefined) record("v6 VAULT_WITHOUT_PAYMENT", "SKIP", "the v6 page was not opened; eligibility not measured");
  return result;
}

// ---------- the spike ----------

async function main(): Promise<void> {
  console.log(`Claim! PayPal sandbox spike ${stamp}. Sandbox only; every amount is test money.\n`);

  await step(
    "oauth token",
    () => gw.accessToken(true),
    (t) => (/vault\/payment-tokens/.test(t.scope) ? true : "token scope lacks vault/payment-tokens: tick Vault under the app's Accept payments > Advanced options"),
    (t) => `app_id=${t.appId ?? "-"} vault scope=${/vault\/payment-tokens/.test(t.scope) ? "yes" : "NO"} invoicing scope=${/invoicing/.test(t.scope) ? "yes" : "no"}`,
  );

  await step("v6 client token", () => gw.clientToken(), (t) => (t.length > 20 ? true : "suspiciously short client token"), (t) => `received ${t.length} chars`);

  let vaultId = env.SPIKE_VAULT_ID?.trim();
  if (vaultId) {
    record("setup token", "SKIP", `SPIKE_VAULT_ID=${vaultId} given`);
  } else {
    let setupTokenId = env.SPIKE_SETUP_TOKEN?.trim();
    if (setupTokenId) {
      record("setup token", "SKIP", `SPIKE_SETUP_TOKEN=${setupTokenId} given`);
    } else {
      const setup = await step(
        "setup token",
        () => gw.createSetupTokenDetailed({ buyerKey: "spike:buyer", returnUrl: `${origin}/return`, cancelUrl: `${origin}/cancel` }),
        (s) => (s.approveUrl ? true : "no approve link in the response"),
        (s) => `id=${s.setupTokenId} status=${s.status} customer=${s.customerId ?? "-"}`,
      );
      const approval = setup ? await waitForApproval(setup) : undefined;
      if (!setup) {
        record("buyer approval", "SKIP", "no setup token to approve");
      } else if (!approval) {
        record("buyer approval", "FAIL", "no approval within the wait window");
      } else {
        record("buyer approval", "PASS", `setup token ${approval.setupTokenId} via ${approval.via}`);
        setupTokenId = approval.setupTokenId;
      }
    }
    if (setupTokenId) {
      const token = await step(
        "payment token (vault id)",
        () => gw.createPaymentToken(setupTokenId!),
        (t) => (t.vaultId ? true : "no vault id"),
        (t) => `vault_id=${t.vaultId} customer=${t.customerId || "-"}  (re-run with SPIKE_VAULT_ID=${t.vaultId})`,
      );
      vaultId = token?.vaultId;
    }
  }

  if (!vaultId) {
    for (const name of ["vault_id order", "vault_id + stored_credential", "idempotent replay", "duplicate invoice_id", "decline mock", "pay-now after decline", "refund", "tracking", "MIT shipping address"]) {
      record(name, "SKIP", "no vault id");
    }
  } else {
    const a = spikeCart("A");
    const plainCharge = await step("vault_id order", () => plain.chargeVaulted(vaultId!, a), completed, describeCharge, (r) => r.debugId);

    const b = spikeCart("B");
    const sc = await step("vault_id + stored_credential", () => gw.chargeVaulted(vaultId!, b), completed, describeCharge, (r) => r.debugId);

    await step(
      "idempotent replay",
      () => gw.chargeVaulted(vaultId!, b),
      (r) => (sc && r.orderId === sc.orderId ? true : "same PayPal-Request-Id returned a different order"),
      describeCharge,
      (r) => r.debugId,
    );

    await step(
      "duplicate invoice_id",
      async () => {
        try {
          return { result: await plain.chargeVaulted(vaultId!, { ...a, requestId: `${a.requestId}-again` }) } as { result?: ChargeResult; err?: PayPalError };
        } catch (e) {
          if (e instanceof PayPalError) return { err: e };
          throw e;
        }
      },
      (o) => (o.err?.issue === "DUPLICATE_INVOICE_ID" ? true : "PayPal did not refuse a reused invoice_id; turn on blocking of duplicate invoice IDs for the sandbox business account"),
      (o) => (o.err ? `${o.err.status} ${o.err.issue ?? o.err.errorName}` : describeCharge(o.result!)),
      (o) => o.err?.debugId ?? o.result?.debugId,
    );

    const c = spikeCart("C", 777);
    await step(
      "decline mock",
      () => declining.chargeVaulted(vaultId!, c),
      (r) => (r.status === "DECLINED" && r.declineCode === "INSTRUMENT_DECLINED" ? true : "expected DECLINED/INSTRUMENT_DECLINED; is Negative Testing ON for the business account?"),
      describeCharge,
      (r) => r.debugId,
    );

    await step(
      "pay-now after decline",
      () => plain.createPayNowOrder(c, { returnUrl: `${origin}/return`, cancelUrl: `${origin}/cancel` }),
      (o) => (o.approveUrl ? true : "no approval link"),
      (o) => `order=${o.orderId} (same invoice_id as the declined charge) approve=${o.approveUrl}`,
    );

    const cap = plainCharge?.captureId ?? sc?.captureId;
    const ord = plainCharge?.captureId ? plainCharge.orderId : sc?.orderId;
    if (cap && ord) {
      const refundRequestId = `spike-${stamp}-refund`;
      const refund = await step("refund", () => gw.refundCapture(cap, 100, "Claim! spike partial refund", refundRequestId), (r) => (r.status === "COMPLETED" || r.status === "PENDING" ? true : `refund status ${r.status}`), (r) => `refund=${r.refundId} status=${r.status}`);
      await step("refund replay", () => gw.refundCapture(cap, 100, "Claim! spike partial refund", refundRequestId), (r) => (refund && r.refundId === refund.refundId ? true : "same PayPal-Request-Id issued a second refund"), (r) => `refund=${r.refundId}`);
      await step("tracking", () => gw.addTracking({ orderId: ord, captureId: cap, trackingNumber: `SPIKE${stamp}`, carrier: "USPS", notifyPayer: false }), () => true, (t) => `tracker=${t.trackerId}`);
      await step(
        "MIT shipping address",
        () => gw.getOrder(ord),
        (o) => (shippingOf(o) ? true : "no purchase_units[0].shipping.address on the merchant-initiated order"),
        (o) => `shipping=${JSON.stringify(shippingOf(o) ?? null)}`,
      );
    } else {
      for (const name of ["refund", "tracking", "MIT shipping address"]) record(name, "SKIP", "no completed capture to act on");
    }

    if (env.SPIKE_DELETE_VAULT === "1") {
      await step("delete vault token", () => gw.deletePaymentToken(vaultId!), () => true, () => `deleted ${vaultId}`);
    }
  }

  await webhookStep(gw);
  summary();
}

function shippingOf(o: unknown): unknown {
  return (o as { purchase_units?: { shipping?: { address?: unknown } }[] }).purchase_units?.[0]?.shipping?.address;
}

async function webhookStep(g: SandboxGateway): Promise<void> {
  const url = env.SPIKE_WEBHOOK_URL?.trim();
  if (url) {
    await step("register webhook", () => g.registerWebhook(url), () => true, (w) => `webhook id=${w.id}; set PAYPAL_WEBHOOK_ID=${w.id}`);
    return;
  }
  if (webhookId) {
    await step(
      "webhook configured",
      () => g.listWebhooks(),
      (list) => (list.some((w) => w.id === webhookId) ? true : `PAYPAL_WEBHOOK_ID=${webhookId} is not one of this app's webhooks`),
      (list) => list.map((w) => `${w.id} -> ${w.url} (${w.events.length} events)`).join("; ") || "none",
    );
    return;
  }
  record("webhook", "SKIP", "no PAYPAL_WEBHOOK_ID / SPIKE_WEBHOOK_URL");
  console.log(
    [
      "     To register one (needs a public HTTPS URL on port 443; localhost will not receive deliveries):",
      "       dashboard: Apps & Credentials > your app > Sandbox Webhooks > Add Webhook, or",
      "       SPIKE_WEBHOOK_URL=https://<your-host>/api/paypal/webhook npx tsx packages/paypal/scripts/spike.ts",
      `     Events: ${WEBHOOK_EVENTS.join(", ")}`,
      "     Then put the webhook id in PAYPAL_WEBHOOK_ID. Spike 2 (real delivery + verify) runs on the deployed listener.",
    ].join("\n"),
  );
}

function summary(): void {
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  console.log(`\nSUMMARY  PASS ${count("PASS")}  FAIL ${count("FAIL")}  SKIP ${count("SKIP")}`);
  for (const r of results.filter((x) => x.verdict === "FAIL")) console.log(`  FAIL ${r.name}${r.debugId ? ` [debug_id ${r.debugId}]` : ""}: ${r.note}`);
  process.exitCode = count("FAIL") ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
