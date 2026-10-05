import { describe, expect, it } from "vitest";
import { PAYPAL_V6_SDK_URL, loadPayPalSdk, setupClaimPass, type PayPalSaveSessionOptions, type PayPalV6 } from "../browser.js";

/** A fake v6 SDK that records the call sequence the official sample makes. */
function fakeSdk(eligible = true) {
  const log: string[] = [];
  let callbacks: PayPalSaveSessionOptions | undefined;
  let started: Promise<{ vaultSetupToken: string }> | undefined;
  const sdk: PayPalV6 = {
    async createInstance(o) {
      log.push(`createInstance ${o.clientToken} ${o.components.join(",")} ${o.pageType}`);
      return {
        async findEligibleMethods(m) {
          log.push(`findEligibleMethods ${m.currencyCode} ${m.paymentFlow}`);
          return { isEligible: (x) => eligible && x === "paypal" };
        },
        createPayPalSavePaymentSession(cb) {
          log.push("createPayPalSavePaymentSession");
          callbacks = cb;
          return {
            async start(opts, p) {
              log.push(`start ${opts.presentationMode}`);
              started = p;
            },
          };
        },
      };
    },
  };
  return { sdk, log, callbacks: () => callbacks!, started: () => started! };
}

describe("setupClaimPass", () => {
  it("follows the sample: instance, VAULT_WITHOUT_PAYMENT eligibility, save session, un-awaited setup token", async () => {
    const f = fakeSdk();
    const approved: string[] = [];
    let resolveToken!: (id: string) => void;
    const pass = await setupClaimPass({
      sdk: f.sdk,
      clientToken: async () => "CT-1",
      createSetupToken: () => new Promise<string>((r) => (resolveToken = r)),
      onApprove: (id) => {
        approved.push(id);
      },
    });
    expect(pass.eligible).toBe(true);
    const startP = pass.start();
    // start() reaches session.start before the setup token resolves (transient activation).
    expect(f.log).toEqual([
      "createInstance CT-1 paypal-payments checkout",
      "findEligibleMethods USD VAULT_WITHOUT_PAYMENT",
      "createPayPalSavePaymentSession",
      "start auto",
    ]);
    resolveToken("ST-9");
    await startP;
    expect(await f.started()).toEqual({ vaultSetupToken: "ST-9" });
    await f.callbacks().onApprove({ vaultSetupToken: "ST-9" });
    expect(approved).toEqual(["ST-9"]);
  });

  it("routes cancel and errors to the callbacks", async () => {
    const f = fakeSdk();
    const seen: unknown[] = [];
    await setupClaimPass({
      sdk: f.sdk,
      clientToken: "CT",
      createSetupToken: async () => "ST",
      onApprove: () => {
        throw new Error("server said no");
      },
      onCancel: (d) => seen.push(["cancel", d]),
      onError: (e) => seen.push(["error", (e as Error).message]),
    });
    f.callbacks().onCancel({ orderId: "x" });
    await f.callbacks().onApprove({ vaultSetupToken: "ST" });
    await f.callbacks().onApprove({});
    expect(seen).toEqual([
      ["cancel", { orderId: "x" }],
      ["error", "server said no"],
      ["error", "onApprove arrived without vaultSetupToken"],
    ]);
  });

  it("reports ineligibility instead of rendering a button", async () => {
    const f = fakeSdk(false);
    const pass = await setupClaimPass({ sdk: f.sdk, clientToken: "CT", createSetupToken: async () => "ST", onApprove: () => {} });
    expect(pass.eligible).toBe(false);
    await expect(pass.start()).rejects.toThrow(/not eligible/);
    expect(f.log).not.toContain("createPayPalSavePaymentSession");
  });

  it("binds a hidden button and unbinds it", async () => {
    const f = fakeSdk();
    const pass = await setupClaimPass({ sdk: f.sdk, clientToken: "CT", createSetupToken: async () => "ST", onApprove: () => {} });
    const listeners: (() => void)[] = [];
    const attrs = new Set(["hidden"]);
    const button = {
      removeAttribute: (a: string) => attrs.delete(a),
      addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_t: string, fn: () => void) => listeners.splice(listeners.indexOf(fn), 1),
    } as unknown as HTMLElement;
    const unbind = pass.bind(button);
    expect(attrs.has("hidden")).toBe(false);
    listeners[0]!();
    expect(f.log.at(-1)).toBe("start auto");
    unbind();
    expect(listeners).toHaveLength(0);
  });
});

describe("loadPayPalSdk", () => {
  it("injects the sandbox v6 core script once and resolves window.paypal", async () => {
    const appended: { src: string; async: boolean; onload: () => void }[] = [];
    const win: { paypal?: PayPalV6 } = {};
    const doc = {
      createElement: () => ({}) as { src: string; async: boolean; onload: () => void },
      head: { appendChild: (s: { src: string; async: boolean; onload: () => void }) => appended.push(s) },
    } as unknown as Document;
    const a = loadPayPalSdk({ doc, win });
    const b = loadPayPalSdk({ doc, win });
    expect(appended).toHaveLength(1);
    expect(appended[0]!.src).toBe(PAYPAL_V6_SDK_URL.sandbox);
    expect(appended[0]!.async).toBe(true);
    win.paypal = fakeSdk().sdk;
    appended[0]!.onload();
    expect(await a).toBe(win.paypal);
    expect(await b).toBe(win.paypal);
    expect(await loadPayPalSdk({ doc, win })).toBe(win.paypal);
  });
});
