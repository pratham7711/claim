"use client";

import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode, type SVGProps } from "react";
import type { Outcome } from "../lib/types";
import { countdown } from "../lib/stats";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------- icons (inline so the app ships no icon dependency) ----------

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function svg(path: ReactNode, viewBox = "0 0 24 24") {
  return function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg width={size} height={size} viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
        {path}
      </svg>
    );
  };
}

export const Icon = {
  Mic: svg(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>),
  MicOff: svg(<><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3M5 11a7 7 0 0 0 11.5 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" /></>),
  Play: svg(<path d="M7 5v14l11-7z" fill="currentColor" stroke="none" />),
  Stop: svg(<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />),
  Bolt: svg(<path d="M13 3 5 14h6l-1 7 8-11h-6z" />),
  Chat: svg(<path d="M4 5h16v11H9l-5 4z" />),
  Check: svg(<path d="m5 12 5 5 9-10" />),
  X: svg(<path d="M6 6l12 12M18 6 6 18" />),
  Clock: svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  Info: svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>),
  Arrow: svg(<path d="M5 12h14M13 6l6 6-6 6" />),
  ArrowLeft: svg(<path d="M19 12H5M11 6l-6 6 6 6" />),
  External: svg(<path d="M14 5h5v5M19 5l-8 8M18 14v5H5V6h5" />),
  Truck: svg(<><path d="M3 6h11v9H3zM14 9h4l3 3v3h-7" /><circle cx="7" cy="17.5" r="1.8" /><circle cx="17" cy="17.5" r="1.8" /></>),
  Undo: svg(<path d="M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2" />),
  Shield: svg(<path d="M12 3 5 6v6c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6z" />),
  Wallet: svg(<><path d="M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a1 1 0 0 1-1-1z" /><path d="M4 7V6a2 2 0 0 1 2-2h10v3M16 13.5h.01" /></>),
  Twitch: svg(<path d="M5 3 3.5 7v12H8v2.5h2.5L13 19h3.5L21 14.5V3zm14 10.5L16.5 16H13l-2.5 2.5V16H7V5h12zM16 7.5v4.5M12 7.5v4.5" />),
  Sim: svg(<><path d="M4 17V7l7 5zM13 17V7l7 5z" /></>),
  Sun: svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>),
  Moon: svg(<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />),
  Tag: svg(<><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8.5" r="1.5" /></>),
  Receipt: svg(<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3" />),
  Spark: svg(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />),
  Eye: svg(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>),
  Send: svg(<path d="M4 12 20 4l-6 16-3-7z" />),
  Copy: svg(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>),
  Room: svg(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>),
  Table: svg(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10" /></>),
  Download: svg(<path d="M12 4v11M7 10l5 5 5-5M5 20h14" />),
  Search: svg(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>),
};

export function PlatformGlyph({ platform, size = 13 }: { platform: string; size?: number }) {
  const label = platform === "twitch" ? "Twitch" : platform === "simulator" ? "Simulator" : platform === "youtube" ? "YouTube" : "Room";
  const G = platform === "twitch" ? Icon.Twitch : platform === "simulator" ? Icon.Sim : Icon.Chat;
  return (
    <span title={label} className="inline-flex items-center text-muted">
      <G size={size} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

// ---------- buttons ----------

type Variant = "brand" | "ink" | "outline" | "ghost" | "danger" | "soft";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  brand: "bg-brand text-brand-ink hover:brightness-110 active:brightness-95 shadow-[0_1px_0_rgb(255_255_255/0.25)_inset,0_6px_16px_-8px_var(--brand)]",
  ink: "bg-ink text-paper hover:opacity-90",
  outline: "border border-line-strong bg-surface text-ink hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-sunken hover:text-ink",
  danger: "border border-danger/40 bg-danger-soft text-danger hover:border-danger",
  soft: "bg-sunken text-ink hover:bg-line",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-2.5 text-[13px]",
  md: "h-10 gap-2 rounded-xl px-3.5 text-sm",
  lg: "h-12 gap-2.5 rounded-xl px-5 text-[15px]",
};

export function Button({ variant = "outline", size = "md", className, busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      aria-busy={busy || undefined}
      disabled={rest.disabled || busy}
      className={cx(
        "inline-flex shrink-0 select-none items-center justify-center font-semibold transition-[filter,background-color,opacity,border-color] disabled:cursor-not-allowed disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---------- stamp ----------

export function Stamp({ outcome, size = "md", animate = false, className }: { outcome: Outcome; size?: "md" | "lg"; animate?: boolean; className?: string }) {
  const strong = outcome.tone !== "question" && outcome.tone !== "chatter" && outcome.tone !== "pending";
  const pulse = animate && (outcome.tone === "granted" || outcome.tone === "settling" || outcome.tone === "held");
  return (
    <span
      data-tone={outcome.tone}
      className={cx("stamp", size === "lg" && "stamp-lg", animate && strong && (outcome.tone === "waitlist" ? "anim-slide" : "anim-stamp"), pulse && "anim-pulse", className)}
    >
      {outcome.label}
    </span>
  );
}

// ---------- time ----------

/** Re-renders every `ms`; `offset` corrects the browser clock to the server's. */
export function useNow(ms = 1000, offset = 0): number {
  const [t, setT] = useState(() => Date.now() + offset);
  useEffect(() => {
    setT(Date.now() + offset);
    const id = setInterval(() => setT(Date.now() + offset), ms);
    return () => clearInterval(id);
  }, [ms, offset]);
  return t;
}

export function Countdown({ until, offset = 0, className }: { until: number; offset?: number; className?: string }) {
  const now = useNow(500, offset);
  const left = until - now;
  return (
    <span className={cx("num font-mono", left < 60_000 && "text-danger", className)} aria-label={`${Math.max(0, Math.ceil(left / 1000))} seconds left`}>
      {countdown(left)}
    </span>
  );
}

/** A bar that drains over the remaining settle window: the grant is provisional until it empties. */
export function SettleBar({ until, offset = 0, windowMs }: { until: number; offset?: number; windowMs: number }) {
  const now = useNow(250, offset);
  const left = until - now;
  if (left <= 0) return null;
  return (
    <span className="relative block h-[3px] w-full overflow-hidden rounded-full bg-granted-soft" title="Settling: an earlier comment that arrives late can still take this unit">
      <span className="drain absolute inset-0 rounded-full bg-granted" style={{ animationDuration: `${left}ms`, transform: `scaleX(${Math.min(1, left / windowMs)})` }} />
    </span>
  );
}

// ---------- layout ----------

export function Panel({ title, eyebrow, aside, children, className, bodyClassName, id }: { title: ReactNode; eyebrow?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  return (
    <section aria-labelledby={id} className={cx("flex min-h-0 flex-col rounded-2xl border border-line bg-surface shadow-card", className)}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          {eyebrow ? <div className="eyebrow mb-0.5">{eyebrow}</div> : null}
          <h2 id={id} className="truncate text-[15px] font-bold tracking-tight">
            {title}
          </h2>
        </div>
        {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
      </header>
      <div className={cx("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "text-4xl" : size === "sm" ? "text-lg" : "text-2xl";
  return (
    <span className={cx("display inline-flex items-baseline font-black italic leading-none tracking-tight", cls)}>
      Claim<span className="text-brand">!</span>
    </span>
  );
}

export function LivePill({ phase, started }: { phase: "live" | "ended"; started: boolean }) {
  if (phase === "ended")
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-muted">Ended</span>;
  if (!started)
    return <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-muted">Not started</span>;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-live px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-white">
      <span className="live-dot size-1.5 rounded-full bg-white" />
      Live
    </span>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setDark(t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);
  const flip = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try {
      localStorage.setItem("claim-theme", next ? "dark" : "light");
    } catch {
      // private mode
    }
  };
  return (
    <button type="button" onClick={flip} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} className="inline-flex size-8 items-center justify-center rounded-lg text-ink-2 hover:bg-sunken hover:text-ink">
      {dark ? <Icon.Sun /> : <Icon.Moon />}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-ink-2">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11.5px] text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20";

export function MockBanner({ label, mode }: { label: string; mode: "mock" | "sandbox" }) {
  if (mode === "sandbox")
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-held-soft px-2.5 py-1 text-[11.5px] font-semibold text-held">
        <Icon.Shield size={13} /> PayPal sandbox
      </span>
    );
  return (
    <span role="note" className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-waitlist/60 bg-waitlist-soft px-2.5 py-1 text-[11.5px] font-semibold text-waitlist">
      <Icon.Info size={13} /> {label}
    </span>
  );
}

export function Toasts({ toasts }: { toasts: { id: number; tone: "ok" | "error" | "info"; text: string }[] }) {
  return (
    <div aria-live="assertive" className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className={cx(
            "anim-drop pointer-events-auto flex max-w-md items-center gap-2 rounded-xl px-3.5 py-2.5 text-[13px] font-semibold shadow-card",
            t.tone === "error" ? "bg-danger text-white" : "bg-ink text-paper",
          )}
        >
          {t.tone === "error" ? <Icon.Info size={15} /> : <Icon.Check size={15} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}
