"use client";

import type { CommentView, IntentView } from "../lib/types";
import { Countdown, Icon, PlatformGlyph, SettleBar, Stamp, cx } from "./ui";

const KIND_LABEL: Record<string, string> = {
  claim: "claim",
  cancel: "cancel",
  change: "swap",
  waitlist: "waitlist",
  question: "question",
  other: "chatter",
};

export function intentText(i: Pick<IntentView, "kind" | "itemCode" | "size" | "color" | "qty" | "fromItemCode">): string {
  const parts = [KIND_LABEL[i.kind] ?? i.kind];
  if (i.fromItemCode && i.itemCode && i.fromItemCode !== i.itemCode) parts.push(`#${i.fromItemCode} → #${i.itemCode}`);
  else if (i.itemCode) parts.push(`#${i.itemCode}`);
  if (i.size) parts.push(i.size);
  if (i.color) parts.push(i.color);
  if (i.qty && i.qty > 1) parts.push(`×${i.qty}`);
  return parts.join(" ");
}

function Confidence({ value, threshold }: { value: number; threshold: number }) {
  const pct = Math.round(value * 100);
  const low = value < threshold;
  return (
    <span className="inline-flex items-center gap-1.5" title={`Confidence ${value.toFixed(2)}; below ${threshold.toFixed(2)} goes to review`}>
      <span className="relative h-1.5 w-10 overflow-hidden rounded-full bg-sunken">
        <span className={cx("absolute inset-y-0 left-0 rounded-full", low ? "bg-review" : "bg-ink-2")} style={{ width: `${pct}%` }} />
        <span className="absolute inset-y-0 w-px bg-ink/40" style={{ left: `${threshold * 100}%` }} />
      </span>
      <span className={cx("num font-mono text-[11px]", low ? "text-review" : "text-muted")}>{value.toFixed(2)}</span>
    </span>
  );
}

export function MethodBadge({ method }: { method: "rule" | "llm" }) {
  return (
    <span
      className={cx(
        "rounded px-1 py-px font-mono text-[10px] font-semibold uppercase tracking-wider",
        method === "llm" ? "bg-review-soft text-review" : "bg-sunken text-ink-2",
      )}
      title={method === "llm" ? "Resolved by the language model" : "Resolved by the deterministic rules"}
    >
      {method === "llm" ? "LLM" : "rule"}
    </span>
  );
}

function stubTime(ms: number) {
  const iso = new Date(ms).toISOString();
  return { hms: iso.slice(11, 19), ms: iso.slice(19, 23) };
}

export interface TicketProps {
  c: CommentView;
  offset: number;
  threshold: number;
  settleWindowMs: number;
  fresh?: boolean;
  onWhy?: (commentId: string) => void;
  compact?: boolean;
}

/** One comment as a claim ticket: the stub carries the platform timestamp that decides fairness. */
export function Ticket({ c, offset, threshold, settleWindowMs, fresh, onWhy, compact }: TicketProps) {
  const t = stubTime(c.platformTs);
  const lag = c.receivedTs - c.platformTs;
  const o = c.outcome;
  const multi = c.intents.length > 1;
  const quiet = o.tone === "chatter" || o.tone === "question";

  return (
    <li className={cx("ticket-wrap list-none", fresh && "anim-drop")}>
      <article className={cx("ticket", compact && "ticket-compact")} aria-label={`${c.displayName}: ${c.text}. ${o.label}`}>
        <div className="ticket-stub flex flex-col justify-between">
          <div>
            <div className="num font-mono text-[12.5px] font-semibold leading-none text-ink">{t.hms}</div>
            <div className="num mt-0.5 font-mono text-[10.5px] leading-none text-muted">{t.ms}</div>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <PlatformGlyph platform={c.platform} size={12} />
            {lag > 30 ? <span className="num font-mono text-[10px] text-muted" title="Ingestion lag: received minus sent">+{lag}ms</span> : null}
          </div>
        </div>

        <div className={cx("min-w-0 py-2.5 pl-4 pr-3", quiet && "opacity-80")}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-[13px] font-bold">{c.displayName}</span>
              </div>
              <p className={cx("mt-0.5 break-words text-[14.5px] leading-snug", quiet ? "text-ink-2" : "text-ink")}>{c.text}</p>
            </div>
            {!multi ? (
              <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
                <Stamp key={o.label} outcome={o} animate={fresh} />
                {o.settleUntil ? (
                  <span className="w-full">
                    <SettleBar until={o.settleUntil} offset={offset} windowMs={settleWindowMs} />
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="mt-2 space-y-1.5">
            {c.intents.map((i) => (
              <div key={i.index} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
                <span className="rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2">{intentText(i)}</span>
                <Confidence value={i.confidence} threshold={threshold} />
                <MethodBadge method={i.method} />
                {multi ? <Stamp key={i.outcome.label} outcome={i.outcome} animate={fresh} className="scale-90" /> : null}
                {i.outcome.detail ? <span className="text-[11.5px] text-muted">{i.outcome.detail}</span> : null}
                {i.outcome.leaseUntil ? (
                  <span className="inline-flex items-center gap-1 text-[11.5px] text-held">
                    <Icon.Clock size={12} /> pay within <Countdown until={i.outcome.leaseUntil} offset={offset} />
                  </span>
                ) : null}
              </div>
            ))}
          </div>

          <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted">
            <span className="num font-mono" title="Resolver wall time">
              {c.latencyMs < 1 ? `${c.latencyMs.toFixed(2)}ms` : `${Math.round(c.latencyMs)}ms`}
            </span>
            {onWhy && !quiet ? (
              <button type="button" onClick={() => onWhy(c.id)} className="inline-flex items-center gap-1 rounded font-semibold text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-brand">
                Why?
              </button>
            ) : null}
          </div>
        </div>
      </article>
    </li>
  );
}
