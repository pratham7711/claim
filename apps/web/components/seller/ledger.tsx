"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GetRowIdParams, type ICellRendererParams, type IRowNode, type ValueFormatterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import type { UnitStatus } from "@claim/core";
import type { ShowView, UnitView } from "../../lib/types";
import { baseCommentId, clockMs, money, shipToText } from "../../lib/stats";
import { useShow } from "../use-show";
import { Icon, Logo, MockBanner, ThemeToggle, cx } from "../ui";

ModuleRegistry.registerModules([AllCommunityModule]);

/** The grid draws from the app's tokens, so it follows the light/dark theme without a second palette. */
const ledgerTheme = themeQuartz.withParams({
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
  wrapperBorderRadius: 16,
  wrapperBorder: { color: "var(--line)" },
  cellHorizontalPadding: 12,
});

type Tone = "granted" | "held" | "waitlist" | "danger" | "muted";

interface LedgerRow {
  id: string;
  claimedAt?: number;
  buyer: string;
  item: string;
  variant: string;
  priceCents: number;
  status: UnitStatus;
  statusLabel: string;
  tone: Tone;
  paid: boolean;
  via: string;
  decidedBy: string;
  confidence?: number;
  comment?: string;
  why?: string;
  cart?: string;
  shipTo?: string;
}

interface TotalsRow {
  id: string;
  buyer: string;
  priceCents: number;
  statusLabel: string;
}

type Filter = "all" | "sold" | "unpaid" | "paid" | "waitlist" | "released";

const SOLD: UnitStatus[] = ["held", "confirmed", "charged"];

const FILTERS: { key: Filter; label: string; test: (r: LedgerRow) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "sold", label: "Sold", test: (r) => SOLD.includes(r.status) },
  { key: "unpaid", label: "Unpaid", test: (r) => SOLD.includes(r.status) && !r.paid },
  { key: "paid", label: "Paid", test: (r) => r.paid },
  { key: "waitlist", label: "Waitlist", test: (r) => r.status === "waitlisted" },
  { key: "released", label: "Released", test: (r) => r.status === "released" },
];

function statusOf(u: UnitView): { label: string; tone: Tone } {
  if (u.paid || u.status === "charged") return { label: "Paid", tone: "granted" };
  switch (u.status) {
    case "confirmed":
      return { label: "Sold", tone: "granted" };
    case "held":
      return { label: u.via === "pay-now" ? "Held · pay now" : "Held", tone: "held" };
    case "waitlisted":
      return { label: u.waitlistPos ? `Waitlist #${u.waitlistPos}` : "Waitlist", tone: "waitlist" };
    case "released":
      return { label: "Released", tone: "danger" };
    default:
      return { label: "Pending", tone: "muted" };
  }
}

function toRows(v: ShowView): LedgerRow[] {
  const comments = new Map(v.comments.map((c) => [c.id, c]));
  const shipTo = new Map(v.charges.flatMap((c) => (c.status === "COMPLETED" && c.shipTo ? [[c.cartId, shipToText(c.shipTo)] as const] : [])));
  return v.units.map((u) => {
    const c = u.commentId ? comments.get(baseCommentId(u.commentId)) : undefined;
    const intent = c?.intents.find((i) => i.itemCode === u.itemCode) ?? c?.intents[0];
    const { label, tone } = statusOf(u);
    return {
      id: u.id,
      claimedAt: c?.platformTs,
      buyer: u.displayName,
      item: `#${u.itemCode} ${u.title}`,
      variant: u.label.replace(new RegExp(`^#${u.itemCode}\\s+`), ""),
      priceCents: u.priceCents,
      status: u.status,
      statusLabel: label,
      tone,
      paid: u.paid,
      via: u.via === "claim-pass" ? "Claim Pass" : u.via === "pay-now" ? "Pay-now link" : "",
      decidedBy: !intent ? "" : intent.method === "llm" ? "AI" : "Rules",
      confidence: intent?.confidence,
      comment: c?.text,
      why: u.status === "released" ? u.releaseCause : intent?.rationale,
      cart: u.cartId,
      shipTo: u.cartId ? shipTo.get(u.cartId) : undefined,
    };
  });
}

function StatusCell({ data, node }: ICellRendererParams<LedgerRow | TotalsRow>) {
  if (!data) return null;
  if (node.rowPinned) return <span className="text-[12px] font-semibold text-ink-2">{data.statusLabel}</span>;
  const row = data as LedgerRow;
  return <span className={cx("inline-flex h-6 items-center rounded-full px-2.5 text-[11.5px] font-bold", row.tone === "muted" ? "bg-sunken text-muted" : `tone-bg-${row.tone}`)}>{row.statusLabel}</span>;
}

function DecidedCell({ data, node }: ICellRendererParams<LedgerRow | TotalsRow>) {
  if (!data || node.rowPinned) return null;
  const row = data as LedgerRow;
  if (!row.decidedBy) return <span className="text-muted">-</span>;
  return (
    <span className="inline-flex items-center gap-1.5" title={row.why}>
      {row.decidedBy === "AI" ? <Icon.Spark size={13} className="text-brand" /> : <Icon.Bolt size={13} className="text-muted" />}
      <span className="font-semibold">{row.decidedBy}</span>
      {row.confidence !== undefined ? <span className="num font-mono text-[11.5px] text-muted">{row.confidence.toFixed(2)}</span> : null}
    </span>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const fmtMoney = (p: ValueFormatterParams<LedgerRow, number>) => (p.value == null ? "" : money(p.value));

export function Ledger({ initial }: { initial: ShowView }) {
  const { view: v, connected } = useShow(initial.showId, initial, "seller");
  const grid = useRef<AgGridReact<LedgerRow>>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const filterRef = useRef<Filter>("all");

  const rows = useMemo(() => toRows(v), [v]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, rows.filter(f.test).length])) as Record<Filter, number>, [rows]);
  const sold = rows.filter((r) => SOLD.includes(r.status));
  const totals: TotalsRow[] = useMemo(
    () => [{ id: "totals", buyer: `${sold.length} sold · ${plural(new Set(sold.map((r) => r.buyer)).size, "buyer")}`, priceCents: sold.reduce((a, r) => a + r.priceCents, 0), statusLabel: `${money(sold.filter((r) => r.paid).reduce((a, r) => a + r.priceCents, 0))} paid` }],
    [sold],
  );

  useEffect(() => {
    filterRef.current = filter;
    grid.current?.api?.onFilterChanged();
  }, [filter]);

  const isExternalFilterPresent = useCallback(() => filterRef.current !== "all", []);
  const doesExternalFilterPass = useCallback((node: IRowNode<LedgerRow>) => !node.data || FILTERS.find((f) => f.key === filterRef.current)!.test(node.data), []);
  const getRowId = useCallback((p: GetRowIdParams<LedgerRow>) => p.data.id, []);

  const columnDefs = useMemo<ColDef<LedgerRow>[]>(
    () => [
      { field: "claimedAt", headerName: "Claimed", width: 128, sort: "desc", valueFormatter: (p) => (p.value ? clockMs(p.value) : ""), cellClass: "num font-mono text-[12px]" },
      { field: "buyer", headerName: "Buyer", width: 150, pinned: "left", cellClass: "font-semibold" },
      { field: "item", headerName: "Item", flex: 1, minWidth: 200 },
      { field: "variant", headerName: "Variant", width: 120 },
      { field: "priceCents", headerName: "Price", width: 100, type: "rightAligned", valueFormatter: fmtMoney, cellClass: ["num", "ag-right-aligned-cell"], filter: "agNumberColumnFilter" },
      { field: "statusLabel", headerName: "Status", width: 150, cellRenderer: StatusCell, enableCellChangeFlash: true },
      { field: "via", headerName: "Payment", width: 130, enableCellChangeFlash: true },
      { field: "shipTo", headerName: "Ship to", width: 230, cellClass: "text-ink-2", tooltipField: "shipTo", enableCellChangeFlash: true },
      { field: "decidedBy", headerName: "Decided by", width: 140, cellRenderer: DecidedCell, tooltipField: "why" },
      { field: "comment", headerName: "Comment", flex: 1, minWidth: 180, cellClass: "text-ink-2", tooltipField: "comment" },
      { field: "cart", headerName: "Cart", width: 120, cellClass: "num font-mono text-[11.5px] text-muted", valueFormatter: (p) => (p.value ? String(p.value).slice(-8) : "") },
    ],
    [],
  );
  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true, filter: true, suppressHeaderMenuButton: false }), []);

  const exportCsv = () =>
    grid.current?.api?.exportDataAsCsv({
      fileName: `claim-ledger-${v.showId}.csv`,
      processCellCallback: (p) => (p.column.getColId() === "priceCents" && typeof p.value === "number" ? (p.value / 100).toFixed(2) : p.column.getColId() === "claimedAt" && p.value ? new Date(p.value).toISOString() : p.value),
      skipPinnedBottom: true,
    });

  return (
    <div className="flex h-dvh flex-col">
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/90 px-5 backdrop-blur">
        <Link href={`/seller/${v.showId}`} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-semibold text-ink-2 hover:bg-sunken">
          <Icon.ArrowLeft size={15} /> Console
        </Link>
        <span className="h-6 w-px bg-line" />
        <span className="hidden min-w-0 sm:contents">
          <Logo size="sm" />
          <span className="truncate text-[13px] text-muted">
            {v.shopName} · {v.title}
          </span>
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <Link href={`/seller/${v.showId}/closeout`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-ink-2 hover:bg-sunken">
            <Icon.Wallet size={15} /> <span className="hidden sm:inline">Close-out</span>
          </Link>
          <span className="hidden md:inline-flex">
            <MockBanner label={v.payments.label} mode={v.payments.mode} />
          </span>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1400px] min-h-0 flex-1 flex-col px-4 pb-5 pt-6 sm:px-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="display text-[34px] font-black leading-[0.95] tracking-tight sm:text-[40px]">Ledger</h1>
            <p className="mt-2 max-w-xl text-[14px] text-ink-2">
              Every unit claimed in this show, one row each, updating as the desk decides.{" "}
              <span className={cx("inline-flex items-center gap-1.5 text-[12.5px] font-semibold", connected ? "text-granted" : "text-muted")}>
                <span className={cx("size-1.5 rounded-full", connected ? "bg-granted" : "bg-muted")} />
                {connected ? (v.phase === "live" ? "Live" : "Show ended") : "Reconnecting"}
              </span>
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <label className="relative flex-1 sm:w-64 sm:flex-none">
              <span className="sr-only">Search the ledger</span>
              <Icon.Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buyer, item or comment"
                className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-[13px] text-ink placeholder:text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
              />
            </label>
            <button type="button" onClick={exportCsv} disabled={!rows.length} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-sunken disabled:opacity-50">
              <Icon.Download size={15} /> Export CSV
            </button>
          </div>
        </div>

        <div role="group" aria-label="Filter by status" className="-mx-4 mt-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cx(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors",
                filter === f.key ? "border-ink bg-ink text-paper" : "border-line-strong bg-surface text-ink-2 hover:bg-sunken",
              )}
            >
              {f.label}
              <span className={cx("num font-mono text-[11px]", filter === f.key ? "opacity-70" : "text-muted")}>{counts[f.key]}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 min-h-[420px] flex-1">
          <AgGridReact<LedgerRow>
            ref={grid}
            theme={ledgerTheme}
            rowData={rows}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getRowId={getRowId}
            pinnedBottomRowData={totals as unknown as LedgerRow[]}
            quickFilterText={query}
            isExternalFilterPresent={isExternalFilterPresent}
            doesExternalFilterPass={doesExternalFilterPass}
            animateRows
            tooltipShowDelay={300}
            overlayNoRowsTemplate={'<span class="text-[13px] text-muted">No claims yet. Units appear here the moment the desk grants or waitlists them.</span>'}
          />
        </div>
      </main>
    </div>
  );
}
