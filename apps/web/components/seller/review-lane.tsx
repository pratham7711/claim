"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ListedItem, ReviewView } from "../../lib/types";
import { clockMs, variantLabel } from "../../lib/stats";
import { Button, Icon, cx, inputCls } from "../ui";

type Decide = (id: string, decision: "approve" | "reject", patch?: { itemCode?: string; sku?: string }, quiet?: boolean) => Promise<boolean>;

const CAUSE: Record<string, string> = {
  "low-confidence": "Unsure",
  "over-cap": "Over cap",
  "ambiguous-variant": "Which variant?",
  "unknown-item": "Unknown item",
  "no-item": "No item named",
  "never-listed": "Never listed",
  "promotion-over-cap": "Next in line, over cap",
  "paid-cancel": "Cancel after payment",
  "change-unavailable": "Swap unavailable",
};

const CAUSE_PLAIN: Record<string, string> = {
  "low-confidence": "The desk wasn't sure this is a claim.",
  "over-cap": "Granting it would take them past their spending cap.",
  "ambiguous-variant": "They didn't say which variant.",
  "unknown-item": "It doesn't match an item you've listed.",
  "no-item": "They didn't name an item.",
  "never-listed": "That item was never listed in this show.",
  "promotion-over-cap": "They're next on the waitlist, but it would put them over their cap.",
  "paid-cancel": "They want to cancel something they've already paid for.",
  "change-unavailable": "They want to swap to something that's gone.",
};

/** Resolver rationale fragments, in the seller's words. Order is display priority. */
const NOTES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/bare code for an item not on screen/, () => "Typed a code for an item that isn't on screen"],
  [/number (\S+) is not a listed code/, (m) => `${m[1]} isn't one of your codes`],
  [/number is both a code and a size/, () => "The number could be a code or a size"],
  [/claims something not in the catalogue/, () => "Asked for something you haven't listed"],
  [/variant not offered/, () => "Asked for a variant you don't have"],
  [/variant not given/, () => "Didn't say which size or colour"],
  [/variant only/, () => "Named a size but no claim word"],
  [/also asks something/, () => "Also asks a question"],
  [/words beside the cue/, () => "Claim word with other words around it"],
  [/one stray word/, () => "One word the desk couldn't read"],
  [/long comment/, () => "Long comment; check it's a claim"],
  [/typo cue/, () => "Claim word is misspelled"],
  [/item named by title/, () => "Named the item by title, not code"],
  [/^bare code/, () => "Just a code, no claim word"],
];

function plainReason(r: ReviewView): string {
  if (r.cause === "low-confidence" && r.rationale) {
    const hits = NOTES.flatMap(([re, say]) => {
      const m = r.rationale!.match(re);
      return m ? [say(m)] : [];
    });
    if (hits.length) return `${hits.slice(0, 2).join(". ")}.`;
  }
  return CAUSE_PLAIN[r.cause] ?? r.reason;
}

/** The variant the buyer actually named, or the only one there is. Never a guess between several. */
function namedVariant(r: ReviewView, item?: ListedItem) {
  if (!item) return undefined;
  if (r.sku) return item.variants.find((v) => v.sku === r.sku);
  if (item.variants.length === 1) return item.variants[0];
  if (!r.size && !r.color) return undefined;
  const fits = item.variants.filter((v) => (!r.size || v.size?.toUpperCase() === r.size.toUpperCase()) && (!r.color || v.color?.toLowerCase() === r.color.toLowerCase()));
  return fits.length === 1 ? fits[0] : undefined;
}

function needsTarget(r: ReviewView) {
  return r.kind === "claim" || r.kind === "waitlist";
}

/** A claim the seller can approve without choosing anything: the item and the variant are both known. */
function ready(r: ReviewView, items: ListedItem[]) {
  if (!needsTarget(r) || !r.itemCode) return undefined;
  const v = namedVariant(r, items.find((i) => i.code === r.itemCode));
  return v ? { itemCode: r.itemCode, sku: v.sku } : undefined;
}

function ReviewCard({ r, items, onDecide }: { r: ReviewView; items: ListedItem[]; onDecide: Decide }) {
  const target = needsTarget(r);
  const [code, setCode] = useState(r.itemCode ?? (items.length === 1 ? items[0]!.code : ""));
  const item = items.find((i) => i.code === code);
  const [sku, setSku] = useState(() => namedVariant(r, items.find((i) => i.code === (r.itemCode ?? code)))?.sku ?? "");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const chosen = item?.variants.find((v) => v.sku === sku);

  const decide = async (d: "approve" | "reject") => {
    setBusy(d);
    const patch = d === "approve" && target ? { itemCode: code, ...(sku ? { sku } : {}) } : undefined;
    const ok = await onDecide(r.id, d, patch);
    if (!ok) setBusy(null);
  };

  return (
    <li data-review-id={r.id} tabIndex={0} aria-label={`${r.displayName}: ${r.text ?? r.kind}`} className="anim-slide rounded-xl border border-review/25 bg-surface p-3 outline-none focus-visible:border-review focus-visible:ring-2 focus-visible:ring-review/35">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-bold">{r.displayName}</span>
            <span className="num font-mono text-[10.5px] text-muted">{clockMs(r.platformTs)}</span>
          </div>
          {r.text ? <p className="mt-0.5 text-[14px] leading-snug">“{r.text}”</p> : null}
        </div>
        <span className="tone-bg-review shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">{CAUSE[r.cause] ?? r.cause}</span>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-snug text-muted">{plainReason(r)}</p>
      <details className="group mt-1">
        <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 text-[11.5px] font-semibold text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
          <Icon.Info size={12} /> Resolver detail
        </summary>
        <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted">
          {r.reason.replace(/\s+on\s+".*"$/s, "")}
          {r.rationale ? ` · ${r.rationale}` : ""}
        </p>
      </details>

      {target && items.length ? (
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="sr-only">Item</span>
            <select
              className={cx(inputCls, "py-1 text-[13px]")}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setSku("");
              }}
            >
              {code ? null : <option value="">Pick item…</option>}
              {items.map((i) => (
                <option key={i.code} value={i.code}>
                  #{i.code} {i.title}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="sr-only">Variant</span>
            <select className={cx(inputCls, "py-1 text-[13px]")} value={sku} onChange={(e) => setSku(e.target.value)} disabled={!item}>
              <option value="">Pick variant…</option>
              {item?.variants.map((v) => (
                <option key={v.sku} value={v.sku}>
                  {variantLabel(v)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      <div className="mt-2.5 flex gap-2">
        <Button data-act="approve" size="sm" variant="ink" className="flex-1" busy={busy === "approve"} disabled={busy !== null || (target && (!code || !sku))} onClick={() => decide("approve")}>
          <Icon.Check size={14} /> {target && !sku ? "Pick a variant to approve" : `Approve${target && chosen ? ` ${variantLabel(chosen)}` : ""}`}
        </Button>
        <Button data-act="reject" size="sm" variant="outline" busy={busy === "reject"} disabled={busy !== null} onClick={() => decide("reject")}>
          Reject
        </Button>
      </div>
    </li>
  );
}

export function ReviewLane({ reviews, items, onDecide, onBulkDone }: { reviews: ReviewView[]; items: ListedItem[]; onDecide: Decide; onBulkDone?: (approved: number) => void }) {
  const list = useRef<HTMLUListElement>(null);
  const nextFocus = useRef<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const batch = reviews.flatMap((r) => {
    const patch = ready(r, items);
    return patch ? [{ id: r.id, patch }] : [];
  });

  // After a keyboard decision the card is removed; keep focus in the lane on the card that took its place.
  useEffect(() => {
    const id = nextFocus.current;
    if (!id || !list.current) return;
    const el = list.current.querySelector<HTMLElement>(`[data-review-id="${CSS.escape(id)}"]`);
    if (el) {
      el.focus();
      nextFocus.current = null;
    }
  }, [reviews]);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SUMMARY") return;
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-review-id]");
    const cards = [...(list.current?.querySelectorAll<HTMLElement>("[data-review-id]") ?? [])];
    const i = card ? cards.indexOf(card) : -1;
    const key = e.key.toLowerCase();
    if (key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      cards[Math.min(cards.length - 1, i + 1)]?.focus();
    } else if (key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      cards[Math.max(0, i - 1)]?.focus();
    } else if ((key === "a" || key === "r") && card) {
      const btn = card.querySelector<HTMLButtonElement>(`[data-act="${key === "a" ? "approve" : "reject"}"]`);
      if (!btn || btn.disabled) return;
      e.preventDefault();
      nextFocus.current = (cards[i + 1] ?? cards[i - 1])?.dataset.reviewId ?? null;
      btn.click();
    }
  };

  const approveAll = async () => {
    setBulk({ done: 0, total: batch.length });
    let done = 0;
    for (const b of batch) {
      if (await onDecide(b.id, "approve", b.patch, true)) done += 1;
      setBulk({ done, total: batch.length });
    }
    setBulk(null);
    onBulkDone?.(done);
  };

  if (!reviews.length)
    return (
      <div className="flex items-center gap-3 px-4 py-4 text-[13px] text-muted">
        <span className="tone-bg-granted inline-flex size-7 items-center justify-center rounded-full">
          <Icon.Check size={14} />
        </span>
        Nothing needs you. Unsure and ambiguous claims land here.
      </div>
    );
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <p className="text-[12px] text-muted">
          <kbd className="kbd">J</kbd>/<kbd className="kbd">K</kbd> move · <kbd className="kbd">A</kbd> approve · <kbd className="kbd">R</kbd> reject
        </p>
        {batch.length > 1 || bulk ? (
          <Button size="sm" variant="soft" busy={bulk !== null} onClick={approveAll}>
            {bulk ? `Approving ${bulk.done}/${bulk.total}` : `Approve ${batch.length} ready`}
          </Button>
        ) : null}
      </div>
      <ul ref={list} className="space-y-2 p-3" aria-live="polite" aria-label="Claims waiting for review" onKeyDown={onKeyDown}>
        {reviews.map((r) => (
          <ReviewCard key={r.id} r={r} items={items} onDecide={onDecide} />
        ))}
      </ul>
    </div>
  );
}
