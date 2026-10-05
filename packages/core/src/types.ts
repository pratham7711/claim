import type { ChatComment, ClaimIntent, IntentKind, Platform, ShowItem, Variant } from "./contract.js";

export interface BuyerRef {
  /** `<platform>:<userId>`; the engine's identity for a buyer. */
  buyerKey: string;
  displayName: string;
  platform?: Platform;
  userId?: string;
}

export interface ShippingRule {
  firstItemCents: number;
  perExtraItemCents: number;
  /** Item subtotal at or above which shipping is free. */
  freeOverCents?: number;
}

export interface BuyerCap {
  /** Ceiling on the buyer's projected cart total for the show, shipping included. */
  maxCents?: number;
  maxUnits?: number;
}

export interface EngineConfig {
  showId: string;
  /** ISO 4217 code; amounts are minor units of it. */
  currency: string;
  /** How long a pay-now hold lives before the unit cascades to the waitlist. */
  leaseMs: number;
  /** Pay-now window granted after a close-out charge is declined. */
  declineLeaseMs: number;
  /** How long a grant stays pre-emptable by an earlier claim that arrives late. */
  settleWindowMs: number;
  /** Actionable intents below this confidence go to the review lane. */
  confidenceThreshold: number;
  cap: BuyerCap;
  shipping: ShippingRule;
}

/** Total order for claims: platformTs, then comment id, then unit index within the claim. */
export interface ClaimKey {
  ts: number;
  id: string;
  n: number;
}

export type UnitStatus = "pending" | "waitlisted" | "held" | "confirmed" | "charged" | "released";

export type ReleaseCause =
  | "lease-expired"
  | "buyer-cancel"
  | "changed"
  | "seller-revoke"
  | "to-review";

export interface Unit {
  id: string;
  claimId: string;
  buyerKey: string;
  itemCode: string;
  sku: string;
  key: ClaimKey;
  priceCents: number;
  status: UnitStatus;
  via?: "claim-pass" | "pay-now";
  paid: boolean;
  /** Seller-approved or seller-granted units skip the cap check on promotion. */
  capExempt: boolean;
  source: ClaimSource;
  commentId?: string;
  grantedAt?: number;
  settleUntil?: number;
  leaseExpiresAt?: number;
  cartId?: string;
  releaseCause?: ReleaseCause;
}

export type ClaimSource = "comment" | "seller" | "review";

export interface VariantState extends Variant {}

export interface ItemState {
  code: string;
  title: string;
  priceCents: number;
  variants: VariantState[];
  listedAt: number;
}

export interface BuyerState {
  buyer: BuyerRef;
  pass?: { capCents?: number; savedAt: number };
}

export type ReviewCause =
  | "low-confidence"
  | "over-cap"
  | "ambiguous-variant"
  | "unknown-item"
  | "no-item"
  | "never-listed"
  | "promotion-over-cap"
  | "paid-cancel"
  | "change-unavailable";

export interface ReviewRequest {
  kind: Exclude<IntentKind, "question" | "other">;
  itemCode?: string;
  sku?: string;
  size?: string;
  color?: string;
  qty?: number;
  key: ClaimKey;
  confidence?: number;
  text?: string;
  /** Units the decision acts on, for cancels of paid units. */
  unitIds?: string[];
}

export interface ReviewItem {
  id: string;
  buyerKey: string;
  commentId?: string;
  cause: ReviewCause;
  reason: string;
  request: ReviewRequest;
  openedAt: number;
  status: "pending" | "approved" | "rejected";
}

export interface ParkedClaim {
  commentId: string;
  buyerKey: string;
  request: ReviewRequest;
  parkedAt: number;
}

export interface CartLine {
  itemCode: string;
  sku: string;
  title: string;
  size?: string;
  color?: string;
  qty: number;
  unitCents: number;
  lineCents: number;
  paidCents: number;
  unitIds: string[];
}

export interface Cart {
  cartId: string;
  showId: string;
  buyerKey: string;
  displayName: string;
  /** 1 for the buyer's first cart in the show; supplementary carts follow a decline or late promotion. */
  seq: number;
  /** PayPal `purchase_units[].invoice_id`: `<showId>-<buyerKey>`, unique per merchant, so a double close-out is refused. */
  invoiceId: string;
  /** PayPal-Request-Id for the create call; replays of the same cart return the original order. */
  requestId: string;
  chargeMode: "vault" | "pay-now";
  lines: CartLine[];
  units: number;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  /** Already captured through pay-now orders during the show. */
  paidCents: number;
  dueCents: number;
  capCents?: number;
  flags: string[];
  status: "pending" | "charged" | "declined";
  orderId?: string;
  createdAt: number;
}

export interface EngineState {
  config: EngineConfig;
  phase: "live" | "ended";
  clock: number;
  seq: number;
  items: Record<string, ItemState>;
  itemOrder: string[];
  units: Record<string, Unit>;
  unitOrder: string[];
  buyers: Record<string, BuyerState>;
  reviews: Record<string, ReviewItem>;
  reviewOrder: string[];
  parked: ParkedClaim[];
  carts: Record<string, Cart>;
  cartOrder: string[];
  seenComments: Record<string, true>;
  counters: { claim: number; review: number };
}

// ---------- commands ----------

export type Command =
  | { type: "listItem"; item: ShowItem }
  | { type: "updateInventory"; itemCode: string; sku: string; qty: number; size?: string; color?: string }
  | { type: "applyIntent"; comment: ChatComment; intent: ClaimIntent }
  | { type: "saveClaimPass"; buyer: BuyerRef; capCents?: number }
  | { type: "revokeClaimPass"; buyerKey: string }
  | { type: "confirmPayment"; unitIds: string[]; orderId?: string }
  | { type: "sellerGrant"; buyer: BuyerRef; itemCode: string; sku: string; qty?: number; note?: string }
  | { type: "sellerRevoke"; unitId: string; note?: string }
  | { type: "sellerReassign"; unitId: string; to: BuyerRef; note?: string }
  | { type: "approveReview"; reviewId: string; patch?: ReviewPatch }
  | { type: "rejectReview"; reviewId: string; note?: string }
  | { type: "tick" }
  | { type: "endShow" }
  | { type: "finalizeCarts" }
  | { type: "recordCharge"; cartId: string; outcome: "completed" | "declined"; orderId?: string; note?: string };

export interface ReviewPatch {
  itemCode?: string;
  sku?: string;
  size?: string;
  color?: string;
  qty?: number;
}

// ---------- events ----------

interface Base {
  seq: number;
  at: number;
  /** Human-readable why; the audit log is these strings. */
  reason: string;
}

export type EngineEvent = Base &
  (
    | { type: "itemListed"; item: ShowItem }
    | { type: "inventoryUpdated"; itemCode: string; sku: string; qty: number; prevQty: number; added?: Variant }
    | {
        type: "claimAccepted";
        claimId: string;
        buyer: BuyerRef;
        itemCode: string;
        sku: string;
        unitIds: string[];
        key: ClaimKey;
        priceCents: number;
        source: ClaimSource;
        capExempt: boolean;
        commentId?: string;
      }
    | { type: "claimParked"; commentId: string; buyer: BuyerRef; request: ReviewRequest }
    | {
        type: "unitGranted";
        unitId: string;
        status: "held" | "confirmed";
        via: "claim-pass" | "pay-now";
        settleUntil: number;
        leaseExpiresAt?: number;
        promoted: boolean;
        preempted?: string;
      }
    | { type: "unitWaitlisted"; unitId: string; cause: "sold-out" | "preempted" | "bumped"; by?: string }
    | { type: "unitReleased"; unitId: string; cause: ReleaseCause; refundDue: boolean; commentId?: string }
    | { type: "unitConfirmed"; unitId: string; via: "claim-pass" | "payment"; orderId?: string }
    | { type: "unitReverted"; unitId: string; leaseExpiresAt: number }
    | {
        type: "unitReassigned";
        unitId: string;
        from: string;
        to: BuyerRef;
        status: "held" | "confirmed";
        via: "claim-pass" | "pay-now";
        leaseExpiresAt?: number;
        refundDue: boolean;
      }
    | {
        type: "reviewOpened";
        reviewId: string;
        buyer: BuyerRef;
        cause: ReviewCause;
        request: ReviewRequest;
        commentId?: string;
      }
    | { type: "reviewResolved"; reviewId: string; decision: "approved" | "rejected"; patch?: ReviewPatch }
    | { type: "intentIgnored"; commentId: string; buyer: BuyerRef; kind: IntentKind }
    | { type: "commandRejected"; command: Command["type"]; commentId?: string; buyer?: BuyerRef }
    | { type: "claimPassSaved"; buyer: BuyerRef; capCents?: number }
    | { type: "claimPassRevoked"; buyerKey: string }
    | { type: "showEnded" }
    | { type: "cartsFinalized"; carts: Cart[] }
    | { type: "cartCharged"; cartId: string; orderId?: string }
    | { type: "cartDeclined"; cartId: string }
  );

export type EventType = EngineEvent["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the engine stamps `seq` and `at`. */
export type EventDraft = DistributiveOmit<EngineEvent, "seq" | "at">;
