/**
 * Shared contract between ingestion, the resolver and the claim engine.
 * Resolver turns a ChatComment into a ClaimIntent; the engine consumes intents.
 */

export type Platform = "room" | "twitch" | "youtube" | "simulator";

export interface ChatComment {
  id: string;
  platform: Platform;
  /** Stable per-platform user id; never the display name. */
  userId: string;
  displayName: string;
  text: string;
  /** When the platform says the comment was posted (ms epoch). Fairness orders by this. */
  platformTs: number;
  /** When we received it (ms epoch). Used only to measure ingestion lag. */
  receivedTs: number;
}

export interface Variant {
  sku: string;
  size?: string;
  color?: string;
  /** Units available for this variant in this show. */
  qty: number;
}

export interface ShowItem {
  /** The short number the host says on air, e.g. "12". Unique within a show. */
  code: string;
  title: string;
  priceCents: number;
  variants: Variant[];
}

export interface ResolverContext {
  /** The item on screen right now, if any. Bare "sold"/"me!" comments refer to it. */
  currentItem?: ShowItem;
  /** Every item listed so far in this show, newest first. */
  items: ShowItem[];
}

export type IntentKind =
  | "claim"
  | "cancel"
  | "change"
  | "waitlist"
  | "question"
  | "other";

export interface ClaimIntent {
  commentId: string;
  kind: IntentKind;
  itemCode?: string;
  size?: string;
  color?: string;
  qty?: number;
  /** For a cross-item swap ("cancel my 7 take 8"): the item being given up. */
  fromItemCode?: string;
  /** Position of this intent within its comment (0-based). A comment naming several items yields several intents. */
  intentIndex?: number;
  /** 0..1. Below the engine's threshold the intent goes to the seller's review lane. */
  confidence: number;
  method: "rule" | "llm";
  rationale?: string;
}

/* ---------- Payments: implemented by @claim/paypal (sandbox) and a mock for demos and tests ---------- */

/** A ship-to address as PayPal holds it on a saved wallet or an order. */
export interface ShipTo {
  name?: string;
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryCode: string;
}

export interface ChargeResult {
  /** Absent when PayPal refused before creating an order (a 422 decline on create). */
  orderId?: string;
  captureId?: string;
  status: "COMPLETED" | "PENDING" | "DECLINED" | "PAYER_ACTION_REQUIRED";
  /** PayPal issue code on a decline, e.g. INSTRUMENT_DECLINED. */
  declineCode?: string;
  debugId?: string;
  /** Where the order ships, as recorded on the PayPal order. */
  shipTo?: ShipTo;
}

export interface PayNowOrder {
  orderId: string;
  approveUrl: string;
}

export interface CartChargeInput {
  invoiceId: string;
  requestId: string;
  currency: "USD";
  lines: { name: string; sku: string; qty: number; unitCents: number }[];
  shippingCents: number;
  totalCents: number;
  customId?: string;
  /** Sent as the order's shipping. A vault charge without one uses the address saved on the wallet. */
  shipTo?: ShipTo;
}

export interface PaymentsGateway {
  readonly mode: "sandbox" | "mock";
  /** Browser client token for the v6 JS SDK. */
  clientToken(): Promise<string>;
  /** Claim Pass, step 1: setup token for a save-without-purchase session. */
  createSetupToken(input: { buyerKey: string; returnUrl: string; cancelUrl: string }): Promise<{ setupTokenId: string }>;
  /** Claim Pass, step 2: exchange the approved setup token for a vault id. */
  createPaymentToken(setupTokenId: string): Promise<{ vaultId: string; customerId: string }>;
  deletePaymentToken(vaultId: string): Promise<void>;
  /**
   * The address the buyer keeps on a saved wallet, read at close-out so a change made since saving the
   * pass is honoured. A vault_id order does not copy it onto the order by itself (measured in the
   * sandbox), so the caller passes it as the cart's shipTo. Undefined when there is none or the lookup
   * fails; it never throws, so a missing address cannot block a charge.
   */
  walletShipTo(vaultId: string): Promise<ShipTo | undefined>;
  /** End-show close-out: merchant-initiated order against a saved wallet, no buyer present. */
  chargeVaulted(vaultId: string, cart: CartChargeInput): Promise<ChargeResult>;
  /** Fallback for buyers without a Claim Pass. */
  createPayNowOrder(cart: CartChargeInput, urls: { returnUrl: string; cancelUrl: string }): Promise<PayNowOrder>;
  captureOrder(orderId: string): Promise<ChargeResult>;
  /** `requestId` makes a retried or double-clicked refund return the first refund instead of issuing a second. */
  refundCapture(captureId: string, amountCents: number, note?: string, requestId?: string): Promise<{ refundId: string; status: string }>;
  addTracking(input: { orderId: string; captureId: string; trackingNumber: string; carrier: string; notifyPayer: boolean }): Promise<{ trackerId: string }>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean>;
}
