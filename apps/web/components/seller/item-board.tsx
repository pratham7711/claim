"use client";

import type { BoardItem } from "@claim/core";
import { money, variantLabel } from "../../lib/stats";
import { cx } from "../ui";

function Units({ qty, sold, held, settling }: { qty: number; sold: number; held: number; settling: number }) {
  // Settling units are a subset of sold+held; draw them last among the committed ones.
  const blocks = Array.from({ length: qty }, (_, i) => {
    if (i < sold + held - settling) return i < sold ? "sold" : "held";
    if (i < sold + held) return "settling";
    return "free";
  });
  return (
    <span className="flex gap-[3px]" aria-hidden="true">
      {blocks.map((b, i) => (
        <span
          key={i}
          className={cx(
            "h-3.5 w-3.5 rounded-[4px] transition-colors duration-300",
            b === "sold" && "bg-granted",
            b === "held" && "bg-held",
            b === "settling" && "bg-granted/60 ring-2 ring-granted/30",
            b === "free" && "border border-dashed border-line-strong bg-surface",
          )}
        />
      ))}
    </span>
  );
}

export function ItemBoard({ board, onAir, currency }: { board: BoardItem[]; onAir?: string; currency: string }) {
  if (!board.length) return <p className="p-4 text-sm text-muted">List an item to see its stock here.</p>;
  const ordered = [...board].sort((a, b) => (a.code === onAir ? -1 : b.code === onAir ? 1 : 0));
  return (
    <div className="divide-y divide-line">
      {ordered.map((item) => (
        <div key={item.code} className={cx("px-4 py-3", item.code === onAir && "bg-brand-soft/40")}>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="display-tight text-[17px] font-extrabold text-brand">#{item.code}</span>
              <span className="truncate text-[13px] font-semibold">{item.title}</span>
            </div>
            <span className="num shrink-0 text-[12px] text-muted">{money(item.priceCents, currency)}</span>
          </div>
          <ul className="space-y-2">
            {item.variants.map((v) => (
              <li key={v.sku}>
                <div className="flex items-center justify-between gap-3">
                  <span className="w-20 shrink-0 truncate text-[12.5px] font-semibold text-ink-2">{variantLabel(v)}</span>
                  <Units qty={v.qty} sold={v.sold} held={v.held} settling={v.settling} />
                  <span className="num ml-auto shrink-0 text-right font-mono text-[11px] text-muted">
                    <span className={cx(v.available === 0 && "text-ink")}>{v.available === 0 ? "sold out" : `${v.available} left`}</span>
                  </span>
                </div>
                <span className="sr-only">
                  {variantLabel(v)}: {v.sold} sold, {v.held} held, {v.available} available, {v.waitlist.length} waiting
                </span>
                {v.waitlist.length ? (
                  <ol className="mt-1.5 flex flex-wrap gap-1 pl-20" aria-label={`Waitlist for ${variantLabel(v)}`}>
                    {v.waitlist.map((w, i) => (
                      <li key={w.unitId} className="anim-slide inline-flex items-center gap-1 rounded-full bg-waitlist-soft px-2 py-0.5 text-[11px] font-semibold text-waitlist">
                        <span className="num font-mono">#{i + 1}</span> {w.displayName}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-4 py-2.5 text-[11px] text-muted">
        <Legend cls="bg-granted" label="sold" />
        <Legend cls="bg-held" label="pay-now hold" />
        <Legend cls="bg-granted/60 ring-2 ring-granted/30" label="settling" />
        <Legend cls="border border-dashed border-line-strong" label="free" />
      </div>
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx("h-2.5 w-2.5 rounded-[3px]", cls)} />
      {label}
    </span>
  );
}
