# Devpost submission (draft)

Paste each section into the matching Devpost field. Replace `<RENDER_URL>` once the Render deploy is live, and make the GitHub repo public before submitting.

**Name:** Claim!

**Tagline (under 200 characters):** An AI live-sale desk for boutiques. It turns "sold 12 M" chat chaos into fair, audited claims, then bills each buyer once through PayPal.

**Try it:** `<RENDER_URL>`. Press **Start a demo show**. The seller console and a buyer's phone open side by side. The free host sleeps when idle, so the first load can take about a minute. Payments run on PayPal's sandbox, so saving a Claim Pass or paying needs a sandbox buyer login (see the testing note).
**Code:** https://github.com/pratham7711/claim

---

## Inspiration

Independent boutiques sell on live video. When an item is on camera, the chat fills within seconds with "sold 12 M", "me!!", "mujhe 21 S chahiye" and "how much is shipping?". The host has to work out who was first, who gets the last medium, and who was only asking. After the show, someone chases every buyer for payment, one DM at a time. Sales get lost in the scroll, and buyers argue that they were first.

## What it does

Claim! sits beside the stream and runs the sale end to end.

1. **Voice to listing.** The host says "number 9, sage linen button down, two smalls and a medium, thirty six". Claim! drafts the item, flags anything it guessed (here, a bare "36" read as a price), and lists nothing until the seller confirms.
2. **Comments to claims.** Every comment is read as a claim, cancel, size change, waitlist request, question or chatter, in English, slang and Hinglish. Rules settle the clear ones. An LLM on **Groq** reads the ambiguous rest. Anything still uncertain goes to the seller's review lane instead of being sold.
3. **Fair allocation.**
   - Claims are ranked by the platform's own timestamp, not by arrival.
   - An earlier comment that arrives late still wins inside a 2-second settle window.
   - Holds, waitlists, spend caps and duplicate deliveries are handled, and the board never oversells.
   - Every decision has a "Why?" and an audit line.
4. **Claim Pass, built on PayPal Vault.**
   - A buyer saves PayPal once, before the show, with a spending cap.
   - Their claims confirm instantly, with no checkout during the show.
5. **One charge per buyer.**
   - "End show" builds one cart per buyer with combined shipping.
   - Claim Pass carts are charged in one go as merchant-initiated **PayPal Orders** against the saved vault token, while the buyer is offline.
   - The ship-to address comes from the buyer's PayPal wallet.
   - Everyone else gets one pay-now link for everything they hold.
   - A declined card falls back to a pay-now link or the waitlist.
6. **After the sale.**
   - Refunds and tracking are one click each.
   - Signed **PayPal webhooks** confirm captures and refunds on the seller's screen.
   - A buyer who removes the saved wallet in PayPal has their Claim Pass revoked.
   - An **AG Grid** ledger lists every cart with its address and exports CSV.

## How I built it

- **Next.js 16 / React 19 / TypeScript**, as npm workspaces: `core` (an event-sourced allocation engine), `resolver`, `listing`, `llm`, `paypal` and `web`. State is an append-only event log, and the UI updates live over server-sent events.
- **PayPal**, integrated against the sandbox REST APIs:
  - **Vault (Payment Method Tokens v3)**, with the **JS SDK v6** save session, for the Claim Pass.
  - **Orders v2** for vault charges (with `stored_credential`) and for pay-now (`GET_FROM_FILE` shipping).
  - **Payments v2** refunds and order **tracking**.
  - **Webhooks**, verified with `verify-webhook-signature` against the raw body.
  - The test suite checks request bodies against PayPal's published OpenAPI specs.
  - Vault charges and refunds carry idempotency keys, and a capture already in flight is never sent twice.
- **Groq** (`openai/gpt-oss-20b`, JSON-schema output) for the comments the rules can't settle.
  - The model can only lower confidence or fill in a gap, such as an item or size the rules already read on screen.
  - It can never push an unclear comment past the grant line on its own.
- **AG Grid** for the seller's ledger.
- **Render** hosts it as one Docker web service, from a Blueprint (`render.yaml`).
- **Tests:**
  - 540 Vitest tests;
  - a 23-check Playwright run that drives the real UI with a seller and two buyers;
  - an offline evaluation harness for the resolver.

## Challenges I ran into

- **Fairness under network jitter.** Comments arrive out of order. Ranking by the platform's timestamp, with a short settle window, lets an earlier comment pre-empt a provisional grant without ever overselling.
- **When the AI should not decide.** A wrong sale costs more than asking, so the model is fenced in.
  - It can't push a comment past the grant line.
  - A size or colour with no claim word ("48 yellow please") can't be granted without the seller.
  - I scored the rules once on a held-out set of 350 comments from seven public live-sale replays. A second annotator, labelling blind, agreed at Cohen's kappa 0.989.
  - The rules still made 3 harmful grants out of 16, all bare two-digit numbers typed while a different item was on screen. That is the next thing to fix.
- **Charging buyers who aren't online.** A merchant-initiated vault order does not copy the wallet's address by itself. I found that against the live sandbox. Close-out now reads the address from the saved payment token and sends it with the charge; verified live in the sandbox.

## Accomplishments that I'm proud of

- **The full PayPal loop runs against the real sandbox:**
  - a buyer saves PayPal in the app's Claim Pass sheet;
  - their claims confirm on the pass;
  - close-out charges the cart as one merchant-initiated order (COMPLETED);
  - a live $1.00 vault order carried the wallet's ship-to address.
- **Rules and LLM together.** On five development sets, rules plus Groq made zero harmful grants, and on the dev-real3 set of real chat, Groq raised grant recall from 0.522 to 0.565. These sets were read while I wrote the rules, so these numbers are in-sample.
- **Every outcome explains itself.** Each grant, waitlist and pre-emption has a plain-language reason the seller can show a buyer.

## What I learned

- Measure before trusting the model. The held-out set showed exactly where it would have sold an item to the wrong person.
- PayPal's vault and order APIs make "charge after the show, buyer offline" possible, but the details matter: `stored_credential`, shipping on merchant-initiated orders, idempotency keys, and webhook signatures checked against the raw body.

## What's next

- Seller sign-in, and a durable shared event log, so it can run on more than one instance.
- Native chat sources beyond Twitch: Instagram, YouTube and Facebook Live.
- Scoring the Groq configuration on the held-out set. Its numbers so far are in-sample.
- Multi-currency, and sellers outside the US.

## Built with

`paypal` · `paypal-vault` · `paypal-orders-api` · `paypal-js-sdk-v6` · `paypal-webhooks` · `groq` · `gpt-oss-20b` · `ag-grid` · `render` · `docker` · `next.js` · `react` · `typescript` · `tailwindcss` · `node.js` · `server-sent-events` · `vitest` · `playwright`

---

### Checklist before submitting

- [ ] Render URL live, and pasted above and in the README.
- [ ] Video recorded from [DEMO-SCRIPT.md](DEMO-SCRIPT.md), under 3 minutes, uploaded (YouTube or Vimeo, public or unlisted).
- [ ] GitHub repo public.
- [ ] Judges' sandbox buyer.
  - Create a separate *personal* sandbox account for judges (developer.paypal.com → Testing Tools → Sandbox Accounts → Create account, United States).
  - Put its email and password in Devpost's testing-instructions or additional-info field, and nowhere in the repo.
  - Without it, judges can run every simulation and the review lane, but not the PayPal windows.
- [ ] Deadline: Nov 12, 12:00 PST (Nov 13, 01:30 IST).
