import Link from "next/link";
import { HeroRace } from "../components/hero-race";
import { StartDemo } from "../components/start-demo";
import { Logo, ThemeToggle } from "../components/ui";
import { getService } from "../lib/server";

export const dynamic = "force-dynamic";

const STEPS = [
  {
    title: "Talk",
    body: "Describe the piece the way you already do on air. Claim! drafts the listing with its number, price and sizes, and asks only for what it didn't hear.",
    sample: "“Number 12, the blue cable knit cardigan, two mediums and one large, thirty four dollars.”",
  },
  {
    title: "Claim",
    body: "Buyers type like people: “me!!”, “M pls 🙏”, “mujhe 12 M chahiye”. The earliest send time wins, even when a slow phone's comment lands late, and unclear ones wait for you.",
    sample: "sold 12 M → GRANTED   ·   me too M → WAITLIST #1",
  },
  {
    title: "Close out",
    body: "End the show and every buyer gets one cart with combined shipping. One press charges every saved PayPal; a declined card falls back to a pay-now link or the next in line.",
    sample: "Charge 21 Claim Pass carts · $1,486.00",
  },
];

export default function Landing() {
  const shows = getService().list().slice(0, 4);
  return (
    <div className="grain min-h-dvh overflow-x-clip">
      <header className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-5">
        <Logo />
        <div className="flex items-center gap-4">
          <span className="hidden text-[13px] text-muted sm:inline">For independent boutiques that sell live</span>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-6">
        <section className="grid items-center gap-14 pb-16 pt-8 lg:grid-cols-[1.05fr_0.95fr] lg:pt-14">
          <div>
            <h1 className="display text-[clamp(44px,6.4vw,84px)] font-black leading-[0.9] tracking-[-0.035em] text-balance">
              Say it on air.
              <br />
              <span className="text-brand">Sell it</span> <span className="whitespace-nowrap">in the</span> comments.
            </h1>
            <p className="mt-6 max-w-[540px] text-[18px] leading-relaxed text-ink-2">
              Your voice becomes the listing. Messy chat becomes fair claims, settled by the moment each comment was sent. When the show ends, every buyer is charged once through PayPal.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-5">
              <StartDemo />
              <p className="max-w-[260px] text-[13px] leading-snug text-muted">Seeds three pieces and opens the seller console beside a buyer's phone.</p>
            </div>
          </div>
          <HeroRace />
        </section>

        <section aria-labelledby="how" className="border-t border-line py-14">
          <h2 id="how" className="sr-only">
            How a show runs
          </h2>
          <ol className="grid gap-10 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <div className="flex items-baseline gap-3">
                  <span className="display-tight num text-[15px] font-black text-brand">{i + 1}</span>
                  <h3 className="display text-[28px] font-black tracking-tight">{s.title}</h3>
                </div>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{s.body}</p>
                <p className="mt-4 rounded-xl border border-line bg-surface px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-ink-2">{s.sample}</p>
              </li>
            ))}
          </ol>
        </section>

        {shows.length ? (
          <section aria-labelledby="recent" className="border-t border-line py-10">
            <h2 id="recent" className="eyebrow">
              Recent shows on this machine
            </h2>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {shows.map((s) => (
                <li key={s.showId}>
                  <Link href={`/seller/${s.showId}`} className="block rounded-xl border border-line bg-surface px-3.5 py-3 hover:border-line-strong">
                    <div className="truncate text-[14px] font-semibold">{s.title}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted">
                      {s.showId} · {s.items} items · {s.phase}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>

      <footer className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-3 border-t border-line px-6 py-6 text-[12.5px] text-muted">
        <span>Built for the PayPal AI Hackathon 2026. Payments are simulated until the PayPal sandbox is connected.</span>
        <span className="font-mono">claim · v0.1</span>
      </footer>
    </div>
  );
}
