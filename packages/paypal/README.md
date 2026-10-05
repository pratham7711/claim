# @claim/paypal

The `PaymentsGateway` from `@claim/core` (contract.ts), implemented three ways:

| Factory | When | Talks to |
|---|---|---|
| `createGateway(env)` | the app's entry point | sandbox if `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set, otherwise the mock |
| `createSandboxGateway(opts)` | real PayPal sandbox | `https://api-m.sandbox.paypal.com` (it refuses any other host unless `allowNonSandboxBaseUrl`) |
| `createMockGateway(opts)` | demos, tests, no credentials | in memory, deterministic |

It has no runtime dependencies beyond `fetch`. The browser half lives at `@claim/paypal/browser`.

**Status:** everything is unit-tested against a fake `fetch` and checked against PayPal's published
OpenAPI specs. **None of it has run against a real PayPal sandbox yet.** The spike below is what
settles that.

## Server usage

```ts
import { createGateway, toChargeInput, isPayPalError } from "@claim/paypal";

const pay = createGateway(process.env);           // .mode is "sandbox" or "mock"

// Claim Pass (save PayPal without a purchase)
const { setupTokenId } = await pay.createSetupToken({ buyerKey, returnUrl, cancelUrl });
// ...the buyer approves in the browser...
const { vaultId } = await pay.createPaymentToken(setupTokenId);

// End show: merchant-initiated charge, buyer not present
const r = await pay.chargeVaulted(vaultId, toChargeInput(cart));
// r.status: COMPLETED | DECLINED (r.declineCode) | PAYER_ACTION_REQUIRED | PENDING
```

What the gateway does, and why:

- **Idempotency.**
  - `chargeVaulted` sends `PayPal-Request-Id: cart.requestId`, so a retried close-out returns the
    same order instead of charging twice. PayPal keeps these keys for about 6 h.
  - Pay-now uses `${requestId}-paynow`, so it never replays a declined vault charge.
  - Setup tokens, payment tokens, captures and refunds get a fresh id per call, which is reused
    across that call's retries.
- **Retries.** Only calls that are idempotent-safe are retried: anything carrying a request id,
  GETs, DELETE, tracking and webhook verification. They retry on network errors, timeouts, 408/429/5xx and
  `409 PREVIOUS_REQUEST_IN_PROGRESS`. A 401 refreshes the OAuth token once. Webhook registration
  is never retried.
- **Declines are results, not throws.**
  - A 422 carrying a decline issue (`INSTRUMENT_DECLINED`, `TRANSACTION_REFUSED`, ... see
    `DECLINE_ISSUES`) becomes `{ status: "DECLINED", declineCode, orderId: "" }`.
  - `PAYER_ACTION_REQUIRED` / `ORDER_NOT_APPROVED` become `PAYER_ACTION_REQUIRED`.
  - Everything else throws `PayPalError` with `status`, `errorName`, `issue`, `details` and
    `debugId`. That includes `DUPLICATE_INVOICE_ID`, which means this cart was already paid; do
    not retry it.
- **Money.** Integer cents in, PayPal decimal strings out (`1999` becomes `"19.99"`), using string
  arithmetic with no floats. Every cart is validated before sending: total = items + shipping,
  quantities are positive integers, and length limits are enforced.
- **Order shape.**
  - One purchase unit: `invoice_id`, `custom_id`, `amount.breakdown{item_total, shipping}`, and
    items with `category: PHYSICAL_GOODS`.
  - With `storedCredential` on (the default), the vault order carries
    `stored_credential{payment_initiator: MERCHANT, usage: SUBSEQUENT}`.
    `PAYPAL_STORED_CREDENTIAL=false` drops it.
- **Webhooks.** `verifyWebhook(headers, rawBody)` posts to
  `/v1/notifications/verify-webhook-signature`, splicing in the raw body verbatim so
  re-serialisation cannot break the signature. It returns `false` on a bad signature or malformed
  input, and throws on a PayPal outage, so the caller answers 5xx and PayPal redelivers. Pass the
  raw request body, not parsed JSON.
- **Negative testing.** `createSandboxGateway({ mockResponse: "INSTRUMENT_DECLINED" })` (or a
  function of the call) sets `PayPal-Mock-Response` on the orders and refund calls.

Beyond the contract, the sandbox gateway also offers:
- `accessToken()`
- `createSetupTokenDetailed()` (includes the redirect `approveUrl`)
- `getSetupToken()`
- `getOrder()`
- `listWebhooks()`
- `registerWebhook()`

## Browser usage (Claim Pass button), UNTESTED IN SANDBOX

```ts
import { setupClaimPass } from "@claim/paypal/browser";

const pass = await setupClaimPass({
  clientToken: () => fetch("/api/paypal/client-token").then((r) => r.json()).then((j) => j.clientToken),
  createSetupToken: () => fetch("/api/paypal/setup-token", { method: "POST" }).then((r) => r.json()).then((j) => j.id),
  onApprove: (setupTokenId) => fetch("/api/paypal/payment-token", { method: "POST", body: JSON.stringify({ setupTokenId }) }),
  onCancel: () => {},
  onError: (e) => console.error(e),
});
if (pass.eligible) pass.bind(document.querySelector("paypal-button")!);   // else offer pay-now
```

It follows PayPal's official v6 sample (`save-payment/paypal` → `html/src/v6/vault/...`):
1. `createInstance({ components: ["paypal-payments"] })`
2. `findEligibleMethods({ paymentFlow: "VAULT_WITHOUT_PAYMENT" })`
3. `createPayPalSavePaymentSession`
4. `session.start({ presentationMode: "auto" }, setupTokenPromise)`. The promise is **not**
   awaited first, because the popup needs the click's transient activation.

Notes for the web app:
- In mock mode, skip the SDK and call the server routes directly. `createGateway({}).createSetupToken`
  auto-approves.
- Next.js may need `transpilePackages: ["@claim/paypal"]`, because the package ships TypeScript
  source.

## Environment

| Var | Required | Meaning |
|---|---|---|
| `PAYPAL_CLIENT_ID` | for sandbox | REST app client id (Sandbox tab) |
| `PAYPAL_CLIENT_SECRET` | for sandbox | REST app secret (Sandbox tab) |
| `PAYPAL_WEBHOOK_ID` | for `verifyWebhook` | id of the webhook registered on that app |
| `PAYPAL_STORED_CREDENTIAL` | no | `false` / `0` / `off` drops `stored_credential` from vault orders |
| `PAYPAL_GATEWAY` | no | `mock` forces the mock even when credentials are set |
| `PAYPAL_BASE_URL` | no | defaults to the sandbox; a live host is refused |

## Mock gateway

`createMockGateway({ seed, declineBuyerKeys, declineCode, decline, autoApprove, webhookId })`:

- **Ids.** Deterministic and PayPal-shaped:
  - 17-char uppercase order, capture, setup and refund ids;
  - 7-char lowercase vault ids;
  - `customer_##########` customer ids;
  - 13-hex debug ids.
- **Declines.** Buyers listed in `declineBuyerKeys` decline with `INSTRUMENT_DECLINED` (or
  `declineCode`), and `decline(call)` can script any issue.
- **Idempotency.** The same `requestId` returns the same order, including a replayed decline.
- **Duplicate invoices.** A completed capture consumes the `invoiceId`, and a second charge for it
  throws `DUPLICATE_INVOICE_ID`. A decline does not consume it, so pay-now can follow.
- **Other errors:**
  - unknown or deleted vault → 404;
  - capturing twice → `ORDER_ALREADY_CAPTURED`;
  - over-refunding → `REFUND_AMOUNT_EXCEEDED`;
  - tracking is idempotent.
- **Webhooks.** `signWebhook(rawBody)` returns headers that the mock's `verifyWebhook` accepts.

## Sandbox setup

You do this once, by hand, on developer.paypal.com. Nothing here signs up for anything.

1. **Developer account.** Sign in at <https://developer.paypal.com>. If the existing account is
   held for KYC and the dashboard will not load, use a separate developer login. Sandbox accounts
   are free and not KYC-gated.
2. **Sandbox accounts.** Go to **Testing Tools → Sandbox Accounts → Create account** and create:
   - one **Business** account, country **United States** (the merchant);
   - one **Personal** account, country **United States** (the buyer; note its email and password).

   Claim! targets US boutiques, and vault availability is country-specific.
3. **App.** Go to **Apps & Credentials → Sandbox → Create App** (type: Merchant), with the US
   Business account as the sandbox account. Copy the **Client ID** and **Secret**.
4. **Vault.** In the app, under **Features → Accept payments**, open **Advanced options** and tick
   **Vault** (Save payment methods). Save. Without it, the spike's first step fails with "token
   scope lacks vault/payment-tokens".
5. **Negative testing.** Go to **Testing Tools → Sandbox Accounts**, open the Business account's
   **⋯ → View/Edit account → Settings**, and turn **Negative Testing** ON. Without it, the
   decline-mock step charges instead of declining.
6. **Webhook** (needed for real delivery and `verifyWebhook`, not for the core spike). In the app,
   go to **Sandbox Webhooks → Add Webhook** with a public **HTTPS URL on port 443**, e.g. the
   deployed `https://<host>/api/paypal/webhook`. Subscribe to:
   - `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.PENDING`,
     `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`;
   - `CHECKOUT.ORDER.APPROVED`;
   - `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED`.

   Copy the **Webhook ID**. A localhost URL cannot receive deliveries, and simulator events
   cannot be postback-verified.
7. Put the values in the repo-root `.env`, which the spike loads by itself:
   ```
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   PAYPAL_WEBHOOK_ID=...        # optional for the spike
   ```

## The spike (Day-0/Day-1, riskiest first)

```bash
npx tsx packages/paypal/scripts/spike.ts      # from the repo root; or: npm run spike -w @claim/paypal
```

It **refuses to start** (exit 2, no network) without `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
It only ever talks to the sandbox. Each step prints `PASS` / `FAIL` / `SKIP` with PayPal's
`debug_id`, and the exit code is 1 if anything failed.

| # | Step | What it proves |
|---|---|---|
| 1 | oauth token | credentials work; the token scope includes vault (Vault ticked) |
| 2 | v6 client token | `response_type=client_token` works for this app |
| 3 | setup token | the vault setup token with `usage_type MERCHANT`, `customer_type CONSUMER`, `merchant_customer_id`, `vault_instruction ON_PAYER_APPROVAL` is accepted |
| 4 | v6 VAULT_WITHOUT_PAYMENT | `findEligibleMethods` offers PayPal save-without-purchase (measured only if you use the local page) |
| 5 | buyer approval | you approve as the US Personal buyer: popup on the local page, or the redirect link |
| 6 | payment token | setup token → `vault_id` |
| 7 | vault_id order | MIT charge with no buyer present, **without** `stored_credential` → COMPLETED |
| 8 | + stored_credential | the same **with** `stored_credential{MERCHANT, SUBSEQUENT}` → COMPLETED |
| 9 | idempotent replay | the same `PayPal-Request-Id` returns the same order |
| 10 | duplicate invoice_id | a reused `invoice_id` is refused (`DUPLICATE_INVOICE_ID`) |
| 11 | decline mock | `PayPal-Mock-Response: INSTRUMENT_DECLINED` on a vault order → DECLINED |
| 12 | pay-now after decline | the fallback order can reuse the declined cart's `invoice_id` |
| 13-14 | refund, tracking | partial refund of $1.00; tracker with `notify_payer=false` |
| 15 | MIT shipping address | whether a vault order without a shipping block gets the wallet's address |
| 16 | webhook | lists the app's webhooks and checks `PAYPAL_WEBHOOK_ID`, or registers `SPIKE_WEBHOOK_URL`, or prints how |

Step 5 serves a page at `http://localhost:3012` that mirrors the v6 sample, so the real product path
(popup) is tested; 3011 is left free for the web app. It also prints the redirect link, and polls
the setup token every 5 s, so either way works. Log in as the **Personal** sandbox buyer.

Spike knobs:
- `SPIKE_VAULT_ID=<id>`: reuse a vault id and skip steps 3-6. The spike prints the id after step 6.
- `SPIKE_SETUP_TOKEN=<id>`: skip creating a setup token and go straight to exchanging an approved
  one.
- `SPIKE_PORT` (default 3012) and `SPIKE_WAIT_MS` (default 15 min): settings for the approval wait.
- `SPIKE_WEBHOOK_URL=https://...`: register a webhook for all the events above.
- `SPIKE_DELETE_VAULT=1`: delete the vault token at the end.
- `SPIKE_ENV_FILE`: an alternative to the repo-root `.env`.

### Unverified until the spike runs

1. A new sandbox app is eligible for v6 `VAULT_WITHOUT_PAYMENT` (step 4).
2. A `vault_id` order completes merchant-initiated, both with and without `stored_credential`
   (steps 7-8). If only one works, set `PAYPAL_STORED_CREDENTIAL` to match.
3. The setup token accepts `merchant_customer_id` together with `vault_instruction ON_PAYER_APPROVAL`
   (step 3). `linkMerchantCustomerId: false` drops the former.
4. Negative testing is honoured on a single-step `vault_id` create (step 11). If it is not, the
   decline path is demonstrated with the mock gateway.
5. Duplicate-invoice blocking is on by default, and a decline leaves the `invoice_id` reusable
   (steps 10, 12).
6. Which shipping address a vault MIT order carries without a shipping block (step 15).
7. Whether the SDK reads `vaultSetupToken` (the sample) or `setupToken` (the docs) from the
   `start()` promise. `browser.ts` follows the sample.
8. Real webhook delivery and verify `SUCCESS` (spike 2, on the deployed listener).
9. Whether the payment token is immediately chargeable, or `VAULT.PAYMENT-TOKEN.CREATED` must
   arrive first.

## Tests

```bash
npx vitest run packages/paypal
npx tsc -p packages/paypal --noEmit
```

The conformance suite (`src/__tests__/spec.test.ts`) does the following:
- drives every sandbox call through a recording fake `fetch`;
- validates each request body against PayPal's OpenAPI specs (required fields, enums, patterns,
  lengths, unknown properties);
- checks that only declared headers are sent.

It reads the specs from `PAYPAL_OPENAPI_DIR`, defaulting to
`~/brain/scratch/2026-10-04/paypal-hackathon/ref/specs/openapi`, a clone of
`paypal/paypal-rest-api-specifications`. When those files are missing it shows as skipped rather
than failing.
