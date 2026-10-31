"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type CellValueChangedEvent, type ColDef, type GetRowIdParams, type GridApi, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import type { Proposal, ProposalKind, ProposalStatus } from "@claim/closer";
import type { CloserView, ShowAction } from "../../lib/types";
import { moneyExact } from "../../lib/stats";
import { Button, Icon, Spinner, cx, inputCls } from "../ui";
import type { ActResult } from "../use-show";

ModuleRegistry.registerModules([AllCommunityModule]);

/** Same tokens as the ledger grid, so both follow the light/dark theme. */
const queueTheme = themeQuartz.withParams({
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--ink)",
  textColor: "var(--ink)",
  subtleTextColor: "var(--muted)",
  borderColor: "var(--line)",
  accentColor: "var(--brand)",
  headerBackgroundColor: "var(--surface-2)",
  headerTextColor: "var(--ink-2)",
  headerFontWeight: 700,
  rowHoverColor: "var(--sunken)",
  oddRowBackgroundColor: "var(--surface)",
  selectedRowBackgroundColor: "var(--brand-soft)",
  inputFocusBorder: { color: "var(--brand)" },
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  headerFontSize: 12,
  spacing: 7,
  wrapperBorderRadius: 12,
  wrapperBorder: { color: "var(--line)" },
  cellHorizontalPadding: 12,
});

type Run = (key: string, a: ShowAction) => Promise<ActResult>;
type Notify = (tone: "ok" | "error" | "info", text: string) => void;

const ACTION: Record<ProposalKind, { label: string; icon: keyof typeof Icon }> = {
  charge: { label: "Charge Claim Pass", icon: "Wallet" },
  invoice: { label: "Send invoice", icon: "Receipt" },
  paylink: { label: "Pay-now link", icon: "Send" },
  reminder: { label: "Reminder", icon: "Clock" },
  refund: { label: "Refund", icon: "Undo" },
  tracking: { label: "Add tracking", icon: "Truck" },
  release: { label: "Release hold", icon: "X" },
};

const STATUS: Record<ProposalStatus, { label: string; cls: string }> = {
  proposed: { label: "Proposed", cls: "tone-bg-review" },
  approved: { label: "Approved", cls: "tone-bg-held" },
  running: { label: "Running", cls: "tone-bg-held" },
  done: { label: "Done", cls: "tone-bg-granted" },
  failed: { label: "Failed", cls: "tone-bg-danger" },
  rejected: { label: "Rejected", cls: "bg-sunken text-muted" },
  superseded: { label: "Replaced", cls: "bg-sunken text-muted" },
};

const EDITABLE: ProposalKind[] = ["invoice", "reminder", "refund"];

interface Ctx {
  decide: (p: Proposal, decision: "approve" | "reject") => void;
  pending: Set<string>;
  locked: boolean;
}

function ActionCell({ data }: ICellRendererParams<Proposal>) {
  if (!data) return null;
  const a = ACTION[data.kind];
  const I = Icon[a.icon];
  return (
    <span className="inline-flex items-center gap-2 font-semibold">
      <I size={14} className="shrink-0 text-ink-2" />
      {a.label}
    </span>
  );
}

function StatusCell({ data }: ICellRendererParams<Proposal>) {
  if (!data) return null;
  const s = STATUS[data.status];
  return (
    <span className={cx("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-bold", s.cls)}>
      {data.status === "running" ? <Spinner size={11} /> : null}
      {s.label}
    </span>
  );
}

function NoteCell({ data }: ICellRendererParams<Proposal>) {
  if (!data) return null;
  if (!data.note) return <span className="text-muted">-</span>;
  const editable = data.status === "proposed" && EDITABLE.includes(data.kind);
  return <span className={cx(editable && "decoration-line-strong underline decoration-dashed underline-offset-4")}>{data.note}</span>;
}

function ResultCell({ data }: ICellRendererParams<Proposal>) {
  const r = data?.result;
  if (!data || !r) return null;
  if (!r.ok) {
    return (
      <span className="flex w-full min-w-0 flex-col leading-tight" title={r.message}>
        <span className="break-all font-mono text-[11.5px] font-semibold text-danger">{r.code ?? "ERROR"}</span>
        {r.message ? <span className="line-clamp-2 text-[11.5px] text-muted">{r.message}</span> : null}
      </span>
    );
  }
  return (
    <span className="flex w-full min-w-0 flex-col leading-tight">
      <span className="break-all font-mono text-[11.5px]" title={r.detail ? `${r.id} · ${r.detail}` : r.id}>
        {r.id ?? "ok"}
      </span>
      {r.url ? (
        <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand hover:underline">
          {data.kind === "paylink" ? "Pay-now link" : "PayPal payer view"} <Icon.External size={11} />
        </a>
      ) : r.detail ? (
        <span className="block max-w-full truncate font-mono text-[11px] text-muted" title={r.detail}>
          {r.detail}
        </span>
      ) : null}
    </span>
  );
}

function DecideCell({ data, context }: ICellRendererParams<Proposal, unknown, Ctx>) {
  if (!data) return null;
  const busy = context.pending.has(data.id);
  if (data.status === "proposed") {
    return (
      <span className="inline-flex items-center gap-1">
        <Button size="sm" variant="ink" data-act="approve" className="h-7 px-2 text-[12px]" busy={busy} disabled={context.locked} onClick={() => context.decide(data, "approve")}>
          {busy ? null : <Icon.Check size={13} />} Approve
        </Button>
        <Button size="sm" variant="ghost" data-act="reject" className="h-7 px-2 text-[12px]" disabled={busy || context.locked} aria-label={`Reject: ${ACTION[data.kind].label} for ${data.buyer}`} title="Reject" onClick={() => context.decide(data, "reject")}>
          <Icon.X size={13} />
        </Button>
      </span>
    );
  }
  // Left approved by a restart mid-call: running it again replays the same PayPal request ids.
  if (data.status === "approved") {
    return (
      <Button size="sm" variant="outline" data-act="approve" className="h-7 px-2 text-[12px]" busy={busy} disabled={context.locked} onClick={() => context.decide(data, "approve")}>
        Run again
      </Button>
    );
  }
  return null;
}

const wrap = { wrapText: true, autoHeight: true, cellStyle: { lineHeight: "1.4", paddingTop: 8, paddingBottom: 8 } } as const;

/** The close-out agent: an instruction box, the plan it made, and an approval queue where nothing runs until the seller says so. */
export function Closer({ c, run, busy, notify }: { c: CloserView; run: Run; busy: string | null; notify: Notify }) {
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const plan = c.plans[0];
  const waiting = c.proposals.filter((p) => p.status === "proposed");
  const waitingCents = waiting.reduce((a, p) => a + p.amountCents, 0);
  const openInvoices = c.invoices.filter((i) => ["SENT", "UNPAID", "SCHEDULED", "PARTIALLY_PAID", "PAYMENT_PENDING"].includes(i.status));
  const planning = c.planning || busy === "closer-plan";
  const approvingAll = busy === "closer-all";

  const doPlan = async (text: string) => {
    const r = await run("closer-plan", { action: "closerPlan", ...(text.trim() ? { instruction: text.trim() } : {}) });
    if (r.ok) {
      const d = r.data as { proposals: number; answer?: string; summary: string };
      if (!d.proposals) notify("info", d.answer ?? d.summary);
    }
  };

  const decide = useCallback(
    async (p: Proposal, decision: "approve" | "reject") => {
      setPending((s) => new Set(s).add(p.id));
      const r = await run(`closer-${p.id}`, { action: "closerDecide", proposalId: p.id, decision });
      setPending((s) => {
        const n = new Set(s);
        n.delete(p.id);
        return n;
      });
      if (r.ok && decision === "approve") {
        const d = r.data as { status: ProposalStatus; result?: { code?: string } };
        if (d.status === "failed") notify("error", `${ACTION[p.kind].label} for ${p.buyer} failed: ${d.result?.code ?? "error"}`);
      }
    },
    [run, notify],
  );

  // One context object for the grid's lifetime; the button column re-renders when what it reads changes.
  const api = useRef<GridApi<Proposal> | null>(null);
  const context = useRef<Ctx>({ decide, pending, locked: approvingAll }).current;
  context.decide = decide;
  context.pending = pending;
  context.locked = approvingAll;
  // A status change alone leaves the note's value as it was, so the grid would not redraw it or the buttons.
  const statusKey = c.proposals.map((p) => `${p.id}:${p.status}`).join(",");
  useEffect(() => {
    api.current?.refreshCells({ columns: ["note", "decide"], force: true });
  }, [statusKey, pending, approvingAll]);

  // On a phone the grid scrolls sideways, so the buttons sit beside the action instead of pinned at the far edge.
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const anyOpen = c.proposals.some((p) => p.status === "proposed" || p.status === "approved");
  const columnDefs = useMemo<ColDef<Proposal>[]>(() => {
    const decideCol: ColDef<Proposal> = { colId: "decide", headerName: "", width: 128, cellRenderer: DecideCell, sortable: false, resizable: false, pinned: wide ? "right" : null, hide: !anyOpen };
    return [
      { colId: "action", headerName: "Action", width: 158, cellRenderer: ActionCell, valueGetter: (p) => (p.data ? ACTION[p.data.kind].label : "") },
      ...(wide ? [] : [decideCol]),
      { field: "buyer", headerName: "Buyer", width: 84, cellClass: "font-semibold" },
      { field: "amountCents", headerName: "Amount", width: 84, type: "rightAligned", valueFormatter: (p) => (p.value == null ? "" : moneyExact(p.value)), cellClass: ["num", "ag-right-aligned-cell"] },
      { field: "call", headerName: "PayPal call", width: 150, ...wrap, cellClass: "font-mono text-[11.5px] text-ink-2" },
      {
        field: "note",
        headerName: "Note to buyer",
        flex: 1.2,
        minWidth: 170,
        ...wrap,
        cellRenderer: NoteCell,
        editable: (p) => Boolean(p.data && p.data.status === "proposed" && EDITABLE.includes(p.data.kind)),
        cellEditor: "agLargeTextCellEditor",
        cellEditorPopup: true,
        cellEditorParams: { maxLength: 400, rows: 4, cols: 44 },
        tooltipValueGetter: (p) => (p.data && p.data.status === "proposed" && EDITABLE.includes(p.data.kind) ? "Double-click or press Enter to edit" : undefined),
      },
      { field: "why", headerName: "Why", flex: 1, minWidth: 140, ...wrap, cellClass: "text-ink-2" },
      { field: "status", headerName: "Status", width: 100, cellRenderer: StatusCell, enableCellChangeFlash: true },
      { colId: "result", headerName: "Result", width: 180, ...wrap, cellRenderer: ResultCell, valueGetter: (p) => p.data?.result?.id ?? p.data?.result?.code ?? "" },
      ...(wide ? [decideCol] : []),
    ];
  }, [wide, anyOpen]);
  const defaultColDef = useMemo<ColDef>(() => ({ sortable: false, resizable: true, suppressHeaderMenuButton: true }), []);
  const getRowId = useCallback((p: GetRowIdParams<Proposal>) => p.data.id, []);

  const onNoteChanged = useCallback(
    async (e: CellValueChangedEvent<Proposal>) => {
      if (e.colDef.field !== "note" || e.newValue === e.oldValue) return;
      const r = await run(`closer-edit-${e.data.id}`, { action: "closerDecide", proposalId: e.data.id, decision: "edit", note: String(e.newValue ?? "") });
      if (r.ok) notify("ok", `Note for ${e.data.buyer} saved`);
    },
    [run, notify],
  );

  // J/K move, A approve, R reject, as in the review lane. Captured before the grid sees them, so a letter on the
  // note column does not open the editor.
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const key = e.key.toLowerCase();
    if (!["j", "k", "a", "r"].includes(key)) return;
    const g = api.current;
    if (!g) return;
    e.preventDefault();
    e.stopPropagation();
    const focused = g.getFocusedCell();
    const count = g.getDisplayedRowCount();
    if (key === "j" || key === "k") {
      const i = focused ? Math.max(0, Math.min(count - 1, focused.rowIndex + (key === "j" ? 1 : -1))) : 0;
      g.ensureIndexVisible(i);
      g.setFocusedCell(i, focused?.column ?? "action");
      return;
    }
    const row = focused ? g.getDisplayedRowAtIndex(focused.rowIndex)?.data : undefined;
    if (row && (row.status === "proposed" || (key === "a" && row.status === "approved")) && !approvingAll) void decide(row, key === "a" ? "approve" : "reject");
  };

  return (
    <section aria-labelledby="closer-title" className="mt-8 rounded-2xl border border-line bg-surface shadow-card">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-3">
        <h2 id="closer-title" className="flex items-center gap-2 text-[15px] font-bold">
          <Icon.Spark size={15} className="text-brand" /> Closer
        </h2>
        <span className="text-[12.5px] text-muted">
          {c.planner === "closer" ? `Plans with ${c.model ?? "an AI model"}` : "Plans with rules (no AI model set)"} · {c.executor === "mock" ? "Runs on simulated payments" : `Runs on ${c.executorLabel}`}
        </span>
      </header>

      <div className="px-5 pt-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void doPlan(instruction);
          }}
        >
          <label htmlFor="closer-instruction" className="sr-only">
            Instruction for Closer
          </label>
          <input id="closer-instruction" value={instruction} maxLength={300} onChange={(e) => setInstruction(e.target.value)} placeholder="Tell Closer what to do…" className={cx(inputCls, "h-10 flex-1")} />
          <Button type="submit" variant="ink" busy={planning} className="sm:w-28">
            {planning ? null : <Icon.Spark size={15} />} {planning ? "Planning" : "Plan"}
          </Button>
        </form>
        <div className="-mx-5 mt-2.5 flex gap-1.5 overflow-x-auto px-5 pb-1" role="group" aria-label="Suggestions">
          {c.suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={planning}
              onClick={() => {
                setInstruction(s);
                void doPlan(s);
              }}
              className="inline-flex h-8 shrink-0 items-center rounded-full border border-line-strong bg-surface px-3 text-[12.5px] font-semibold text-ink-2 hover:bg-sunken disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-muted">Leave it empty and press Plan to close out the whole show.</p>
      </div>

      {plan ? (
        <div role="status" className="mx-5 mt-4 rounded-xl bg-surface-2 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {plan.label ? (
              <span className="tone-bg-waitlist rounded-full px-2 py-0.5 text-[11px] font-bold" title={plan.fallbackReason}>
                {plan.label}
              </span>
            ) : (
              <span className="tone-bg-review rounded-full px-2 py-0.5 text-[11px] font-bold">Closer</span>
            )}
            <span className="text-[14px] font-semibold">{plan.summary}</span>
          </div>
          {plan.answer ? <p className="mt-1 text-[13.5px]">{plan.answer}</p> : null}
          <p className="mt-1 text-[12px] text-muted">{plan.instruction ? `You asked: “${plan.instruction}”` : "You asked for the whole close-out."}</p>
        </div>
      ) : null}

      <div className="px-5 pb-5 pt-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-[14px] font-bold">
              Approval queue <span className="num text-muted">· {c.proposals.length}</span>
            </h3>
            <p className="mt-0.5 text-[12px] text-muted">
              Nothing runs until you approve. <span className="kbd">J</span> <span className="kbd">K</span> move · <span className="kbd">A</span> approve · <span className="kbd">R</span> reject
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {openInvoices.length ? (
              <Button
                size="sm"
                variant="outline"
                busy={busy === "closer-check"}
                onClick={async () => {
                  const r = await run("closer-check", { action: "closerCheck" });
                  if (r.ok) notify("info", (r.data as { answer: string }).answer);
                }}
              >
                <Icon.Search size={13} /> Check {openInvoices.length} invoice{openInvoices.length === 1 ? "" : "s"}
              </Button>
            ) : null}
            {waiting.length ? (
            <Button
              variant="brand"
              busy={approvingAll}
              onClick={async () => {
                const r = await run("closer-all", { action: "closerApproveAll" });
                if (r.ok) {
                  const d = r.data as { done: number; failed: number };
                  notify(d.failed ? "error" : "ok", `${d.done} done${d.failed ? ` · ${d.failed} failed` : ""}`);
                }
              }}
            >
              <Icon.Check size={16} /> Approve all ({waiting.length} · {moneyExact(waitingCents)})
            </Button>
            ) : null}
          </div>
        </div>

        {c.proposals.length ? (
          <div className="mt-3" onKeyDownCapture={onKeyDownCapture}>
            <AgGridReact<Proposal>
              theme={queueTheme}
              rowData={c.proposals}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              getRowId={getRowId}
              context={context}
              domLayout="autoHeight"
              onGridReady={(e) => (api.current = e.api)}
              onCellValueChanged={onNoteChanged}
              stopEditingWhenCellsLoseFocus
              tooltipShowDelay={300}
              animateRows
            />
          </div>
        ) : (
          <div className="mt-3 rounded-xl border border-dashed border-line-strong px-5 py-8 text-center text-[13px] text-muted">{planning ? "Closer is planning…" : "No plan yet. Proposals appear here, one row each."}</div>
        )}
      </div>
    </section>
  );
}
