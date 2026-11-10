# Devpost submission: PayPal AI Hackathon (draft)

Paste each section into the matching Devpost field.

**Name:** Claim!

**Tagline (under 200 characters):** Closer, an AI agent that collects after a live sale on PayPal. It plans invoices, reminders and refunds with PayPal's Agent Toolkit, and the seller approves every one.

**Try it:** https://claim-paypal.onrender.com. Press **Start a demo show**. The seller console and a buyer's phone open side by side. The free host sleeps when idle, so the first load can take about a minute. Payments run on the PayPal sandbox; the testing instructions have a sandbox buyer login for paying an invoice.
**Code:** https://github.com/pratham7711/claim/tree/paypal

---

## Inspiration

Independent boutiques sell on live video. A buyer types "sold 12 M" and the cardigan is theirs. The sale takes a minute. Collecting takes the rest of the night: the seller works out who paid, sends each buyer a payment request by DM, chases the ones who go quiet, and refunds the one whose sweater had a pulled thread. That work is repetitive and rule-bound, but it moves money, so it should not be handed to a model unsupervised.

## What it does

Claim! runs the live sale, and its agent, **Closer**, runs the collecting afterwards.

1. **During the show**, Claim! reads every comment as a claim, cancel, size change, waitlist request, question or chatter. It holds each item for the buyer who asked first, by the platform's timestamp, and never oversells.
2. **Claim Pass.** A buyer can save PayPal once, before the show, through PayPal Vault with a spending cap. Their cart is charged once when the show ends, with no checkout during the show.
3. **Closer, after the show.** The seller types what they want in plain words, for example "Invoice everyone who hasn't paid yet", "Who still owes me? Nudge them, nicely" or "Refund jess $5, the cardigan had a pulled thread". Closer reads the show's ledger and proposes one action per buyer:
   - create and send a PayPal invoice;
   - send an invoice reminder;
   - refund part of a capture;
   - add shipment tracking;
   - charge Claim Pass carts, send a pay-now link, or release a hold.
4. **The seller approves.** Proposals land in an approval queue with the PayPal call, the amount, the note to the buyer and Closer's reason. The seller can edit a note, approve or reject a row, or **Approve all**. Nothing that moves money runs before that.
5. **PayPal closes the loop.** When the buyer pays the invoice, PayPal's signed `INVOICING.INVOICE.PAID` webhook marks the cart charged. While an invoice is open, the buyer's items stay held for them, and Claim! will not send a second payment link or release them to the waitlist.

## How I built it

- **Closer** (`packages/closer`):
  - **Planner.** A tool-calling loop on **Groq**: `openai/gpt-oss-120b`, falling back to `openai/gpt-oss-20b` on a rate limit, then to a rule-based planner, labelled as such. It sees a snapshot of the show's money with short references, never buyers' email addresses.
  - **Validator.** It sits between the model and PayPal. Amounts always come from the ledger, never from the model. A refund cannot exceed what is left of the capture, reminders wait 60 s, and nothing is queued twice. A rejected call goes back to the model with the reason, so it can correct itself.
  - **Executor.** It uses **PayPal's Agent Toolkit** (`@paypal/agent-toolkit`): `create_invoice`, `send_invoice`, `send_invoice_reminder`, `get_invoice`, `create_refund` and `create_shipment_tracking`. Each step carries its own `PayPal-Request-Id`, so approving twice runs once.
- **PayPal REST APIs** beyond the Toolkit:
  - **Vault** (payment method tokens v3, with the **JS SDK v6** save session) for the Claim Pass.
  - **Orders v2** for merchant-initiated vault charges and pay-now links.
  - **Payments v2** for refunds.
  - **Webhooks**, verified with `verify-webhook-signature` against the raw body. Nine event types are handled, including `INVOICING.INVOICE.PAID`.
- **The approval queue** is an **AG Grid** table with keyboard shortcuts. Every plan, proposal, decision and PayPal result is an audit record.
- **The app** uses **Next.js 16, React 19 and TypeScript** in npm workspaces. State is an append-only event log, pushed to the browser over server-sent events.
- **Hosting:** **Render**, one Docker web service on the free plan.
- **Tests:** 606 Vitest tests. Request bodies are checked against PayPal's published OpenAPI specs, and the Toolkit path is tested with the real `@paypal/agent-toolkit` and a stubbed HTTP layer.

## Challenges I ran into

- **Letting the model plan without letting it spend.** The model only proposes. Each proposal is validated against the ledger when it is planned, and again when the seller approves it, because the ledger can change in between.
- **An invoice and a hold are two claims on the same item.** If the seller released a held item while its invoice was still open, a buyer could pay for something already sold to someone else. Open invoices now block both a release and a second pay-now link for the same items, and the seller sees why.
- **Collecting from buyers who are offline.** A merchant-initiated vault order does not copy the wallet's ship-to address by itself, which I found against the live sandbox. Close-out now reads it from the saved payment token.
- **Reminder spam.** "Who still owes me?" asked twice in a minute would nudge the same buyer twice. The validator holds a reminder back until 60 s have passed, and Closer says so in its one-line answer.

## Accomplishments that I'm proud of

- **The whole loop runs on the PayPal sandbox, from the hosted demo:** claim in chat, end the show, Closer plans on gpt-oss-120b (2.1 to 4.1 s across five runs), **Approve all**, and the Agent Toolkit sends real invoices. A sandbox buyer pays one in PayPal's invoice page, and the `INVOICING.INVOICE.PAID` webhook settles the cart with no seller action. It is all in the video.
- **The AI is useful and fenced in at the same time.** The seller types one sentence and gets a reviewed plan, but a model mistake can, at worst, propose something the seller then rejects.
- **Every action explains itself.** Each proposal carries the PayPal call it will make and the planner's reason, and the plan's summary is built from the queue, not from the model's prose.

## What I learned

- An agent that touches money needs a ledger it cannot write to. Making the model read references and letting code compute amounts removed a whole class of errors.
- PayPal's invoicing and webhooks make "collect later" a real workflow, but the edge cases sit between systems: an open invoice against a held item, a webhook arriving before the seller looks, a reminder sent too soon.

## What's next

- Seller sign-in and a durable shared event log, so it can run on more than one instance.
- Chat sources beyond Twitch: Instagram, YouTube and Facebook Live.
- Scheduled follow-ups, where Closer proposes the next reminder on its own and the seller still approves it.
- Multi-currency, and sellers outside the US.

## Built with

`paypal` · `paypal-agent-toolkit` · `paypal-invoicing` · `paypal-vault` · `paypal-orders-api` · `paypal-js-sdk-v6` · `paypal-webhooks` · `groq` · `gpt-oss-120b` · `ag-grid` · `render` · `docker` · `next.js` · `react` · `typescript` · `tailwindcss` · `node.js` · `server-sent-events` · `vitest` · `playwright`

## Testing instructions (Devpost field only, never in the repo)

1. Open https://claim-paypal.onrender.com and press **Start a demo show**. The first load after idle can take about a minute.
2. In the buyer's phone on the right, type `sold 12 M` and press Send. The cardigan is held for you.
3. In the seller console, pick a simulation (for example the race) and press **Simulate**. Then press **End show** and open **Close-out**.
4. In the Closer panel, type "Invoice everyone who hasn't paid yet" and press **Plan**, then **Approve all**.
5. Open the **PayPal payer view** link on your own row. Pay with PayPal using the sandbox buyer below.
6. Back on close-out, your cart shows as charged within a few seconds, from PayPal's webhook. Then try "Who still owes me? Nudge them, nicely". A reminder is planned once a minute has passed since the invoice.

Sandbox buyer: `<JUDGE_EMAIL>` / `<JUDGE_PASSWORD>`, a PayPal sandbox personal account with no real money.

---

### Checklist before submitting

- [x] Hosted demo live on the PayPal sandbox (Render, free plan).
- [x] Judges' sandbox buyer created; its invoice paid end to end.
- [ ] Video under 3 minutes, uploaded to YouTube.
- [x] GitHub repo public, with the `paypal` branch pushed.
- [ ] Replace `<JUDGE_EMAIL>` / `<JUDGE_PASSWORD>` in the Devpost testing field only.
- [ ] Deadline: Nov 12, 12:00 PST (Nov 13, 01:30 IST).
