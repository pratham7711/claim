# Devpost submission: Nebius × NVIDIA Global AI Hackathon (draft)

Track: **Best Apps and Agents**. Paste each section into the matching Devpost field. Replace `<VIDEO_URL>` and the `<EVAL …>` numbers before submitting.

**Name:** Claim!

**Tagline (under 200 characters):** An AI desk for live-sale boutiques. NVIDIA Nemotron on Nebius Token Factory turns "sold 12 M" chat chaos into fair, audited sales.

**Try it:** https://claim-nemotron.onrender.com. Press **Start a demo show**. The seller console and a buyer's phone open side by side. The free host sleeps when idle, so the first load can take about a minute. Payments are simulated in this build.
**Code:** https://github.com/pratham7711/claim
**Video:** `<VIDEO_URL>`

---

## Inspiration

Independent boutiques sell on live video. When an item is on camera, the chat fills within seconds with "sold 12 M", "me!!", "mujhe 21 S chahiye" and "how much is shipping?". The host has to work out who was first, who gets the last medium, and who was only asking. After the show, someone chases every buyer for payment. Sales get lost in the scroll, and buyers argue that they were first.

## What it does

Claim! sits beside the stream and runs the sale.

1. **Voice to listing.** The host says "number 9, sage linen button down, two smalls and a medium, thirty six". **Nemotron 3 Super** drafts the item. Anything it guessed is flagged, and nothing goes on air until the seller confirms.
2. **Comments to claims.** Every comment is read as a claim, cancel, size change, waitlist request, question or chatter, in English, slang and Hinglish.
   - Rules settle the clear ones in under a millisecond, with no model call.
   - **Nemotron 3 Nano** reads the rest in batches, with JSON-schema output.
   - When Nano returns nothing, or is less than 0.7 sure, **Nemotron 3 Super** takes a second look, and the surer answer wins.
   - Anything still uncertain goes to the seller's review lane instead of being sold. A wrong sale costs more than asking.
3. **Fair allocation.**
   - Claims are ranked by the platform's own timestamp, not by arrival.
   - An earlier comment that arrives late still wins inside a 2-second settle window.
   - Holds, waitlists, spend caps and duplicate deliveries are handled, and the board never oversells.
   - Every decision has a "Why?" and an audit line. An answer from Super is tagged as escalated.
4. **One cart per buyer.** "End show" builds one cart per buyer with combined shipping and charges each saved Claim Pass once (simulated in this build).

## How we built it

- **Nebius Token Factory**, through its OpenAI-compatible API, as the `nebius` provider in `packages/llm`:
  - `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` is the fast pass;
  - `nvidia/nemotron-3-super-120b-a12b` handles escalation and voice listings;
  - reasoning is switched off (`enable_thinking: false`) so a comment batch stays inside the live latency budget.
- **A validator between the model and the money.** Every model answer is checked against the comment text:
  - invented item codes are dropped;
  - a claim without a claim word is capped below the auto-grant line.
  - So Nemotron can fill a gap or lower confidence, but cannot push an unclear comment into a sale on its own.
- **A hard token budget.** `withTokenBudget` reserves each call's worst case before sending it and corrects to the reported usage. Past the budget, or past a switch-off date, calls stop before reaching the provider and the app runs on rules alone. A public demo URL therefore cannot run up a bill.
- **Next.js 16 / React 19 / TypeScript** as npm workspaces: `core` (an event-sourced allocation engine), `resolver`, `listing`, `llm`, `paypal` and `web`. The UI updates live over server-sent events.
- Hosted on **Render** as one Docker web service (`render.yaml`).
- **Tests:** 552 Vitest tests, including the Nebius preset, the escalation path and the budget.

## Measured results

`<EVAL TABLE: heldout-v3, 350 comments: rules only / rules + Nano / rules + Nano -> Super; kind accuracy, grants, harmful grants, LLM p50/p95 ms, measured cost>`

Held-out v3 is 350 real comments from seven public live-sale replays. A second annotator agreed with the gold labels at Cohen's kappa 0.989. The set is scored once, never tuned on.

## Challenges we ran into

- **Latency against fairness.** A live sale cannot wait for a model, so clear claims never touch one. The model's answer can pre-empt only a grant made less than 2 seconds earlier.
- **Hinglish and slang.** "mujhe 21 S chahiye", "M pls", "me!!": the model has to tell a claim from a question, and the rules have to stop it from guessing an item code.
- **Spend control on a pay-per-token key behind a public URL.** This led to the shared token budget and the switch-off date.

## Accomplishments that we're proud of

- Uncertain comments go to the seller instead of being sold, and every grant can be explained.
- Two Nemotron models, each used where it pays: Nano on every unclear comment, Super only on the doubtful ones.

## What we learned

`<one or two measured lessons from the Nemotron eval run>`

## What's next for Claim!

- Instagram and TikTok Live comment sources (Twitch is wired, read-only).
- A fresh held-out set, v4, scored once with Nemotron.
- Per-seller accounts and authentication.

## Built with

nebius-token-factory, nvidia-nemotron, nemotron-3-nano, nemotron-3-super, typescript, next.js, react, node.js, docker, render, vitest

## Token Factory feedback

`<fill after the run: what worked (OpenAI-compatible API, model list, prices page), what was hard (e.g. $0 starting balance with a card on file; no spend cap in the console, so the app enforces its own)>`
