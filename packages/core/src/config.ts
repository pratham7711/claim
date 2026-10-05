import type { EngineConfig } from "./types.js";

/**
 * Settle window: 2000 ms.
 *
 * A grant stays provisional for this long on the engine clock. Inside it, a claim with an
 * earlier (platformTs, commentId) for the same variant pre-empts the latest provisional holder;
 * after it, the grant is final and a late claim queues on the waitlist instead.
 *
 * The window has to cover the difference in lag between two claims racing for one unit:
 *  - ingestion skew between sources: anonymous Twitch IRC measured p50 275 ms / p90 426 ms
 *    from this Mac, while the seller-owned room is near zero;
 *  - resolver skew: the rule path is synchronous, the LLM path is budgeted at p95 < 1.5 s.
 * 426 + 1500 is about 1.9 s, so 2 s. That is close to the spec's "~1.5 s reorder buffer"; it
 * yields the same winners as buffering and sorting, but shows the hold immediately instead of
 * after the buffer drains. Paid units are never pre-empted, and nobody pays within 2 s.
 */
export const DEFAULT_SETTLE_WINDOW_MS = 2000;

export const DEFAULT_CONFIG: Omit<EngineConfig, "showId"> = {
  currency: "USD",
  leaseMs: 10 * 60_000,
  declineLeaseMs: 15 * 60_000,
  settleWindowMs: DEFAULT_SETTLE_WINDOW_MS,
  confidenceThreshold: 0.8,
  cap: { maxCents: 15_000 },
  shipping: { firstItemCents: 800, perExtraItemCents: 200, freeOverCents: 10_000 },
};

export function makeConfig(showId: string, overrides: Partial<Omit<EngineConfig, "showId">> = {}): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    cap: { ...DEFAULT_CONFIG.cap, ...overrides.cap },
    shipping: { ...DEFAULT_CONFIG.shipping, ...overrides.shipping },
    showId,
  };
}
