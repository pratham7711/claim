"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardItem, BoardVariant } from "@claim/core";
import type { CommentView, ShowView, UnitView } from "../lib/types";
import { money, moneyExact, variantLabel } from "../lib/stats";
import { Button, Countdown, Icon, LivePill, Logo, MockBanner, Stamp, ThemeToggle, Toasts, cx, inputCls } from "./ui";
import { useFreshKeys, useShow, useToasts } from "./use-show";

interface Me {
  userId: string;
  displayName: string;
}

const STORE_KEY = "claim-buyer";
const NAMES = ["jess", "maya", "rosie", "camila", "harper", "nora", "zara", "ivy"];

function youtubeEmbed(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    let id: string | null = null;
    if (u.hostname === "youtu.be") id = u.pathname.slice(1);
    else if (u.hostname.endsWith("youtube.com")) id = u.searchParams.get("v") ?? u.pathname.match(/\/(?:live|embed|shorts)\/([\w-]{6,})/)?.[1] ?? null;
    return id ? `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&playsinline=1` : null;
  } catch {
    return null;
  }
}

/** What a viewer would type to claim this variant: only the attributes that tell variants apart. */
function claimText(item: BoardItem, v: BoardVariant): string {
  const sizes = new Set(item.variants.map((x) => x.size ?? ""));
  const colors = new Set(item.variants.map((x) => x.color ?? ""));
  const parts = [`sold ${item.code}`];
  if (colors.size > 1 && v.color) parts.push(v.color);
  if (sizes.size > 1 && v.size) parts.push(v.size);
  return parts.join(" ");
}

function unitOutcome(u: UnitView) {
  if (u.status === "charged") return { tone: "sold" as const, label: "PAID" };
  if (u.status === "confirmed") return { tone: "granted" as const, label: u.paid ? "PAID" : "YOURS" };
  if (u.status === "held") return { tone: "held" as const, label: "HELD" };
  if (u.status === "waitlisted") return { tone: "waitlist" as const, label: `WAITLIST #${u.waitlistPos ?? "?"}` };
  const cause = u.releaseCause === "lease-expired" ? "LAPSED" : u.releaseCause === "buyer-cancel" ? "CANCELLED" : "RELEASED";
  return { tone: "released" as const, label: cause };
}

export function BuyerRoom({ initial }: { initial: ShowView }) {
  const { view: v, act, offset } = useShow(initial.showId, initial);
  const { toasts, push } = useToasts();
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [passOpen, setPassOpen] = useState(false);

  useEffect(() => {
    const as = new URLSearchParams(window.location.search).get("as");
    let stored: Me | null = null;
    try {
      stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Me | null;
    } catch {
      stored = null;
    }
    if (as) stored = { userId: stored?.displayName === as ? stored.userId : `${as.toLowerCase().replace(/\W+/g, "")}-${Math.random().toString(36).slice(2, 7)}`, displayName: as };
    if (stored) {
      setMe(stored);
      localStorage.setItem(STORE_KEY, JSON.stringify(stored));
    }
    setReady(true);
  }, []);

  const myKey = me ? `room:${me.userId}` : "";
  const myBuyer = v.buyers.find((b) => b.buyerKey === myKey);
  const myUnits = v.units.filter((u) => u.buyerKey === myKey);
  const myReviews = v.reviews.filter((r) => r.buyerKey === myKey);
  const item = v.board.find((b) => b.code === v.onAir);
  const listed = v.items.find((i) => i.code === v.onAir);
  const ended = v.phase === "ended";
  const embed = youtubeEmbed(v.streamUrl);

  const committed = myUnits.filter((u) => u.status === "held" || u.status === "confirmed" || u.status === "charged");
  const subtotal = committed.reduce((a, u) => a + u.priceCents, 0);
  const ship = v.config.shipping;
  const shipping = committed.length ? (ship.freeOverCents !== undefined && subtotal >= ship.freeOverCents ? 0 : ship.firstItemCents + ship.perExtraItemCents * (committed.length - 1)) : 0;
  const cap = [v.config.capCents, myBuyer?.passCapCents].filter((c): c is number => typeof c === "number");
  const capCents = cap.length ? Math.min(...cap) : undefined;

  // Announce my claim results as they change, for screen readers and as a visible status line.
  const lastSig = useRef("");
  useEffect(() => {
    const sig = myUnits.map((u) => `${u.id}:${u.status}:${u.waitlistPos ?? ""}`).join("|");
    if (!lastSig.current) {
      lastSig.current = sig || "-";
      return;
    }
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    const latest = myUnits[myUnits.length - 1];
    if (!latest) return;
    const o = unitOutcome(latest);
    setAnnounce(`${latest.label}: ${o.label === "HELD" ? "held for you, pay within the timer" : o.label === "YOURS" ? "it's yours, Claim Pass will charge it after the show" : o.label.toLowerCase()}`);
  }, [myUnits]);

  const send = async (text: string, key: string) => {
    if (!me) return;
    setPending(key);
    const r = await act({ action: "comment", userId: me.userId, displayName: me.displayName, text });
    setPending(null);
    if (!r.ok) push("error", r.error);
  };

  const fresh = useFreshKeys(myUnits.map((u) => `${u.id}:${u.status}:${u.waitlistPos ?? ""}`));
  const onPassLinked = useCallback(() => {
    setPassOpen(false);
    push("ok", "Claim Pass linked");
  }, [push]);

  if (!ready) return <div className="min-h-dvh" />;

  return (
    <div className="mx-auto flex min-h-dvh max-w-[480px] flex-col bg-surface shadow-card sm:my-0">
      <header className="flex items-center justify-between gap-3 px-4 pb-2.5 pt-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-extrabold tracking-tight">{v.shopName}</div>
          <div className="truncate text-[12px] text-muted">{v.title}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <LivePill phase={v.phase} started={Boolean(v.startedAt)} />
          <ThemeToggle />
        </div>
      </header>

      {/* stream */}
      <div className="relative mx-3 aspect-video overflow-hidden rounded-2xl bg-[#1b1424]">
        {embed ? (
          <iframe src={embed} title="Live video" className="absolute inset-0 size-full" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
        ) : (
          <div className="absolute inset-0 grid place-items-center" aria-hidden="true">
            <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_20%_10%,#d3236c55,transparent_60%),radial-gradient(90%_70%_at_90%_90%,#6541e355,transparent_60%)]" />
            <div className="absolute inset-x-0 top-[38%] flex justify-center gap-5 opacity-60">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className="h-16 w-9 rounded-b-xl rounded-t-sm border-t-[3px] border-white/50 bg-white/10" style={{ transform: `rotate(${(i - 2) * 3}deg)` }} />
              ))}
            </div>
            <div className="absolute inset-x-6 top-[36%] h-[3px] rounded-full bg-white/40" />
            <span className="relative mt-24 text-[12px] font-semibold uppercase tracking-[0.2em] text-white/70">{ended ? "The show has ended" : "Live from the boutique"}</span>
          </div>
        )}
        {listed && !ended ? (
          <div className="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-xl bg-black/55 px-3 py-2 text-white backdrop-blur">
            <span className="display-tight text-[22px] font-black leading-none text-[#ff7cab]">#{listed.code}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{listed.title}</span>
            <span className="num text-[14px] font-bold">{money(listed.priceCents, v.config.currency)}</span>
          </div>
        ) : null}
      </div>

      {/* claim buttons */}
      <section aria-labelledby="claim-title" className="px-4 pt-4">
        {ended ? (
          me ? (
            <AfterShow v={v} myKey={myKey} act={act} offset={offset} onError={(m) => push("error", m)} />
          ) : (
            <h2 id="claim-title" className="text-[15px] font-bold">
              Thanks for watching
            </h2>
          )
        ) : (
          <div className="flex items-baseline justify-between">
            <h2 id="claim-title" className="text-[15px] font-bold">
              {item ? "Tap to claim" : "Waiting for the first item"}
            </h2>
            {capCents !== undefined ? <span className="text-[11.5px] text-muted">Cap {money(capCents)} per show</span> : null}
          </div>
        )}
        {item && !ended ? (
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            {item.variants.map((x) => {
              const key = `claim-${item.code}-${x.sku}`;
              const soldOut = x.available <= 0;
              return (
                <button
                  key={x.sku}
                  type="button"
                  disabled={!me || pending !== null}
                  onClick={() => send(claimText(item, x), key)}
                  className={cx(
                    "group relative flex min-h-[64px] flex-col items-start justify-center rounded-xl border-2 px-3 py-2 text-left transition-[transform,background-color,border-color] active:scale-[0.98] disabled:opacity-50",
                    soldOut ? "border-waitlist/40 bg-waitlist-soft/60 hover:border-waitlist" : "border-ink bg-ink text-paper hover:bg-ink/90",
                  )}
                >
                  <span className="display-tight text-[17px] font-extrabold leading-tight">
                    {soldOut ? "Waitlist" : "Claim"} #{item.code} · {variantLabel(x)}
                  </span>
                  <span className={cx("mt-0.5 text-[11.5px]", soldOut ? "text-waitlist" : "text-paper/70")}>
                    {pending === key ? "Sending…" : soldOut ? `${x.waitlist.length} waiting` : `${x.available} left`}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        <p aria-live="assertive" className={cx(ended ? "sr-only" : "mt-2 min-h-5 text-[13px] font-semibold", announce ? "text-ink" : "text-transparent")}>
          {announce || "."}
        </p>
      </section>

      {/* claim pass */}
      {me && !ended ? (
        <section className="mx-4 mt-1">
          {myBuyer?.hasPass ? (
            <div className="tone-bg-granted flex items-center gap-3 rounded-xl px-3.5 py-3">
              <Icon.Wallet size={18} />
              <div className="min-w-0 flex-1 text-[13px]">
                <div className="font-bold">Claim Pass linked</div>
                <div className="opacity-80">Claims confirm instantly. One charge after the show{myBuyer.passCapCents ? `, capped at ${money(myBuyer.passCapCents)}` : ""}.</div>
              </div>
              <Icon.Check size={18} />
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-line-strong bg-surface-2 px-3.5 py-3">
              <div className="min-w-0 flex-1 text-[13px]">
                <div className="font-bold">Skip the checkout</div>
                <div className="text-muted">Save PayPal once and your claims confirm instantly.</div>
              </div>
              <Button size="sm" variant="ink" onClick={() => setPassOpen(true)}>
                Get Claim Pass
              </Button>
            </div>
          )}
        </section>
      ) : null}

      {/* my claims */}
      {me && (myUnits.length || myReviews.length) ? (
        <section aria-labelledby="mine-title" className="px-4 pt-5">
          <div className="flex items-baseline justify-between">
            <h2 id="mine-title" className="text-[15px] font-bold">
              My claims
            </h2>
            {committed.length ? (
              <span className="num text-[12px] text-muted">
                {moneyExact(subtotal)} + {moneyExact(shipping)} shipping
              </span>
            ) : null}
          </div>
          {capCents !== undefined && committed.length ? (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-sunken" title="Spent against your per-show cap">
              <div className="h-full rounded-full bg-ink-2" style={{ width: `${Math.min(100, ((subtotal + shipping) / capCents) * 100)}%` }} />
            </div>
          ) : null}
          <ul className="mt-2.5 space-y-2">
            {myUnits
              .slice()
              .reverse()
              .map((u) => {
                const o = unitOutcome(u);
                const k = `${u.id}:${u.status}:${u.waitlistPos ?? ""}`;
                return (
                  <li key={u.id} className={cx("ticket-wrap", fresh.has(k) && "anim-drop")}>
                    <div className="ticket ticket-compact">
                      <div className="ticket-stub flex flex-col justify-center">
                        <span className="display-tight text-[22px] font-black leading-none text-brand">#{u.itemCode}</span>
                        <span className="mt-1 text-[11px] font-semibold text-muted">{u.label.replace(/^#\S+\s?/, "")}</span>
                      </div>
                      <div className="flex min-w-0 items-center justify-between gap-2 py-2.5 pl-4 pr-3">
                        <div className="min-w-0">
                          <div className="truncate text-[13.5px] font-semibold">{u.title}</div>
                          <div className="text-[12px] text-muted">
                            {u.status === "held" && u.leaseExpiresAt ? (
                              <span className="inline-flex items-center gap-1 text-held">
                                <Icon.Clock size={12} /> held for <Countdown until={u.leaseExpiresAt} offset={offset} />
                              </span>
                            ) : u.status === "waitlisted" ? (
                              "You move up if someone ahead drops"
                            ) : u.status === "confirmed" ? (
                              u.paid ? "Paid" : "Charged once after the show"
                            ) : (
                              moneyExact(u.priceCents)
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          <Stamp key={o.label} outcome={o} animate={fresh.has(k)} />
                          {u.status === "held" && !ended ? <PayNow request={{ action: "payNowHolds", buyerKey: myKey }} act={act} onError={(m) => push("error", m)} /> : null}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            {myReviews.map((r) => (
              <li key={r.id} className="tone-bg-review rounded-xl px-3.5 py-2.5 text-[13px]">
                <span className="font-semibold">The seller is checking “{r.text}”.</span> You keep your place in line.
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Chat v={v} me={me} onJoin={(m) => {
        setMe(m);
        localStorage.setItem(STORE_KEY, JSON.stringify(m));
      }} send={(t) => send(t, "chat")} sending={pending === "chat"} ended={ended} />

      {passOpen && me ? (
        <ClaimPassSheet
          v={v}
          me={me}
          act={act}
          onLinked={onPassLinked}
          onClose={() => setPassOpen(false)}
          onSave={async (capCents, declines) => {
            const r = await act({ action: "savePass", userId: me.userId, displayName: me.displayName, capCents, declines });
            if (r.ok) {
              setPassOpen(false);
              push("ok", "Claim Pass linked");
            } else push("error", r.error);
          }}
        />
      ) : null}
      <Toasts toasts={toasts} />
    </div>
  );
}

type Act = ReturnType<typeof useShow>["act"];
type PayAction = { action: "payNowHolds"; buyerKey: string } | { action: "payNowCart"; cartId: string };

function PayNow({ request, act, onError, label = "Pay now", large }: { request: PayAction; act: Act; onError: (m: string) => void; label?: string; large?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={async () => {
        setBusy(true);
        const r = await act(request);
        if (r.ok) window.location.href = (r.data as { approveUrl: string }).approveUrl;
        else {
          setBusy(false);
          onError(r.error);
        }
      }}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#ffc439] font-bold text-[#111] hover:brightness-95 disabled:opacity-60",
        large ? "h-11 w-full text-[15px]" : "min-h-8 px-3 text-[12.5px]",
      )}
    >
      {busy ? "Opening PayPal…" : label}
    </button>
  );
}

/** After the show: what this buyer still owes, what was charged, and where it ships. */
function AfterShow({ v, myKey, act, offset, onError }: { v: ShowView; myKey: string; act: Act; offset: number; onError: (m: string) => void }) {
  const mine = v.carts.find((c) => c.buyerKey === myKey);
  const units = v.units.filter((u) => u.buyerKey === myKey);
  const owed = units.filter((u) => u.status === "held" && !u.paid);
  const owedCents = owed.reduce((a, u) => a + u.priceCents, 0);
  const deadline = Math.min(...owed.map((u) => u.leaseExpiresAt ?? Infinity));
  const declined = mine?.finalized.some((c) => c.status === "declined");
  const charged = mine?.finalized.filter((c) => c.status === "charged") ?? [];
  const dueCart = mine?.finalized.find((c) => c.status === "pending" && c.chargeMode === "pay-now" && c.dueCents > 0);
  const passCart = mine?.finalized.find((c) => c.status === "pending" && c.chargeMode === "vault") ?? (mine?.preview?.chargeMode === "vault" ? mine.preview : undefined);
  const waitlistOnly = !owed.length && !charged.length && !dueCart && !passCart && units.some((u) => u.status === "waitlisted");
  const fmt = (c: number) => moneyExact(c, v.config.currency);

  const heading = owed.length || dueCart ? "Finish checking out" : passCart ? "Your order is being closed out" : charged.length ? "You're all paid" : "Thanks for watching";

  return (
    <div className="space-y-2.5">
      <h2 id="claim-title" className="text-[15px] font-bold">
        {heading}
      </h2>

      {owed.length ? (
        <div className="rounded-xl border border-held/35 bg-held-soft px-3.5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13.5px] font-bold text-held">{declined ? "Your Claim Pass charge didn't go through" : `${owed.length} ${owed.length === 1 ? "item is" : "items are"} held for you`}</span>
            <span className="num text-[15px] font-extrabold">{fmt(owedCents)}</span>
          </div>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Pay with PayPal to keep {owed.length === 1 ? "it" : "them"}; combined shipping is added at checkout.
            {Number.isFinite(deadline) ? (
              <>
                {" "}
                Held for <Countdown until={deadline} offset={offset} /> more.
              </>
            ) : null}
          </p>
          <div className="mt-2.5">
            <PayNow large label={`Pay ${fmt(owedCents)} + shipping`} request={{ action: "payNowHolds", buyerKey: myKey }} act={act} onError={onError} />
          </div>
        </div>
      ) : null}

      {dueCart ? (
        <div className="rounded-xl border border-held/35 bg-held-soft px-3.5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13.5px] font-bold text-held">Shipping is still due</span>
            <span className="num text-[15px] font-extrabold">{fmt(dueCart.dueCents)}</span>
          </div>
          <div className="mt-2.5">
            <PayNow large label={`Pay ${fmt(dueCart.dueCents)}`} request={{ action: "payNowCart", cartId: dueCart.cartId }} act={act} onError={onError} />
          </div>
        </div>
      ) : null}

      {passCart ? (
        <div className="tone-bg-granted flex items-start gap-3 rounded-xl px-3.5 py-3 text-[13px]">
          <Icon.Wallet size={18} />
          <div className="min-w-0 flex-1">
            <div className="font-bold">One charge of {fmt(passCart.dueCents)} to your Claim Pass</div>
            <div className="opacity-80">
              {passCart.units} {passCart.units === 1 ? "item" : "items"} with {passCart.shippingCents ? `${fmt(passCart.shippingCents)} combined shipping` : "free shipping"}. The seller charges it when they close out.
            </div>
          </div>
        </div>
      ) : null}

      {charged.map((c) => {
        const shipped = v.tracking.filter((t) => t.cartId === c.cartId);
        const refunded = v.refunds.filter((r) => r.cartId === c.cartId).reduce((a, r) => a + r.amountCents, 0);
        return (
          <div key={c.cartId} className="rounded-xl border border-line-strong bg-surface-2 px-3.5 py-3 text-[13px]">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 font-bold">
                <Icon.Receipt size={15} /> Paid with PayPal
              </span>
              <span className="num text-[15px] font-extrabold">{fmt(c.dueCents)}</span>
            </div>
            <ul className="mt-2 space-y-1 border-t border-line pt-2">
              {c.lines.map((l) => (
                <li key={l.sku} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate">
                    #{l.itemCode} {l.title}
                    <span className="text-muted">
                      {" "}
                      · {[l.size, l.color].filter(Boolean).join(" ")}
                      {l.qty > 1 ? ` × ${l.qty}` : ""}
                    </span>
                  </span>
                  <span className="num shrink-0">{fmt(l.lineCents)}</span>
                </li>
              ))}
              <li className="flex justify-between gap-3 text-muted">
                <span>Shipping</span>
                <span className="num">{c.shippingCents ? fmt(c.shippingCents) : "Free"}</span>
              </li>
              {c.paidCents ? (
                <li className="flex justify-between gap-3 text-muted">
                  <span>Paid during the show</span>
                  <span className="num">−{fmt(c.paidCents)}</span>
                </li>
              ) : null}
            </ul>
            {refunded ? <p className="mt-2 font-semibold text-waitlist">Refunded {fmt(refunded)}</p> : null}
            {shipped.length ? (
              <p className="mt-2 inline-flex items-center gap-1.5 font-semibold">
                <Icon.Truck size={14} /> Shipped · {shipped[shipped.length - 1]!.carrier} {shipped[shipped.length - 1]!.trackingNumber}
              </p>
            ) : (
              <p className="mt-2 text-muted">The seller adds tracking when it ships.</p>
            )}
          </div>
        );
      })}

      {waitlistOnly ? <p className="text-[13px] text-muted">You were on the waitlist and nothing came free. Nothing to pay.</p> : null}
    </div>
  );
}

function Chat({ v, me, onJoin, send, sending, ended }: { v: ShowView; me: Me | null; onJoin: (m: Me) => void; send: (t: string) => Promise<void>; sending: boolean; ended: boolean }) {
  const [text, setText] = useState("");
  const [name, setName] = useState(() => NAMES[Math.floor(Math.random() * NAMES.length)]!);
  const list = useRef<HTMLOListElement>(null);
  const recent = useMemo(() => v.comments.slice(0, 40).reverse(), [v.comments]);
  const myKey = me ? `room:${me.userId}` : "";

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [recent.length]);

  return (
    <section aria-labelledby="chat-title" className="mt-5 flex min-h-[260px] flex-1 flex-col border-t border-line">
      <h2 id="chat-title" className="px-4 pb-1 pt-3 text-[15px] font-bold">
        Chat
      </h2>
      <ol ref={list} className="scroll-thin max-h-[40vh] min-h-[120px] flex-1 space-y-1.5 overflow-y-auto px-4 pb-2" aria-label="Recent comments">
        {recent.length ? (
          recent.map((c: CommentView) => (
            <li key={c.id} className={cx("text-[13.5px] leading-snug", c.buyerKey === myKey && "rounded-lg bg-brand-soft/60 px-2 py-1")}>
              <span className="font-bold">{c.displayName}</span> <span className="text-ink-2">{c.text}</span>
              {c.outcome.tone !== "chatter" && c.outcome.tone !== "question" ? (
                <span className={cx("ml-1.5 align-middle font-mono text-[10px] font-bold uppercase", c.outcome.tone === "waitlist" ? "text-waitlist" : c.outcome.tone === "review" ? "text-review" : c.outcome.tone === "released" || c.outcome.tone === "rejected" ? "text-danger" : "text-granted")}>
                  {c.outcome.label}
                </span>
              ) : null}
            </li>
          ))
        ) : (
          <li className="text-[13px] text-muted">Be the first to say hi.</li>
        )}
      </ol>
      <div className="sticky bottom-0 border-t border-line bg-surface px-3 py-2.5">
        {me ? (
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const t = text.trim();
              if (!t) return;
              setText("");
              await send(t);
            }}
          >
            <label htmlFor="chat-input" className="sr-only">
              Message
            </label>
            <input id="chat-input" value={text} onChange={(e) => setText(e.target.value)} disabled={ended} placeholder={ended ? "The show has ended" : `Chat as ${me.displayName}… try “sold M”`} className={cx(inputCls, "h-10 rounded-xl")} maxLength={280} autoComplete="off" />
            <Button type="submit" variant="brand" size="md" aria-label="Send" busy={sending} disabled={!text.trim() || ended}>
              <Icon.Send size={16} />
            </Button>
          </form>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = name.trim().slice(0, 24);
              if (n) onJoin({ userId: `${n.toLowerCase().replace(/\W+/g, "")}-${Math.random().toString(36).slice(2, 7)}`, displayName: n });
            }}
          >
            <label className="flex-1">
              <span className="mb-1 block text-[12px] font-semibold text-ink-2">Pick a chat name to claim</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={cx(inputCls, "h-10 rounded-xl")} maxLength={24} />
            </label>
            <Button type="submit" variant="ink" disabled={!name.trim()}>
              Join
            </Button>
          </form>
        )}
        <div className="mt-2 flex items-center justify-center gap-1.5 text-[10.5px] text-muted">
          claims settle by the time you hit send · <Logo size="sm" />
        </div>
      </div>
    </section>
  );
}

/** Sandbox: PayPal's v6 save-without-purchase session. The buyer approves in PayPal's window; the server then vaults the setup token. */
function SandboxSave({ act, me, cap, onLinked }: { act: Act; me: Me; cap: number; onLinked: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const capRef = useRef(cap);
  capRef.current = cap;
  const [state, setState] = useState<"loading" | "ready" | "saving" | "ineligible" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let unbind = () => {};
    let gone = false;
    const fail = (e: unknown) => {
      if (gone) return;
      setState("error");
      setError(e instanceof Error ? e.message : String(e));
    };
    const call = async <T,>(a: Parameters<Act>[0]): Promise<T> => {
      const r = await act(a);
      if (!r.ok) throw new Error(r.error);
      return r.data as T;
    };
    import("@claim/paypal/browser")
      .then(({ setupClaimPass }) =>
        setupClaimPass({
          clientToken: () => call<{ clientToken: string }>({ action: "clientToken" }).then((d) => d.clientToken),
          createSetupToken: () => call<{ setupTokenId: string }>({ action: "passSetup", userId: me.userId, displayName: me.displayName, capCents: capRef.current }).then((d) => d.setupTokenId),
          onApprove: async (setupTokenId) => {
            setState("saving");
            await call({ action: "passApprove", setupTokenId });
            onLinked();
          },
          onCancel: () => !gone && setState("ready"),
          onError: fail,
        }),
      )
      .then((pass) => {
        if (gone) return;
        if (!pass.eligible) return setState("ineligible");
        if (button.current) unbind = pass.bind(button.current);
        setState("ready");
      })
      .catch(fail);
    return () => {
      gone = true;
      unbind();
    };
  }, [act, me, onLinked]);

  return (
    <div>
      <button
        ref={button}
        type="button"
        hidden
        disabled={state !== "ready"}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#ffc439] text-[15px] font-bold text-[#111] hover:brightness-95 disabled:opacity-60"
      >
        {state === "saving" ? "Linking…" : (
          <>
            Save <span className="italic text-[#003087]">Pay</span>
            <span className="-ml-2 italic text-[#0070e0]">Pal</span>
          </>
        )}
      </button>
      <p role="status" className="mt-2 text-[12px] text-muted">
        {state === "loading"
          ? "Connecting to PayPal…"
          : state === "ineligible"
            ? "PayPal can't save a wallet for this account. Claims will hold for a pay-now link instead."
            : state === "error"
              ? `PayPal didn't load: ${error}`
              : "PayPal opens in a window. Approve once; nothing is charged now."}
      </p>
    </div>
  );
}

function ClaimPassSheet({ v, me, act, onClose, onSave, onLinked }: { v: ShowView; me: Me | null; act: Act; onClose: () => void; onSave: (capCents: number, declines: boolean) => Promise<void>; onLinked: () => void }) {
  const showCap = v.config.capCents ?? 15000;
  const [cap, setCap] = useState(showCap);
  const [declines, setDeclines] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby="pass-title">
      <button type="button" aria-label="Close" className="anim-fade absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="anim-drop relative w-full max-w-[480px] rounded-t-3xl bg-surface p-5 shadow-2xl sm:rounded-3xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong sm:hidden" />
        <h2 id="pass-title" className="display text-[24px] font-black tracking-tight">
          Claim Pass
        </h2>
        <p className="mt-1 text-[13.5px] text-ink-2">Save PayPal once. Your claims confirm the moment you comment, and you're charged once after the show with combined shipping.</p>

        <fieldset className="mt-4">
          <legend className="text-[12px] font-semibold text-ink-2">Most I'll spend this show</legend>
          <div className="mt-1.5 flex gap-2">
            {[7500, 10000, showCap].filter((x, i, a) => x <= showCap && a.indexOf(x) === i).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={cap === c}
                onClick={() => setCap(c)}
                className={cx("flex-1 rounded-xl border-2 py-2 text-[15px] font-bold", cap === c ? "border-ink bg-ink text-paper" : "border-line-strong hover:border-ink")}
              >
                {money(c)}
              </button>
            ))}
          </div>
        </fieldset>

        <div id="paypal-save-slot" data-paypal-v6-save-session className="mt-4 rounded-2xl border border-dashed border-line-strong bg-surface-2 p-3">
          {v.payments.mode === "mock" ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await onSave(cap, declines);
                  setBusy(false);
                }}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#ffc439] text-[15px] font-bold text-[#111] hover:brightness-95 disabled:opacity-60"
              >
                {busy ? "Saving…" : (
                  <>
                    Save <span className="italic text-[#003087]">Pay</span>
                    <span className="-ml-2 italic text-[#0070e0]">Pal</span>
                  </>
                )}
              </button>
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <MockBanner label={v.payments.label} mode="mock" />
                <label className="inline-flex items-center gap-1.5 text-[11.5px] text-muted">
                  <input type="checkbox" checked={declines} onChange={(e) => setDeclines(e.target.checked)} className="accent-[var(--brand)]" />
                  card declines at close-out
                </label>
              </div>
            </>
          ) : me ? (
            <SandboxSave act={act} me={me} cap={cap} onLinked={onLinked} />
          ) : null}
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-muted">
          <Icon.Shield size={13} /> The boutique is the merchant. PayPal keeps your card; Claim! only stores a token.
        </p>
      </div>
    </div>
  );
}
