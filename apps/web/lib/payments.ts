import type { PaymentsGateway } from "@claim/core";
import { createGateway } from "@claim/paypal";

type Env = Record<string, string | undefined>;

export const MOCK_LABEL = "Sandbox not connected: simulated payments";

/** Setup tokens created with this prefix vault a card that declines at close-out (mock mode only). */
export const DECLINE_PREFIX = "DECLINE-";

/**
 * PayPal sandbox when PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set, else @claim/paypal's mock,
 * which the UI labels as simulated. The mock is seeded per process so ids never repeat across restarts.
 */
export function selectGateway(env: Env = process.env): { gateway: PaymentsGateway; label: string } {
  const gateway = createGateway(env, {
    mock: {
      seed: `claim-web-${Date.now().toString(36)}`,
      decline: (call) => (call.op === "chargeVaulted" && call.buyerKey?.startsWith(DECLINE_PREFIX) ? "INSTRUMENT_DECLINED" : undefined),
    },
  });
  return { gateway, label: gateway.mode === "sandbox" ? "PayPal sandbox" : MOCK_LABEL };
}
