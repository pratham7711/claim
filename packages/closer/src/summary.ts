import { plural, usd } from "./format.js";
import type { ProposalDraft, ProposalKind } from "./types.js";

const ORDER: ProposalKind[] = ["charge", "invoice", "paylink", "reminder", "refund", "tracking", "release"];

/** "4 actions: charge 1 Claim Pass cart, invoice 2 buyers, refund $5 to nora". Built from the queue, never from model text. */
export function summarize(drafts: ProposalDraft[], dropped: { reason: string }[] = []): string {
  const by = (k: ProposalKind) => drafts.filter((d) => d.kind === k);
  const parts: string[] = [];
  for (const k of ORDER) {
    const list = by(k);
    if (!list.length) continue;
    const n = list.length;
    switch (k) {
      case "charge":
        parts.push(`charge ${plural(n, "Claim Pass cart")}`);
        break;
      case "invoice":
        parts.push(`invoice ${plural(n, "buyer")}`);
        break;
      case "paylink":
        parts.push(`send ${plural(n, "pay-now link")}`);
        break;
      case "reminder":
        parts.push(`remind ${plural(n, "buyer")}`);
        break;
      case "refund":
        parts.push(n === 1 ? `refund ${usd(list[0]!.amountCents)} to ${list[0]!.buyer}` : `${n} refunds (${usd(list.reduce((a, d) => a + d.amountCents, 0))})`);
        break;
      case "tracking":
        parts.push(`add tracking to ${plural(n, "order")}`);
        break;
      case "release":
        parts.push(`release holds for ${plural(n, "buyer")}`);
        break;
    }
  }
  const head = drafts.length ? `${plural(drafts.length, "action")}: ${parts.join(", ")}` : "Nothing to do: every bill is settled or already queued";
  const tail = dropped.length ? `. ${plural(dropped.length, "proposal")} dropped: ${dropped.slice(0, 2).map((d) => d.reason).join("; ")}${dropped.length > 2 ? "; …" : ""}` : "";
  return `${head}${tail}`;
}
