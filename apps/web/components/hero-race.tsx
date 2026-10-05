import type { CSSProperties } from "react";
import type { OutcomeTone } from "../lib/types";

const RACE: { name: string; text: string; hms: string; ms: string; tone: OutcomeTone; label: string; note: string }[] = [
  { name: "ava", text: "SOLD 12 M", hms: "18:00:03", ms: ".040", tone: "granted", label: "GRANTED", note: "claim #12 M · 0.95 · rule" },
  { name: "dana", text: "12 M mine!!", hms: "18:00:03", ms: ".180", tone: "granted", label: "GRANTED", note: "claim #12 M · 0.95 · rule" },
  { name: "ben", text: "me M please 🙏", hms: "18:00:03", ms: ".270", tone: "waitlist", label: "WAITLIST #1", note: "sold out · next in line" },
  { name: "cleo", text: "is 12 in red?", hms: "18:00:03", ms: ".430", tone: "question", label: "QUESTION", note: "question · not a claim" },
];

/** The landing's thesis: four comments, one second, two medium cardigans, settled by send time. */
export function HeroRace() {
  return (
    <div className="relative" aria-label="Example: four comments race for two medium cardigans">
      <div className="absolute -inset-6 -z-10 rounded-[40px] bg-surface/50" aria-hidden="true" />
      <div className="mb-3 flex items-center justify-between px-1">
        <span className="eyebrow">#12 Blue cable-knit cardigan · M × 2 left</span>
        <span className="eyebrow hidden sm:inline">sent at · UTC</span>
      </div>
      <ol className="space-y-2.5">
        {RACE.map((r, i) => (
          <li key={r.name} className="ticket-wrap loop-ticket" style={{ "--loop-delay": `${i * 0.35}s` } as CSSProperties}>
            <div className="ticket">
              <div className="ticket-stub">
                <div className="num font-mono text-[12.5px] font-semibold leading-none">{r.hms}</div>
                <div className="num mt-0.5 font-mono text-[10.5px] leading-none text-muted">{r.ms}</div>
              </div>
              <div className="flex items-center justify-between gap-3 py-3 pl-4 pr-4">
                <div className="min-w-0">
                  <div className="text-[13px] font-bold">{r.name}</div>
                  <div className="text-[15px] leading-snug">{r.text}</div>
                  <div className="mt-1 font-mono text-[11px] text-muted">{r.note}</div>
                </div>
                <span data-tone={r.tone} className="stamp loop-stamp shrink-0" style={{ "--loop-delay": `${i * 0.35 + 0.9}s` } as CSSProperties}>
                  {r.label}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex items-center justify-between rounded-xl bg-ink px-4 py-2.5 text-paper">
        <span className="text-[13px] font-semibold">Oversold</span>
        <span className="display-tight num text-[22px] font-black">0</span>
      </div>
    </div>
  );
}
