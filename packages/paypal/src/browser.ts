/**
 * Claim Pass in the browser: PayPal JS SDK v6, save-without-purchase. Framework-free.
 *
 * UNTESTED-IN-SANDBOX. Mirrors paypal-examples/v6-web-sdk-sample-integration
 * client/components/paypalPayments/savePayment/html/src/app.js (read 2026-10-05):
 * createInstance({ clientToken, components: ["paypal-payments"], pageType: "checkout" }) ->
 * findEligibleMethods({ currencyCode, paymentFlow: "VAULT_WITHOUT_PAYMENT" }) -> isEligible("paypal") ->
 * createPayPalSavePaymentSession({ onApprove, onCancel, onError }) -> on click,
 * session.start({ presentationMode: "auto" }, createVaultSetupTokenPromise) without awaiting the token.
 *
 * The sample resolves that promise to { vaultSetupToken: id }; PayPal's docs page shows { setupToken: id }.
 * This follows the sample. No PayPal call has been made from this code.
 */

export const PAYPAL_V6_SDK_URL = {
  sandbox: "https://www.sandbox.paypal.com/web-sdk/v6/core",
  live: "https://www.paypal.com/web-sdk/v6/core",
} as const;

export type PayPalEnv = keyof typeof PAYPAL_V6_SDK_URL;

export interface PayPalSaveApproveData {
  vaultSetupToken?: string;
  [k: string]: unknown;
}

export interface PayPalSaveSessionOptions {
  onApprove(data: PayPalSaveApproveData): void | Promise<void>;
  onCancel(data: unknown): void;
  onError(error: unknown): void;
}

export interface PayPalSaveSession {
  start(options: { presentationMode: string }, setupToken: Promise<{ vaultSetupToken: string }>): Promise<void>;
}

export interface PayPalSdkInstance {
  findEligibleMethods(options: { currencyCode: string; paymentFlow: string }): Promise<{ isEligible(method: string): boolean }>;
  createPayPalSavePaymentSession(options: PayPalSaveSessionOptions): PayPalSaveSession;
}

export interface PayPalV6 {
  createInstance(options: { clientToken: string; components: string[]; pageType?: string }): Promise<PayPalSdkInstance>;
}

type PayPalWindow = { paypal?: PayPalV6 };

interface LoadOptions {
  env?: PayPalEnv;
  doc?: Document;
  win?: PayPalWindow;
}

const loading = new Map<string, Promise<PayPalV6>>();

/** Injects the v6 core script once and resolves window.paypal. */
export function loadPayPalSdk(opts: LoadOptions = {}): Promise<PayPalV6> {
  const win = opts.win ?? (globalThis as unknown as PayPalWindow);
  if (win.paypal?.createInstance) return Promise.resolve(win.paypal);
  const doc = opts.doc ?? globalThis.document;
  const src = PAYPAL_V6_SDK_URL[opts.env ?? "sandbox"];
  const pending = loading.get(src);
  if (pending) return pending;
  const p = new Promise<PayPalV6>((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => (win.paypal?.createInstance ? resolve(win.paypal) : reject(new Error("PayPal v6 SDK loaded without window.paypal")));
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    doc.head.appendChild(script);
  });
  loading.set(src, p);
  p.catch(() => loading.delete(src));
  return p;
}

export interface ClaimPassOptions {
  /** A browser-safe client token from the server (gateway.clientToken()), or a function that fetches one. */
  clientToken: string | (() => Promise<string>);
  /** Calls your server, which calls gateway.createSetupToken(); resolves the setup token id. */
  createSetupToken: () => Promise<string>;
  /** The buyer approved; send the setup token id to your server for gateway.createPaymentToken(). */
  onApprove: (setupTokenId: string, data: PayPalSaveApproveData) => void | Promise<void>;
  onCancel?: (data: unknown) => void;
  onError?: (error: unknown) => void;
  env?: PayPalEnv;
  currencyCode?: string;
  presentationMode?: string;
  /** An already-loaded SDK (tests, or a page that loaded the script itself). */
  sdk?: PayPalV6;
  doc?: Document;
  win?: PayPalWindow;
}

export interface ClaimPass {
  /** False when PayPal does not offer VAULT_WITHOUT_PAYMENT for this merchant/buyer; offer pay-now instead. */
  eligible: boolean;
  /** Call directly inside a click handler: the setup token request is not awaited before start(). */
  start(): Promise<void>;
  /** Un-hides the button and wires its click to start(); returns an unbind function. */
  bind(button: HTMLElement): () => void;
}

export async function setupClaimPass(opts: ClaimPassOptions): Promise<ClaimPass> {
  const clientToken = typeof opts.clientToken === "string" ? opts.clientToken : await opts.clientToken();
  const paypal =
    opts.sdk ??
    (await loadPayPalSdk({
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.doc ? { doc: opts.doc } : {}),
      ...(opts.win ? { win: opts.win } : {}),
    }));
  const sdkInstance = await paypal.createInstance({ clientToken, components: ["paypal-payments"], pageType: "checkout" });
  const methods = await sdkInstance.findEligibleMethods({
    currencyCode: opts.currencyCode ?? "USD",
    paymentFlow: "VAULT_WITHOUT_PAYMENT",
  });
  const onError = opts.onError ?? ((e: unknown) => console.error(e));

  if (!methods.isEligible("paypal")) {
    return {
      eligible: false,
      start: () => Promise.reject(new Error("PayPal save-without-purchase is not eligible for this session")),
      bind: () => () => {},
    };
  }

  const session = sdkInstance.createPayPalSavePaymentSession({
    async onApprove(data) {
      const id = data.vaultSetupToken;
      if (!id) return onError(new Error("onApprove arrived without vaultSetupToken"));
      try {
        await opts.onApprove(id, data);
      } catch (e) {
        onError(e);
      }
    },
    onCancel(data) {
      opts.onCancel?.(data);
    },
    onError,
  });

  const start = () => {
    const setupToken = opts.createSetupToken().then((id) => ({ vaultSetupToken: id }));
    return session.start({ presentationMode: opts.presentationMode ?? "auto" }, setupToken);
  };

  return {
    eligible: true,
    start,
    bind(button) {
      const onClick = () => {
        start().catch(onError);
      };
      button.removeAttribute("hidden");
      button.addEventListener("click", onClick);
      return () => button.removeEventListener("click", onClick);
    },
  };
}
