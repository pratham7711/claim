import type { PaymentsGateway } from "@claim/core";
import type { FetchLike } from "./http.js";
import { createMockGateway, type MockGatewayOptions } from "./mock.js";
import { createSandboxGateway } from "./sandbox.js";

export type GatewayEnv = Record<string, string | undefined>;

/**
 * Sandbox when PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set, else the mock.
 * PAYPAL_GATEWAY=mock forces the mock; PAYPAL_STORED_CREDENTIAL=false drops stored_credential.
 */
export function createGateway(
  env: GatewayEnv = (globalThis as { process?: { env?: GatewayEnv } }).process?.env ?? {},
  extra: { fetchImpl?: FetchLike; mock?: MockGatewayOptions } = {},
): PaymentsGateway {
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (env.PAYPAL_GATEWAY?.trim().toLowerCase() === "mock" || !clientId || !clientSecret) {
    return createMockGateway(extra.mock);
  }
  const webhookId = env.PAYPAL_WEBHOOK_ID?.trim();
  const baseUrl = env.PAYPAL_BASE_URL?.trim();
  return createSandboxGateway({
    clientId,
    clientSecret,
    ...(webhookId ? { webhookId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    storedCredential: !/^(0|false|off|no)$/i.test(env.PAYPAL_STORED_CREDENTIAL?.trim() ?? ""),
    ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
  });
}
