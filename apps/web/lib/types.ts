import type {
  AuditEntry,
  BoardItem,
  BuyerCarts,
  ChargeResult,
  IntentKind,
  Platform,
  ReviewCause,
  ShipTo,
  ShowItem,
  UnitStatus,
} from "@claim/core";

/** What a resolved comment turned into, as the seller sees it on the stream. */
export type OutcomeTone = "granted" | "held" | "sold" | "settling" | "waitlist" | "review" | "released" | "question" | "chatter" | "rejected" | "pending";

export interface Outcome {
  tone: OutcomeTone;
  /** Short stamp text, e.g. "GRANTED", "WAITLIST #2". */
  label: string;
  detail?: string;
  /** Pay-now hold deadline, for a countdown. */
  leaseUntil?: number;
  /** End of the settle window: until then an earlier claim that arrives late can still take the unit. */
  settleUntil?: number;
}

export interface IntentView {
  index: number;
  kind: IntentKind;
  itemCode?: string;
  size?: string;
  color?: string;
  qty?: number;
  fromItemCode?: string;
  confidence: number;
  method: "rule" | "llm";
  rationale?: string;
  outcome: Outcome;
}

export interface CommentView {
  id: string;
  platform: Platform;
  buyerKey: string;
  displayName: string;
  text: string;
  platformTs: number;
  receivedTs: number;
  /** Resolver wall time for this comment. */
  latencyMs: number;
  intents: IntentView[];
  /** The headline outcome across the comment's intents. */
  outcome: Outcome;
}

export interface UnitView {
  id: string;
  buyerKey: string;
  displayName: string;
  itemCode: string;
  sku: string;
  label: string;
  title: string;
  priceCents: number;
  status: UnitStatus;
  via?: "claim-pass" | "pay-now";
  paid: boolean;
  leaseExpiresAt?: number;
  settleUntil?: number;
  waitlistPos?: number;
  commentId?: string;
  cartId?: string;
  releaseCause?: string;
}

export interface ReviewView {
  id: string;
  buyerKey: string;
  displayName: string;
  cause: ReviewCause;
  reason: string;
  kind: string;
  itemCode?: string;
  sku?: string;
  size?: string;
  color?: string;
  qty?: number;
  confidence?: number;
  /** The resolver's own note on why it was unsure, when it left one. */
  rationale?: string;
  text?: string;
  platformTs: number;
  openedAt: number;
}

export interface ListedItem extends ShowItem {
  transcript?: string;
  listedAt: number;
}

export interface BuyerView {
  buyerKey: string;
  displayName: string;
  platform?: Platform;
  hasPass: boolean;
  passCapCents?: number;
  /** Vault ids are never sent to browsers; only whether one exists. */
  vaulted: boolean;
}

export interface OrderRecord {
  orderId: string;
  purpose: "cart" | "holds";
  buyerKey: string;
  displayName: string;
  cartId?: string;
  unitIds?: string[];
  amountCents: number;
  shippingCents: number;
  lines: { name: string; sku: string; qty: number; unitCents: number }[];
  approveUrl: string;
  createdAt: number;
  capturedAt?: number;
  status: "open" | "captured" | "failed";
}

export interface ChargeRecord {
  cartId: string;
  orderId?: string;
  captureId?: string;
  status: ChargeResult["status"];
  declineCode?: string;
  amountCents: number;
  via: "vault" | "pay-now";
  at: number;
  /** Where the order ships. A buyer's address, so only the seller-scoped view carries it. */
  shipTo?: ShipTo;
}

/** "public" goes to every buyer room; "seller" adds buyers' ship-to addresses for close-out and the ledger. */
export type ViewScope = "public" | "seller";

/** A verified PayPal webhook delivery that matched something in this show. */
export interface WebhookRecord {
  eventId: string;
  type: string;
  at: number;
  captureId?: string;
  refundId?: string;
  orderId?: string;
  vaultId?: string;
  /** Plain words for the seller, e.g. "PayPal confirmed the payment". */
  summary: string;
}

export interface RefundRecord {
  cartId: string;
  refundId: string;
  /** The PayPal-Request-Id it went out under; a replay with the same id returns this record. */
  requestId?: string;
  amountCents: number;
  status: string;
  note?: string;
  at: number;
}

export interface TrackingRecord {
  cartId: string;
  trackerId: string;
  carrier: string;
  trackingNumber: string;
  at: number;
}

export interface Kpis {
  commentsPerMin: number;
  totalComments: number;
  /** Share of actionable intents settled without the review lane, 0..1. Null before any arrive. */
  autoResolved: number | null;
  p95LatencyMs: number | null;
  /** Committed but not yet charged: pay-now holds plus confirmed units. */
  heldCents: number;
  chargedCents: number;
  oversold: number;
  reviewOpen: number;
  claims: number;
}

export interface TwitchStatus {
  channel?: string;
  state: "off" | "connecting" | "live" | "error";
  error?: string;
  messages: number;
  /** p50 of receivedTs - tmi-sent-ts, ms. */
  lagP50Ms?: number;
}

export interface ShowView {
  showId: string;
  title: string;
  shopName: string;
  createdAt: number;
  startedAt?: number;
  phase: "live" | "ended";
  /** Server clock when this snapshot was built; clients use it to correct countdowns. */
  now: number;
  streamUrl?: string;
  onAir?: string;
  items: ListedItem[];
  board: BoardItem[];
  comments: CommentView[];
  reviews: ReviewView[];
  audit: AuditEntry[];
  units: UnitView[];
  buyers: BuyerView[];
  carts: BuyerCarts[];
  orders: OrderRecord[];
  charges: ChargeRecord[];
  refunds: RefundRecord[];
  tracking: TrackingRecord[];
  webhooks: WebhookRecord[];
  kpis: Kpis;
  config: {
    currency: string;
    capCents?: number;
    leaseMs: number;
    settleWindowMs: number;
    confidenceThreshold: number;
    shipping: { firstItemCents: number; perExtraItemCents: number; freeOverCents?: number };
  };
  payments: { mode: "sandbox" | "mock"; label: string };
  llm: { provider: string; model: string; escalateModel?: string };
  twitch: TwitchStatus;
  simulation?: { scenario: string; label: string; startedAt: number };
}

export interface ShowSummary {
  showId: string;
  title: string;
  createdAt: number;
  phase: "live" | "ended";
  items: number;
}

export const SCENARIOS = [
  { id: "race", label: "4 buyers race for 2 items" },
  { id: "jitter", label: "Late-arriving earlier comment" },
  { id: "cancel", label: "Cancel, then waitlist promotion" },
  { id: "slang", label: "Messy slang burst" },
  { id: "hinglish", label: "Hinglish burst" },
  { id: "bundle", label: "One buyer, three items, one cart" },
] as const;

export type ScenarioId = (typeof SCENARIOS)[number]["id"];

/** Every mutation the browser can ask for. One endpoint, one switch. */
export type ShowAction =
  | { action: "start" }
  | { action: "end" }
  | { action: "setStream"; streamUrl: string }
  | { action: "onAir"; code: string }
  | { action: "comment"; userId: string; displayName: string; text: string }
  | { action: "parseListing"; transcript: string }
  | { action: "listItem"; draft: unknown; edits?: unknown; transcript?: string; onAir?: boolean }
  | { action: "simulate"; scenario: ScenarioId }
  | { action: "twitch"; channel?: string }
  | { action: "review"; reviewId: string; decision: "approve" | "reject"; patch?: { itemCode?: string; sku?: string; size?: string; color?: string; qty?: number } }
  | { action: "savePass"; userId: string; displayName: string; capCents?: number; declines?: boolean }
  | { action: "clientToken" }
  | { action: "passSetup"; userId: string; displayName: string; capCents?: number }
  | { action: "passApprove"; setupTokenId: string }
  | { action: "chargeAll" }
  | { action: "finalize" }
  | { action: "payNowCart"; cartId: string }
  | { action: "payNowHolds"; buyerKey: string }
  | { action: "releaseHolds"; buyerKey: string }
  | { action: "capture"; orderId: string }
  | { action: "refund"; cartId: string; amountCents?: number; note?: string; requestId?: string }
  | { action: "tracking"; cartId: string; carrier: string; trackingNumber: string };
