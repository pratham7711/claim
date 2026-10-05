"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AuditEntry } from "@claim/core";
import type { CommentView, UnitView } from "../../lib/types";
import { baseCommentId, clockMs } from "../../lib/stats";
import { Icon, cx } from "../ui";

const TYPE_TONE: Record<string, string> = {
  unitGranted: "text-granted",
  unitConfirmed: "text-granted",
  cartCharged: "text-granted",
  unitWaitlisted: "text-waitlist",
  reviewOpened: "text-review",
  reviewResolved: "text-review",
  unitReleased: "text-danger",
  cartDeclined: "text-danger",
  commandRejected: "text-danger",
};

const TYPE_LABEL: Record<string, string> = {
  itemListed: "listed",
  inventoryUpdated: "stock",
  claimAccepted: "claim",
  claimParked: "parked",
  unitGranted: "granted",
  unitWaitlisted: "waitlist",
  unitReleased: "released",
  unitConfirmed: "confirmed",
  unitReverted: "reverted",
  unitReassigned: "reassigned",
  reviewOpened: "review",
  reviewResolved: "resolved",
  intentIgnored: "ignored",
  commandRejected: "rejected",
  claimPassSaved: "pass",
  claimPassRevoked: "pass",
  showEnded: "show",
  cartsFinalized: "carts",
  cartCharged: "charged",
  cartDeclined: "declined",
};

/** The "why" of every decision, newest first, optionally narrowed to one comment and the units it touched. */
export function AuditDrawer({ audit, comments, units, focus, onClose }: { audit: AuditEntry[]; comments: CommentView[]; units: UnitView[]; focus?: string; onClose: () => void }) {
  const [all, setAll] = useState(!focus);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => setAll(!focus), [focus]);

  const comment = focus ? comments.find((c) => c.id === focus) : undefined;
  const rows = useMemo(() => {
    if (all || !focus) return [...audit].reverse();
    // Everything decided in the same engine steps as this comment, plus later decisions about its units.
    const unitIds = new Set(units.filter((u) => u.commentId && baseCommentId(u.commentId) === focus).map((u) => u.id));
    const steps = new Set(audit.filter((a) => a.commentId && baseCommentId(a.commentId) === focus).map((a) => a.at));
    return audit.filter((a) => steps.has(a.at) || (a.unitId && unitIds.has(a.unitId))).reverse();
  }, [audit, units, all, focus]);

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-labelledby="audit-title">
      <button type="button" aria-label="Close audit log" className="anim-fade absolute inset-0 bg-ink/25 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="anim-drawer absolute inset-y-0 right-0 flex w-full max-w-[460px] flex-col border-l border-line bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <div className="eyebrow">Fairness log · times in UTC</div>
            <h2 id="audit-title" className="mt-0.5 text-lg font-bold tracking-tight">
              Why it happened
            </h2>
            {comment && !all ? (
              <p className="mt-1 text-[13px] text-ink-2">
                <span className="font-semibold">{comment.displayName}</span> sent “{comment.text}” at <span className="num font-mono">{clockMs(comment.platformTs)}</span>
              </p>
            ) : null}
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="inline-flex size-8 items-center justify-center rounded-lg text-ink-2 hover:bg-sunken">
            <Icon.X />
          </button>
        </header>
        {focus ? (
          <div className="flex gap-1 border-b border-line px-5 py-2">
            <button type="button" onClick={() => setAll(false)} className={cx("rounded-md px-2.5 py-1 text-[12.5px] font-semibold", !all ? "bg-ink text-paper" : "text-ink-2 hover:bg-sunken")}>
              This comment
            </button>
            <button type="button" onClick={() => setAll(true)} className={cx("rounded-md px-2.5 py-1 text-[12.5px] font-semibold", all ? "bg-ink text-paper" : "text-ink-2 hover:bg-sunken")}>
              Whole show
            </button>
          </div>
        ) : null}
        <ol className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {rows.length ? (
            rows.map((a) => (
              <li key={a.seq} className="relative border-l-2 border-line py-2 pl-4">
                <span className={cx("absolute -left-[5px] top-3.5 size-2 rounded-full bg-current", TYPE_TONE[a.type] ?? "text-line-strong")} />
                <div className="flex items-baseline gap-2">
                  <span className="num font-mono text-[11px] text-muted">{a.time}</span>
                  <span className={cx("font-mono text-[10.5px] font-semibold uppercase tracking-wider", TYPE_TONE[a.type] ?? "text-ink-2")}>{TYPE_LABEL[a.type] ?? a.type}</span>
                  <span className="num ml-auto font-mono text-[10px] text-muted">#{a.seq}</span>
                </div>
                <p className="mt-0.5 text-[13px] leading-snug text-ink">{a.reason}</p>
              </li>
            ))
          ) : (
            <li className="py-6 text-sm text-muted">No decisions yet.</li>
          )}
        </ol>
      </aside>
    </div>
  );
}
