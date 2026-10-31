"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { BuyerCarts, Cart } from "@claim/core";
import type { OrderRecord, ShowAction, ShowView } from "../lib/types";
import { money, moneyExact, shipToLines } from "../lib/stats";
import { AuditDrawer } from "./seller/audit-drawer";
import { Closer } from "./seller/closer";
import { Button, Icon, Logo, MockBanner, Stamp, ThemeToggle, Toasts, cx, inputCls } from "./ui";
import { useFreshKeys, useShow, useToasts, type ActResult } from "./use-show";

type Run = (key: string, a: ShowAction, okMsg?: string) => Promise<ActResult>;

const FLAG_LABEL: Record<string, string> = {
  "over-cap": "Over cap",
  "seller-override": "Seller override",
  "pay-now-balance": "Balance on pay-now",
  supplementary: "Supplementary cart",
};

function cartStamp(c: Cart, isPreview: boolean) {
  if (isPreview) return { tone: "pending" as const, label: "PREVIEW" };
  if (c.status === "charged") return { tone: "sold" as const, label: "CHARGED" };
  if (c.status === "declined") return { tone: "rejected" as const, label: "DECLINED" };
  return { tone: "held" as const, label: "DUE" };
}

/** Buyers who need the seller first: declines, then unpaid holds, then carts still due, then the settled. */
function byAttention(v: ShowView): BuyerCarts[] {
  const rank = (b: BuyerCarts) => {
    if (b.finalized.some((c) => c.status === "declined")) return 0;
    if (v.units.some((u) => u.buyerKey === b.buyerKey && u.status === "held" && !u.paid)) return 1;
    if (b.finalized.some((c) => c.status !== "charged") || (b.preview?.dueCents ?? 0) > 0) return 2;
    if (b.finalized.length) return 3;
    return 4;
  };
  return v.carts.map((b, i) => ({ b, i, r: rank(b) })).sort((x, y) => x.r - y.r || x.i - y.i).map((x) => x.b);
}

/** Nothing to bill and nothing to act on: the buyer only queued for items that never came free. */
function isWaitlistOnly(b: BuyerCarts, v: ShowView): boolean {
  if (b.finalized.length || b.preview) return false;
  if (v.orders.some((o) => o.buyerKey === b.buyerKey && o.status === "open")) return false;
  const units = v.units.filter((u) => u.buyerKey === b.buyerKey);
  return units.length > 0 && units.every((u) => u.status === "waitlisted" || u.status === "released");
}

function WaitlistOnly({ buyers, v }: { buyers: BuyerCarts[]; v: ShowView }) {
  return (
    <section aria-labelledby="waitlist-only" className="mt-8 rounded-2xl border border-line bg-surface shadow-card">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3">
        <h2 id="waitlist-only" className="text-[15px] font-bold">
          Waitlist only <span className="num text-muted">· {buyers.length}</span>
        </h2>
        <span className="text-[12.5px] text-muted">Nothing came free for them, so there is nothing to bill.</span>
      </header>
      <ul className="divide-y divide-line">
        {buyers.map((b) => {
          const waiting = v.units.filter((u) => u.buyerKey === b.buyerKey && u.status === "waitlisted");
          const pass = v.buyers.find((x) => x.buyerKey === b.buyerKey)?.hasPass;
          return (
            <li key={b.buyerKey} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-2.5 text-[13px]">
              <span className="min-w-0">
                <span className="font-semibold">{b.displayName}</span>
                <span className="text-muted">
                  {" "}
                  · {b.buyerKey.split(":")[0]}
                  {pass ? " · Claim Pass" : ""}
                </span>
              </span>
              <span className="text-waitlist">{waiting.map((w) => `${w.label} (#${w.waitlistPos ?? "?"})`).join(", ") || "Released"}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Closeout({ initial }: { initial: ShowView }) {
  const { view: v, act } = useShow(initial.showId, initial, "seller");
  const { toasts, push } = useToasts();
  const [busy, setBusy] = useState<string | null>(null);
  const [audit, setAudit] = useState(false);
  const closeAudit = useCallback(() => setAudit(false), []);
  const run: Run = useCallback(
    async (key, a, okMsg) => {
      setBusy(key);
      const r = await act(a);
      setBusy(null);
      if (!r.ok) push("error", r.error);
      else if (okMsg) push("ok", okMsg);
      return r;
    },
    [act, push],
  );

  const ended = v.phase === "ended";
  const all = v.carts.flatMap((b) => [...b.finalized, ...(b.preview ? [b.preview] : [])]);
  const vaultDue = v.carts.flatMap((b) => [
    ...b.finalized.filter((c) => c.status === "pending" && c.chargeMode === "vault"),
    ...(b.preview && b.preview.chargeMode === "vault" ? [b.preview] : []),
  ]);
  const vaultDueCents = vaultDue.reduce((a, c) => a + c.dueCents, 0);
  const chargedCents = v.charges.filter((c) => c.status === "COMPLETED").reduce((a, c) => a + c.amountCents, 0);
  const refundedCents = v.refunds.reduce((a, r) => a + r.amountCents, 0);
  const shipSaved = all.reduce((a, c) => a + Math.max(0, c.units * v.config.shipping.firstItemCents - c.shippingCents), 0);
  const declined = v.charges.filter((c) => c.status === "DECLINED").length;
  const fresh = useFreshKeys(v.carts.flatMap((b) => b.finalized.map((c) => `${c.cartId}:${c.status}`)));
  const ordered = byAttention(v);
  const waitOnly = ordered.filter((b) => isWaitlistOnly(b, v));
  const billable = ordered.filter((b) => !isWaitlistOnly(b, v));

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-5 backdrop-blur">
        <Link href={`/seller/${v.showId}`} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-semibold text-ink-2 hover:bg-sunken">
          <Icon.ArrowLeft size={15} /> Console
        </Link>
        <span className="h-6 w-px bg-line" />
        <span className="hidden sm:contents">
          <Logo size="sm" />
          <span className="truncate text-[13px] text-muted">
            {v.shopName} · {v.title}
          </span>
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <Link href={`/seller/${v.showId}/ledger`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-ink-2 hover:bg-sunken">
            <Icon.Table size={15} /> <span className="hidden sm:inline">Ledger</span>
          </Link>
          <button type="button" aria-label="Open the audit log" onClick={() => setAudit(true)} className="inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-ink-2 hover:bg-sunken">
            <Icon.Receipt size={15} /> <span className="hidden sm:inline">Audit</span>
          </button>
          <span className="hidden md:inline-flex">
            <MockBanner label={v.payments.label} mode={v.payments.mode} />
          </span>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-5 pb-20 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <h1 className="display text-[40px] font-black leading-[0.95] tracking-tight sm:text-[44px]">Close-out</h1>
            <p className="mt-2 max-w-xl text-[15px] text-ink-2">
              One cart per buyer with combined shipping. Nothing is charged until you press the button, and a declined card puts its items back on a pay-now link or the waitlist.
            </p>
            <div className="mt-3 md:hidden">
              <MockBanner label={v.payments.label} mode={v.payments.mode} />
            </div>
          </div>
          {ended && !vaultDue.length ? (
            <div role="status" className={cx("flex items-center gap-3 rounded-2xl px-4 py-3 text-[14px]", chargedCents ? "tone-bg-granted" : "border border-line-strong bg-surface-2 text-ink-2")}>
              {chargedCents ? <Icon.Check size={18} /> : <Icon.Wallet size={18} />}
              <div>
                <div className="font-bold">{chargedCents ? "Every Claim Pass cart is charged" : "No Claim Pass carts to charge"}</div>
                <div className="text-[12.5px] opacity-80">{chargedCents ? "Pay-now buyers and declines are below." : "Buyers without a Claim Pass pay through their own link."}</div>
              </div>
            </div>
          ) : ended ? (
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <Button
                size="lg"
                variant="brand"
                busy={busy === "charge"}
                onClick={async () => {
                  const r = await run("charge", { action: "chargeAll" });
                  if (r.ok) {
                    const d = r.data as { charged: number; declined: number; totalCents: number };
                    push(d.declined ? "error" : "ok", `Charged ${d.charged} buyer${d.charged === 1 ? "" : "s"} ${moneyExact(d.totalCents)}${d.declined ? ` · ${d.declined} declined` : ""}`);
                  }
                }}
              >
                <Icon.Wallet size={18} />
                Charge {vaultDue.length} Claim Pass cart{vaultDue.length === 1 ? "" : "s"} · {moneyExact(vaultDueCents)}
              </Button>
              <span className="text-[12px] text-muted">Merchant-initiated orders against each buyer's saved PayPal.</span>
            </div>
          ) : (
            <div className="flex flex-col items-end gap-2">
              <Button size="lg" variant="ink" busy={busy === "end"} onClick={() => run("end", { action: "end" }, "Show ended. Carts are ready to review.")}>
                <Icon.Stop size={14} /> End the show to build carts
              </Button>
              <span className="text-[12px] text-muted">Below is a preview of what each buyer would be billed now.</span>
            </div>
          )}
        </div>

        <dl className="mt-8 grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-surface shadow-card md:grid-cols-5">
          <Stat label="Buyers" value={String(v.carts.length)} />
          <Stat label="Due on Claim Pass" value={money(vaultDueCents)} />
          <Stat label="Charged" value={money(chargedCents)} tone="good" />
          <Stat label="Shipping combined" value={money(shipSaved)} sub="saved vs per-item" />
          <Stat label="Declines · refunds" value={`${declined} · ${money(refundedCents)}`} />
        </dl>

        {ended && v.closer ? <Closer c={v.closer} run={run} busy={busy} notify={push} /> : null}

        {v.carts.length ? (
          <>
            {billable.length ? (
              <ul className="mt-8 grid items-start gap-4 md:grid-cols-2">
                {billable.map((b) => (
                  <BuyerCard key={b.buyerKey} b={b} v={v} run={run} busy={busy} fresh={fresh} />
                ))}
              </ul>
            ) : null}
            {waitOnly.length ? <WaitlistOnly buyers={waitOnly} v={v} /> : null}
          </>
        ) : (
          <div className="mt-10 rounded-2xl border border-dashed border-line-strong p-10 text-center">
            <p className="text-[15px] font-semibold">No buyers yet</p>
            <p className="mt-1 text-[13px] text-muted">Claims from the show appear here as carts.</p>
          </div>
        )}
      </main>
      <Toasts toasts={toasts} />
      {audit ? <AuditDrawer audit={v.audit} comments={v.comments} units={v.units} closerLog={v.closer?.log} onClose={closeAudit} /> : null}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" }) {
  return (
    <div className="border-b border-r border-line px-5 py-4 last:border-r-0 md:border-b-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={cx("display-tight num mt-1 text-[28px] font-extrabold leading-none", tone === "good" && "text-granted")}>{value}</dd>
      {sub ? <dd className="mt-1 text-[11.5px] text-muted">{sub}</dd> : null}
    </div>
  );
}

function BuyerCard({ b, v, run, busy, fresh }: { b: BuyerCarts; v: ShowView; run: Run; busy: string | null; fresh: Set<string> }) {
  const buyer = v.buyers.find((x) => x.buyerKey === b.buyerKey);
  const carts: { cart: Cart; preview: boolean }[] = [...b.finalized.map((c) => ({ cart: c, preview: false })), ...(b.preview ? [{ cart: b.preview, preview: true }] : [])];
  const holds = v.units.filter((u) => u.buyerKey === b.buyerKey && u.status === "held" && !u.paid);
  const waiting = v.units.filter((u) => u.buyerKey === b.buyerKey && u.status === "waitlisted");
  const orders = v.orders.filter((o) => o.buyerKey === b.buyerKey);
  const declinedCart = b.finalized.find((c) => c.status === "declined");
  const ended = v.phase === "ended";

  return (
    <li className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <header className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0">
          <div className="truncate text-[16px] font-bold">{b.displayName}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
            <span className="font-mono">{b.buyerKey.split(":")[0]}</span>
            {buyer?.hasPass ? (
              <span className="tone-bg-granted inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-bold uppercase tracking-wide">
                <Icon.Wallet size={11} /> Claim Pass
              </span>
            ) : (
              <span className="rounded-full bg-sunken px-1.5 py-px text-[10.5px] font-bold uppercase tracking-wide text-ink-2">Pay-now</span>
            )}
          </div>
        </div>
      </header>
      <div className="perforation mx-5" />

      {carts.map(({ cart, preview }) => {
        const st = cartStamp(cart, preview);
        const charge = [...v.charges].reverse().find((c) => c.cartId === cart.cartId);
        const refunds = v.refunds.filter((r) => r.cartId === cart.cartId);
        const tracking = v.tracking.filter((t) => t.cartId === cart.cartId);
        const hooks = charge ? v.webhooks.filter((h) => (charge.captureId && h.captureId === charge.captureId) || (charge.orderId && h.orderId === charge.orderId)) : [];
        const reversed = hooks.find((h) => h.type === "PAYMENT.CAPTURE.REVERSED" || h.type === "PAYMENT.CAPTURE.DECLINED");
        const confirmed = hooks.filter((h) => h.type === "PAYMENT.CAPTURE.COMPLETED" || h.type === "PAYMENT.CAPTURE.REFUNDED").map((h) => (h.type === "PAYMENT.CAPTURE.REFUNDED" ? "refund confirmed by PayPal" : "confirmed by PayPal"));
        const capPct = cart.capCents ? Math.min(100, (cart.totalCents / cart.capCents) * 100) : 0;
        return (
          <section key={cart.cartId + (preview ? "-p" : "")} className="px-5 py-4" aria-label={`Cart ${cart.seq} for ${b.displayName}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="font-mono text-[11px] text-muted">
                {preview ? "not finalized" : cart.invoiceId}
                {cart.seq > 1 ? ` · cart ${cart.seq}` : ""}
              </div>
              <Stamp key={st.label} outcome={st} animate={fresh.has(`${cart.cartId}:${cart.status}`)} />
            </div>
            <ul className="mt-2 space-y-1">
              {cart.lines.map((l) => (
                <li key={l.sku + l.unitCents} className="flex items-baseline justify-between gap-3 text-[13.5px]">
                  <span className="min-w-0 truncate">
                    <span className="font-semibold text-brand">#{l.itemCode}</span> {l.title}
                    <span className="text-muted"> · {[l.size, l.color].filter(Boolean).join(" ")}</span>
                    {l.qty > 1 ? <span className="text-muted"> ×{l.qty}</span> : null}
                  </span>
                  <span className="num shrink-0 font-mono text-[12.5px]">{moneyExact(l.lineCents)}</span>
                </li>
              ))}
              <li className="flex items-baseline justify-between gap-3 text-[13px] text-ink-2">
                <span>
                  Shipping, combined{cart.units > 1 ? ` for ${cart.units} items` : ""}
                  {cart.shippingCents === 0 && cart.units ? " · free" : ""}
                </span>
                <span className="num font-mono text-[12.5px]">{moneyExact(cart.shippingCents)}</span>
              </li>
              {cart.paidCents ? (
                <li className="flex items-baseline justify-between gap-3 text-[13px] text-granted">
                  <span>Paid during the show</span>
                  <span className="num font-mono text-[12.5px]">−{moneyExact(cart.paidCents)}</span>
                </li>
              ) : null}
            </ul>
            <div className="mt-2 flex items-baseline justify-between border-t border-dashed border-line-strong pt-2">
              <span className="text-[13px] font-bold">{cart.paidCents ? "Due" : "Total"}</span>
              <span className="display-tight num text-[22px] font-extrabold">{moneyExact(cart.dueCents)}</span>
            </div>

            {cart.capCents ? (
              <div className="mt-2">
                <div className="flex justify-between text-[11px] text-muted">
                  <span>Show cap</span>
                  <span className="num font-mono">
                    {moneyExact(cart.totalCents)} / {money(cart.capCents)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken">
                  <div className={cx("h-full rounded-full", capPct >= 100 ? "bg-danger" : capPct > 80 ? "bg-waitlist" : "bg-ink-2")} style={{ width: `${capPct}%` }} />
                </div>
              </div>
            ) : null}

            {cart.flags.length ? (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {cart.flags.map((f) => (
                  <span key={f} className={cx("rounded-full px-2 py-0.5 text-[11px] font-bold", f === "over-cap" ? "tone-bg-danger" : "tone-bg-waitlist")}>
                    {FLAG_LABEL[f] ?? f}
                  </span>
                ))}
              </div>
            ) : null}

            {charge?.status === "DECLINED" && cart.status === "declined" ? (
              <p role="alert" className="tone-bg-danger mt-3 rounded-lg px-3 py-2 text-[12.5px] font-semibold">
                Card declined: <span className="font-mono">{charge.declineCode ?? charge.status}</span>. The Claim Pass is suspended and the items are back on a pay-now hold.
              </p>
            ) : null}
            {charge?.status === "COMPLETED" && cart.status === "charged" ? (
              <>
                {charge.shipTo ? (
                  <address className="mt-3 flex gap-2.5 rounded-lg bg-sunken px-3 py-2.5 text-[13px] not-italic leading-snug" aria-label={`Ship to for ${b.displayName}`}>
                    <Icon.Truck size={15} className="mt-0.5 shrink-0 text-muted" />
                    <span className="min-w-0">
                      <span className="block font-semibold">
                        Ship to {charge.shipTo.name ?? b.displayName}
                      </span>
                      {shipToLines(charge.shipTo).map((line) => (
                        <span key={line} className="block text-ink-2">
                          {line}
                        </span>
                      ))}
                    </span>
                  </address>
                ) : (
                  <p role="status" className="tone-bg-waitlist mt-3 rounded-lg px-3 py-2 text-[12.5px] font-semibold">
                    PayPal has no ship-to address for this order. Ask {b.displayName} where to send it before you ship.
                  </p>
                )}
                {reversed ? (
                  <p role="alert" className="tone-bg-danger mt-3 rounded-lg px-3 py-2 text-[12.5px] font-semibold">
                    {reversed.summary}. Hold this parcel until it is resolved.
                  </p>
                ) : null}
                <p className="mt-2 font-mono text-[11px] text-muted">
                  {charge.via === "vault" ? "vault order" : "pay-now order"} {charge.orderId}
                  {charge.captureId ? ` · capture ${charge.captureId}` : ""}
                  {[...new Set(confirmed)].map((c) => ` · ${c}`).join("")}
                </p>
              </>
            ) : null}

            {!preview && cart.status === "pending" && cart.chargeMode === "pay-now" && cart.dueCents > 0 ? (
              <div className="mt-3">
                <Button size="sm" variant="outline" busy={busy === `pn-${cart.cartId}`} onClick={() => run(`pn-${cart.cartId}`, { action: "payNowCart", cartId: cart.cartId }, "Pay-now link ready")}>
                  <Icon.Send size={13} /> Create pay-now link
                </Button>
              </div>
            ) : null}

            {cart.status === "charged" ? <AfterCharge cart={cart} run={run} busy={busy} refunds={refunds} tracking={tracking} chargedCents={charge?.amountCents ?? cart.dueCents} /> : null}
          </section>
        );
      })}

      {holds.length || waiting.length || orders.some((o) => o.status === "open") ? (
        <section className="mt-auto border-t border-line bg-surface-2 px-5 py-3.5">
          {holds.length ? (
            <p className="text-[13px]">
              <span className="font-semibold">
                {holds.length} hold{holds.length > 1 ? "s" : ""} awaiting payment
              </span>
              <span className="text-muted"> · {holds.map((h) => h.label).join(", ")}</span>
            </p>
          ) : null}
          {waiting.length ? (
            <p className="mt-0.5 text-[12.5px] text-waitlist">
              Waitlisted for {waiting.map((w) => `${w.label} (#${w.waitlistPos ?? "?"})`).join(", ")}
            </p>
          ) : null}
          {holds.length && ended ? (
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" variant="ink" busy={busy === `ph-${b.buyerKey}`} onClick={() => run(`ph-${b.buyerKey}`, { action: "payNowHolds", buyerKey: b.buyerKey }, "Pay-now link ready")}>
                <Icon.Send size={13} /> {declinedCart ? "Offer a pay-now link" : "Send pay-now link"}
              </Button>
              <Button size="sm" variant="outline" busy={busy === `rel-${b.buyerKey}`} onClick={() => run(`rel-${b.buyerKey}`, { action: "releaseHolds", buyerKey: b.buyerKey }, "Released to the waitlist")}>
                <Icon.Undo size={13} /> Release to waitlist
              </Button>
            </div>
          ) : null}
          {orders
            .filter((o) => o.status === "open")
            .map((o) => (
              <OrderLink key={o.orderId} o={o} />
            ))}
        </section>
      ) : null}
    </li>
  );
}

function OrderLink({ o }: { o: OrderRecord }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2">
      <Icon.Send size={13} className="shrink-0 text-held" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">{o.approveUrl}</span>
      <span className="num shrink-0 font-mono text-[12px] font-semibold">{moneyExact(o.amountCents)}</span>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard?.writeText(o.approveUrl).catch(() => undefined);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 rounded p-1 text-ink-2 hover:bg-sunken"
        aria-label="Copy pay-now link"
      >
        {copied ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
      </button>
      <a href={o.approveUrl} target="_blank" rel="noreferrer" className="shrink-0 rounded p-1 text-ink-2 hover:bg-sunken" aria-label="Open pay-now link">
        <Icon.External size={14} />
      </a>
    </div>
  );
}

function AfterCharge({ cart, run, busy, refunds, tracking, chargedCents }: { cart: Cart; run: Run; busy: string | null; refunds: ShowView["refunds"]; tracking: ShowView["tracking"]; chargedCents: number }) {
  const [mode, setMode] = useState<"refund" | "track" | null>(null);
  const refunded = refunds.reduce((a, r) => a + r.amountCents, 0);
  const [amount, setAmount] = useState(((chargedCents - refunded) / 100).toFixed(2));
  // One key per refund the seller means: a re-submit of the same form replays it instead of refunding twice.
  const [refundKey, setRefundKey] = useState(() => crypto.randomUUID());
  const [carrier, setCarrier] = useState("USPS");
  const [number, setNumber] = useState("");

  return (
    <div className="mt-3 space-y-2">
      {tracking.map((t) => (
        <p key={t.trackerId} className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
          <Icon.Truck size={14} className="text-granted" /> {t.carrier} <span className="font-mono">{t.trackingNumber}</span> · buyer notified
        </p>
      ))}
      {refunds.map((r) => (
        <p key={r.refundId} className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
          <Icon.Undo size={14} className="text-danger" /> Refunded {moneyExact(r.amountCents)} <span className="font-mono text-[11px] text-muted">{r.refundId}</span>
        </p>
      ))}
      <div className="flex gap-2">
        <Button size="sm" variant={mode === "track" ? "soft" : "outline"} aria-expanded={mode === "track"} onClick={() => setMode(mode === "track" ? null : "track")}>
          <Icon.Truck size={13} /> Add tracking
        </Button>
        {refunded < chargedCents ? (
          <Button size="sm" variant={mode === "refund" ? "soft" : "ghost"} aria-expanded={mode === "refund"} onClick={() => setMode(mode === "refund" ? null : "refund")}>
            <Icon.Undo size={13} /> Refund
          </Button>
        ) : null}
      </div>
      {mode === "track" ? (
        <form
          className="anim-drop flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(`trk-${cart.cartId}`, { action: "tracking", cartId: cart.cartId, carrier, trackingNumber: number }, "Tracking added; PayPal notifies the buyer");
            if (r.ok) {
              setMode(null);
              setNumber("");
            }
          }}
        >
          <label className="sr-only" htmlFor={`carrier-${cart.cartId}`}>
            Carrier
          </label>
          <select id={`carrier-${cart.cartId}`} value={carrier} onChange={(e) => setCarrier(e.target.value)} className={cx(inputCls, "w-28")}>
            {["USPS", "UPS", "FEDEX", "DHL"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <label className="sr-only" htmlFor={`trk-${cart.cartId}`}>
            Tracking number
          </label>
          <input id={`trk-${cart.cartId}`} value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Tracking number" className={cx(inputCls, "font-mono")} />
          <Button type="submit" size="sm" variant="ink" busy={busy === `trk-${cart.cartId}`} disabled={!number.trim()}>
            Save
          </Button>
        </form>
      ) : null}
      {mode === "refund" ? (
        <form
          className="anim-drop flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(`ref-${cart.cartId}`, { action: "refund", cartId: cart.cartId, amountCents: Math.round(Number(amount) * 100), requestId: refundKey }, "Refund sent");
            if (r.ok) {
              setRefundKey(crypto.randomUUID());
              setMode(null);
            }
          }}
        >
          <label className="sr-only" htmlFor={`amt-${cart.cartId}`}>
            Refund amount in dollars
          </label>
          <span className="text-[13px] text-muted">$</span>
          <input id={`amt-${cart.cartId}`} value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} className={cx(inputCls, "num w-28")} />
          <Button type="submit" size="sm" variant="danger" busy={busy === `ref-${cart.cartId}`}>
            Refund
          </Button>
        </form>
      ) : null}
    </div>
  );
}
