"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { ShowAction, ShowView } from "../../lib/types";
import { SCENARIOS, type ScenarioId } from "../../lib/types";
import { clock, money, variantLabel } from "../../lib/stats";
import { Ticket } from "../ticket";
import { Button, Icon, LivePill, Logo, Panel, ThemeToggle, Toasts, cx, inputCls, useNow } from "../ui";
import { useFreshKeys, useShow, useToasts, type ActResult } from "../use-show";
import { AuditDrawer } from "./audit-drawer";
import { ItemBoard } from "./item-board";
import { ReviewLane } from "./review-lane";
import { VoiceListing } from "./voice-listing";

type Filter = "all" | "claims" | "review" | "other";

/** "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B" -> "Nemotron Nano"; other ids keep their last path segment. */
const modelName = (m: string) => {
  const id = m.split("/").pop() ?? m;
  const tier = /nemotron.*?(nano|super|ultra)/i.exec(id);
  return tier ? `Nemotron ${tier[1]![0]!.toUpperCase()}${tier[1]!.slice(1).toLowerCase()}` : id;
};

export function SellerConsole({ initial }: { initial: ShowView }) {
  const { view: v, act, offset, connected } = useShow(initial.showId, initial);
  const { toasts, push } = useToasts();
  const [filter, setFilter] = useState<Filter>("all");
  const [drawer, setDrawer] = useState<{ focus?: string } | null>(null);
  const [scenario, setScenario] = useState<ScenarioId>("race");
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow(1000, offset);

  const run = useCallback(
    async (key: string, a: ShowAction, okMsg?: string): Promise<ActResult> => {
      setBusy(key);
      const r = await act(a);
      setBusy(null);
      if (!r.ok) push("error", r.error);
      else if (okMsg) push("ok", okMsg);
      return r;
    },
    [act, push],
  );

  const onAir = v.items.find((i) => i.code === v.onAir);
  const onAirBoard = v.board.find((b) => b.code === v.onAir);
  const comments = useMemo(() => {
    if (filter === "claims") return v.comments.filter((c) => c.intents.some((i) => i.kind !== "question" && i.kind !== "other"));
    if (filter === "review") return v.comments.filter((c) => c.outcome.tone === "review");
    if (filter === "other") return v.comments.filter((c) => c.outcome.tone === "question" || c.outcome.tone === "chatter");
    return v.comments;
  }, [v.comments, filter]);
  const fresh = useFreshKeys(v.comments.map((c) => `${c.id}:${c.outcome.label}`));
  const ended = v.phase === "ended";
  const k = v.kpis;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* ---------- top bar ---------- */}
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="shrink-0 rounded" aria-label="Claim! home">
            <Logo size="sm" />
          </Link>
          <span className="hidden h-6 w-px bg-line sm:block" />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-bold leading-tight">{v.title}</div>
            <div className="truncate text-[11.5px] leading-tight text-muted">{v.shopName}</div>
          </div>
          <LivePill phase={v.phase} started={Boolean(v.startedAt)} />
          <span className="num hidden whitespace-nowrap font-mono text-[12px] text-muted 2xl:inline" title="Server time, UTC">
            {clock(now)} UTC
          </span>
          {!connected ? <span className="whitespace-nowrap text-[11.5px] font-semibold text-waitlist">reconnecting…</span> : null}
        </div>

        <div className="order-3 -mx-4 flex basis-[calc(100%+2rem)] items-center gap-2 overflow-x-auto px-4 pb-0.5 xl:order-2 xl:mx-0 xl:ml-auto xl:basis-auto xl:overflow-visible xl:p-0">
          {!ended ? (
            <div className="flex shrink-0 items-center rounded-xl border border-line-strong bg-surface-2 pl-2">
              <Icon.Sim size={14} className="text-muted" />
              <label htmlFor="scenario" className="sr-only">
                Simulation scenario
              </label>
              <select id="scenario" value={scenario} onChange={(e) => setScenario(e.target.value as ScenarioId)} className="h-9 max-w-[180px] bg-transparent px-2 text-[13px] font-semibold focus:outline-none sm:max-w-[210px]">
                {SCENARIOS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="ink" className="m-0.5" busy={busy === "sim"} disabled={Boolean(v.simulation)} onClick={() => run("sim", { action: "simulate", scenario })}>
                <Icon.Play size={12} /> {v.simulation ? "Running" : "Simulate"}
              </Button>
            </div>
          ) : null}
          {!ended ? <TwitchControl v={v} run={run} busy={busy === "twitch"} /> : null}
          {!ended && !v.startedAt ? (
            <Button size="sm" variant="brand" busy={busy === "start"} onClick={() => run("start", { action: "start" }, "You're live")}>
              <Icon.Play size={12} /> Start show
            </Button>
          ) : null}
          {!ended ? (
            <Button
              size="sm"
              variant="outline"
              busy={busy === "end"}
              onClick={async () => {
                const r = await run("end", { action: "end" });
                if (r.ok) window.location.href = `/seller/${v.showId}/closeout`;
              }}
            >
              <Icon.Stop size={11} /> End show
            </Button>
          ) : (
            <Link href={`/seller/${v.showId}/closeout`} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-semibold text-brand-ink">
              Close out <Icon.Arrow size={14} />
            </Link>
          )}
        </div>

        <div className="order-2 ml-auto flex shrink-0 items-center gap-1 xl:order-3 xl:ml-0">
          <span className="hidden h-6 w-px bg-line xl:block" />
          <Link href={`/live/${v.showId}`} target="_blank" aria-label="Open the buyer room" className="inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-ink-2 hover:bg-sunken">
            <Icon.Room size={15} /> <span className="hidden sm:inline">Room</span>
          </Link>
          <Link href={`/seller/${v.showId}/ledger`} aria-label="Open the ledger" className="inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-ink-2 hover:bg-sunken">
            <Icon.Table size={15} /> <span className="hidden sm:inline">Ledger</span>
          </Link>
          <button type="button" aria-label="Open the audit log" onClick={() => setDrawer({})} className="inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-ink-2 hover:bg-sunken">
            <Icon.Receipt size={15} /> <span className="hidden sm:inline">Audit</span>
          </button>
          <ThemeToggle />
        </div>
      </header>

      {/* ---------- KPIs ---------- */}
      <section aria-label="Show metrics" className="grid shrink-0 grid-cols-3 border-b border-line bg-surface min-[960px]:grid-cols-6">
        <Kpi label="Comments / min" value={String(k.commentsPerMin)} sub={`${k.totalComments} total`} />
        <Kpi label="Auto-resolved" value={k.autoResolved === null ? "–" : `${Math.round(k.autoResolved * 100)}%`} sub={`${k.claims} claims`} />
        <Kpi label="p95 resolve" value={k.p95LatencyMs === null ? "–" : k.p95LatencyMs < 10 ? `${k.p95LatencyMs.toFixed(1)}ms` : `${Math.round(k.p95LatencyMs)}ms`} sub={v.llm.provider === "mock" || v.llm.provider === "none" ? "rules · LLM off" : v.llm.provider === "nebius" ? `rules → ${modelName(v.llm.model)}${v.llm.escalateModel ? ` → ${modelName(v.llm.escalateModel)}` : ""}` : `rules + ${v.llm.provider}`} />
        <Kpi label="Held" value={money(k.heldCents, v.config.currency)} sub={k.chargedCents ? `${money(k.chargedCents)} charged` : "not yet charged"} />
        <Kpi label="Oversold" value={String(k.oversold)} tone={k.oversold === 0 ? "good" : "bad"} sub="units over stock" />
        <Kpi label="Needs you" value={String(k.reviewOpen)} tone={k.reviewOpen ? "review" : undefined} sub="in review" />
      </section>

      {/* ---------- workspace ---------- */}
      <main className="grid min-h-0 flex-1 grid-cols-1 content-start gap-3 overflow-y-auto p-3 min-[960px]:grid-cols-[minmax(300px,340px)_minmax(0,1fr)] xl:content-stretch xl:grid-cols-[340px_minmax(0,1fr)_380px] xl:overflow-hidden">
        {/* left: on air + voice */}
        <div className="scroll-thin flex flex-col gap-3 *:shrink-0 xl:min-h-0 xl:overflow-y-auto">
          <Panel title={onAir ? onAir.title : "Nothing on air"} eyebrow="On air" id="onair-title" aside={onAir ? <span className="display-tight text-2xl font-black text-brand">#{onAir.code}</span> : null}>
            {onAir && onAirBoard ? (
              <div className="p-4">
                <div className="flex items-baseline justify-between">
                  <span className="display text-3xl font-extrabold">{money(onAir.priceCents, v.config.currency)}</span>
                  <span className="text-[12px] text-muted">{onAirBoard.variants.reduce((a, x) => a + x.available, 0)} of {onAirBoard.variants.reduce((a, x) => a + x.qty, 0)} left</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {onAirBoard.variants.map((x) => (
                    <span key={x.sku} className={cx("inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12.5px] font-semibold", x.available ? "border-line-strong" : "border-line text-muted line-through decoration-1")}>
                      {variantLabel(x)} <span className="num font-mono text-[11px] text-muted no-underline">{x.available}/{x.qty}</span>
                    </span>
                  ))}
                </div>
                {onAir.transcript ? <p className="mt-3 border-l-2 border-brand/40 pl-2.5 text-[12px] italic leading-snug text-muted">“{onAir.transcript}”</p> : null}
              </div>
            ) : (
              <p className="p-4 text-sm text-muted">Describe an item below and confirm it to put it on air.</p>
            )}
            {v.items.length > 1 ? (
              <div className="border-t border-line px-4 py-2.5">
                <div className="eyebrow mb-1.5">Run sheet</div>
                <ul className="flex flex-wrap gap-1.5">
                  {v.items.map((i) => (
                    <li key={i.code}>
                      <button
                        type="button"
                        disabled={ended}
                        aria-pressed={i.code === v.onAir}
                        onClick={() => run(`air-${i.code}`, { action: "onAir", code: i.code })}
                        className={cx(
                          "rounded-lg px-2 py-1 text-[12px] font-semibold transition-colors",
                          i.code === v.onAir ? "bg-ink text-paper" : "bg-sunken text-ink-2 hover:bg-line",
                        )}
                        title={i.title}
                      >
                        #{i.code} {i.title.split(" ").slice(-1)[0]}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>

          {!ended ? (
            <Panel title="Voice listing" id="voice-title">
              <VoiceListing act={act} onListed={(m, ok) => push(ok ? "ok" : "error", m)} />
            </Panel>
          ) : null}

          <StreamSetting v={v} run={run} />
        </div>

        {/* center: comment stream */}
        <Panel
          className="h-[min(680px,85dvh)] xl:h-auto"
          title="Live comments"
          eyebrow={`${v.comments.length} resolved · newest first`}
          id="stream-title"
          aside={
            <div role="tablist" aria-label="Filter comments" className="flex rounded-lg bg-sunken p-0.5">
              {(["all", "claims", "review", "other"] as Filter[]).map((f) => (
                <button
                  key={f}
                  role="tab"
                  type="button"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={cx("rounded-md px-2.5 py-1 text-[12px] font-semibold capitalize", filter === f ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}
                >
                  {f === "review" ? "Needs you" : f === "other" ? "Questions" : f}
                </button>
              ))}
            </div>
          }
          bodyClassName="flex flex-col"
        >
          {v.simulation ? (
            <div className="flex items-center gap-2 border-b border-line bg-sunken/60 px-4 py-2 text-[12.5px] font-semibold text-ink-2">
              <span className="live-dot size-1.5 rounded-full bg-brand" /> Simulating: {v.simulation.label}
            </div>
          ) : null}
          {comments.length ? (
            <ol aria-live="polite" aria-relevant="additions" className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto bg-paper/60 p-3">
              {comments.map((c) => (
                <Ticket
                  key={c.id}
                  c={c}
                  offset={offset}
                  threshold={v.config.confidenceThreshold}
                  settleWindowMs={v.config.settleWindowMs}
                  fresh={fresh.has(`${c.id}:${c.outcome.label}`)}
                  onWhy={(id) => setDrawer({ focus: id })}
                />
              ))}
            </ol>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <div className="grid size-12 place-items-center rounded-2xl bg-sunken text-muted">
                <Icon.Chat size={22} />
              </div>
              <p className="max-w-xs text-[14px] font-semibold">{filter === "all" ? "No comments yet" : "Nothing in this filter"}</p>
              {filter === "all" ? (
                <p className="max-w-xs text-[13px] text-muted">
                  Run a simulation, connect a Twitch channel, or open the{" "}
                  <Link href={`/live/${v.showId}`} target="_blank" className="font-semibold text-ink underline decoration-line-strong underline-offset-2">
                    buyer room
                  </Link>{" "}
                  and type a claim.
                </p>
              ) : null}
            </div>
          )}
        </Panel>

        {/* right: review + board */}
        <div className="scroll-thin flex flex-col gap-3 *:shrink-0 min-[960px]:col-span-2 min-[960px]:grid min-[960px]:grid-cols-2 min-[960px]:items-start xl:col-span-1 xl:flex xl:min-h-0 xl:flex-col xl:overflow-y-auto">
          <Panel
            title="Needs you"
            id="review-title"
            bodyClassName="scroll-thin overflow-y-auto xl:max-h-[48dvh]"
            aside={v.reviews.length ? <span className="tone-bg-review num rounded-full px-2 py-0.5 text-[12px] font-bold">{v.reviews.length}</span> : null}
          >
            <ReviewLane
              reviews={v.reviews}
              items={v.items}
              onDecide={async (id, decision, patch, quiet) => {
                const r = await run(`review-${id}`, { action: "review", reviewId: id, decision, ...(patch ? { patch } : {}) }, quiet ? undefined : decision === "approve" ? "Approved" : "Rejected");
                return r.ok;
              }}
              onBulkDone={(n) => push("ok", `Approved ${n} ${n === 1 ? "claim" : "claims"}`)}
            />
          </Panel>
          <Panel title="Item board" eyebrow="Sold · held · free · waitlist" id="board-title">
            <ItemBoard board={v.board} onAir={v.onAir} currency={v.config.currency} />
          </Panel>
        </div>
      </main>

      {drawer ? <AuditDrawer audit={v.audit} comments={v.comments} units={v.units} focus={drawer.focus} onClose={() => setDrawer(null)} /> : null}
      <Toasts toasts={toasts} />
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" | "review" }) {
  return (
    <div className="border-r border-line px-4 py-2.5 last:border-r-0">
      <div className="eyebrow">{label}</div>
      <div className={cx("display-tight num mt-0.5 text-[26px] font-extrabold leading-none", tone === "good" && "text-granted", tone === "bad" && "text-danger", tone === "review" && "text-review")}>{value}</div>
      {sub ? <div className="mt-1 truncate text-[11px] text-muted">{sub}</div> : null}
    </div>
  );
}

type Run = (key: string, a: ShowAction, okMsg?: string) => Promise<ActResult>;

function TwitchControl({ v, run, busy }: { v: ShowView; run: Run; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState(v.twitch.channel ?? "");
  const on = v.twitch.state !== "off";
  return (
    <div className="relative">
      <Button size="sm" variant={on ? "soft" : "ghost"} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon.Twitch size={14} />
        {on ? (
          <span className="inline-flex items-center gap-1.5">
            <span className={cx("size-1.5 rounded-full", v.twitch.state === "live" ? "live-dot bg-granted" : v.twitch.state === "error" ? "bg-danger" : "bg-waitlist")} />#{v.twitch.channel}
          </span>
        ) : (
          "Twitch"
        )}
      </Button>
      {open ? (
        <div className="anim-drop absolute right-0 top-10 z-30 w-72 rounded-xl border border-line bg-surface p-3 shadow-card">
          <p className="text-[13px] font-bold">Read a Twitch chat</p>
          <p className="mt-0.5 text-[12px] text-muted">Anonymous and read-only. Comments flow through the same resolver; tmi-sent-ts sets the fairness order.</p>
          <form
            className="mt-2.5 flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              await run("twitch", { action: "twitch", channel }, `Reading #${channel}`);
            }}
          >
            <label htmlFor="twitch-channel" className="sr-only">
              Channel
            </label>
            <input id="twitch-channel" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="channel name" className={inputCls} />
            <Button type="submit" size="sm" variant="ink" busy={busy} disabled={!channel.trim()}>
              Connect
            </Button>
          </form>
          {on ? (
            <div className="mt-2.5 flex items-center justify-between text-[12px]">
              <span className="text-muted">
                {v.twitch.state} · {v.twitch.messages} msgs{v.twitch.lagP50Ms !== undefined ? ` · p50 lag ${Math.round(v.twitch.lagP50Ms)}ms` : ""}
              </span>
              <button type="button" className="font-semibold text-danger" onClick={() => run("twitch", { action: "twitch" }, "Twitch disconnected")}>
                Disconnect
              </button>
            </div>
          ) : null}
          {v.twitch.error ? <p className="mt-1.5 text-[12px] text-danger">{v.twitch.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function StreamSetting({ v, run }: { v: ShowView; run: Run }) {
  const [url, setUrl] = useState(v.streamUrl ?? "");
  return (
    <form
      className="rounded-2xl border border-line bg-surface p-4 shadow-card"
      onSubmit={(e) => {
        e.preventDefault();
        void run("stream", { action: "setStream", streamUrl: url }, url ? "Stream link saved" : "Stream link cleared");
      }}
    >
      <label htmlFor="stream-url" className="text-[13px] font-bold">
        Video in the buyer room
      </label>
      <p className="mt-0.5 text-[12px] text-muted">Paste a YouTube live or video link. Without one, buyers see the on-air card.</p>
      <div className="mt-2 flex gap-2">
        <input id="stream-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://youtube.com/live/…" className={inputCls} />
        <Button type="submit" size="sm" variant="outline">
          Save
        </Button>
      </div>
    </form>
  );
}
