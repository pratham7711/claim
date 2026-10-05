"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { OrderRecord, ShowView } from "../lib/types";
import { moneyExact } from "../lib/stats";
import { Logo, MockBanner, Stamp } from "./ui";

/**
 * In mock mode the button stands in for PayPal and captures directly. In sandbox the buyer approves on PayPal's
 * own checkout (its button already says "Pay Now"), so arriving back here with a PayerID captures without a
 * second click, and arriving without one sends the buyer to PayPal first.
 */
export function PayPage({ showId, shopName, order, payments, approved = false }: { showId: string; shopName: string; order: OrderRecord | null; payments: ShowView["payments"]; approved?: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(order?.status === "captured" ? "done" : "idle");
  const [error, setError] = useState("");
  const sandbox = payments.mode === "sandbox";
  const autoCapture = sandbox && approved && order?.status === "open";
  const started = useRef(false);
  // Before the effect runs (and in the server render) a returning buyer already sees the capture as under way.
  const confirming = state === "busy" || (autoCapture && state === "idle");

  useEffect(() => {
    if (!autoCapture || started.current) return;
    started.current = true;
    void pay();
  }, [autoCapture]);

  const pay = async () => {
    if (!order) return;
    setState("busy");
    const r = await fetch(`/api/shows/${showId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "capture", orderId: order.orderId }) });
    const j = (await r.json()) as { ok: boolean; error?: string };
    if (j.ok) setState("done");
    else {
      setError(j.error ?? "Payment failed");
      setState("error");
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-4 flex items-center justify-between">
          <Logo size="sm" />
          <MockBanner label={payments.label} mode={payments.mode} />
        </div>
        <div className="ticket-wrap">
          <div className="rounded-3xl bg-surface p-6">
            <div className="eyebrow">Pay {shopName}</div>
            {order ? (
              <>
                <ul className="mt-4 space-y-1.5">
                  {order.lines.map((l) => (
                    <li key={l.sku} className="flex justify-between gap-3 text-[14px]">
                      <span className="min-w-0 truncate">
                        {l.name}
                        {l.qty > 1 ? ` ×${l.qty}` : ""}
                      </span>
                      <span className="num font-mono">{moneyExact(l.unitCents * l.qty)}</span>
                    </li>
                  ))}
                  <li className="flex justify-between gap-3 text-[13.5px] text-ink-2">
                    <span>Shipping</span>
                    <span className="num font-mono">{moneyExact(order.shippingCents)}</span>
                  </li>
                </ul>
                <div className="perforation my-4" />
                <div className="flex items-baseline justify-between">
                  <span className="font-bold">Total</span>
                  <span className="display-tight num text-[34px] font-black">{moneyExact(order.amountCents)}</span>
                </div>
                {state === "done" ? (
                  <div className="mt-6 flex flex-col items-center gap-3 text-center">
                    <Stamp outcome={{ tone: "sold", label: "PAID" }} size="lg" animate />
                    <p className="text-[14px] text-ink-2">Thanks, {order.displayName}. Your items are confirmed.</p>
                    <Link href={`/live/${showId}`} className="text-[13px] font-semibold underline decoration-line-strong underline-offset-2">
                      Back to the show
                    </Link>
                  </div>
                ) : (
                  <>
                    {sandbox && order.status === "open" && !confirming && (!approved || state === "error") ? (
                      <a href={order.approveUrl} className={PAY_BUTTON}>
                        <PayWith />
                      </a>
                    ) : (
                      <button type="button" onClick={pay} disabled={confirming || order.status === "failed"} className={PAY_BUTTON}>
                        {confirming ? (sandbox ? "Confirming with PayPal…" : "Paying…") : <PayWith />}
                      </button>
                    )}
                    {state === "error" ? <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p> : null}
                    {order.status === "failed" ? <p className="mt-3 text-[13px] text-danger">This order can no longer be paid.</p> : null}
                  </>
                )}
              </>
            ) : (
              <p className="mt-3 text-[14px] text-ink-2">This payment link is not valid for this show.</p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

const PAY_BUTTON = "mt-6 flex h-12 w-full items-center justify-center rounded-full bg-[#ffc439] text-[16px] font-bold text-[#111] hover:brightness-95 disabled:opacity-60";

function PayWith() {
  return (
    <span>
      Pay with <span className="italic text-[#003087]">Pay</span>
      <span className="italic text-[#0070e0]">Pal</span>
    </span>
  );
}
