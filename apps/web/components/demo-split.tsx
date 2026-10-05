"use client";

import Link from "next/link";
import { Icon, Logo, ThemeToggle } from "./ui";

/** Console and buyer phone side by side, for demos and judges. */
export function DemoSplit({ showId, title, shopName }: { showId: string; title: string; shopName: string }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <Link href="/" aria-label="Claim! home">
          <Logo size="sm" />
        </Link>
        <span className="truncate text-[13px] text-muted">
          Demo show · {shopName} · {title}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Link href={`/seller/${showId}`} target="_blank" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-semibold text-ink-2 hover:bg-sunken">
            Console <Icon.External size={13} />
          </Link>
          <Link href={`/live/${showId}`} target="_blank" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-semibold text-ink-2 hover:bg-sunken">
            Buyer room <Icon.External size={13} />
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 gap-4 bg-sunken p-4">
        <section aria-label="Seller console" className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          <iframe src={`/seller/${showId}`} title="Seller console" className="size-full" />
        </section>
        <section aria-label="Buyer room" className="flex shrink-0 flex-col items-center">
          <div className="eyebrow mb-2">Buyer's phone</div>
          <div className="relative h-[min(780px,calc(100dvh-120px))] w-[min(380px,calc((100dvh-120px)*0.487))] overflow-hidden rounded-[44px] border-[10px] border-ink bg-surface shadow-2xl">
            <span className="absolute left-1/2 top-2 z-10 h-5 w-24 -translate-x-1/2 rounded-full bg-ink" aria-hidden="true" />
            <iframe src={`/live/${showId}?as=jess`} title="Buyer room" className="size-full pt-6" />
          </div>
        </section>
      </div>
    </div>
  );
}
