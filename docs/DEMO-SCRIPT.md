# Demo video script

One cut, under 3 minutes, recorded against **PayPal's sandbox** and **Groq**. The banner reads "PayPal sandbox", and the "p95 resolve" card reads "rules + groq". Every payment in it is a real PayPal API call with test money. Say "sandbox" once on camera, and never call it real money.

## Before you record

- **Where.** Use the Render deployment, because that is the link judges get and PayPal's webhooks can reach it. Or use a local production build (`npm run build && npm start`, http://localhost:3011) with `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `GROQ_API_KEY` in `.env`.
- **Warm it up.** Render's free plan sleeps after 15 minutes. Open the URL a minute before you record.
- **A PayPal sandbox buyer.** Use a *personal* account from developer.paypal.com → Testing Tools → Sandbox Accounts.
  - You log in twice on camera: once for the Claim Pass, once for the pay-now checkout.
  - PayPal's window shows that account's sandbox email. The password field is masked.
- **Screen.** Chrome at 1440 px or wider, 100% zoom, notifications off.
- **One take, one fresh show.** Start every take from the landing page with **Start a demo show**.
- **Reach the pay-now step within 5 minutes of the race.**
  - Simulated buyers cannot approve a PayPal window, so in sandbox they hold items on a 5-minute pay-now timer.
  - Past that, a hold lapses and the waitlist moves up.
- **Keep the order.** Every outcome below was measured by driving these beats through the API in this order (2026-10-06). The comment outcomes and review cards matched in both runs. A different order changes the stock each beat sees.
- **Lines marked *Groq* come from the model** and can differ between takes.

## 3-minute cut

| Time | On screen | Do this | Voice-over |
|---|---|---|---|
| 0:00-0:10 | Landing, then the split screen: seller console on the left, buyer phone on the right. Banner: "PayPal sandbox". | **Start a demo show** | "Boutiques sell on live video. When an item is on camera, the chat floods: 'sold', 'me', '12 M', in slang and in Hindi. Someone has to work out who was first, then chase everyone for payment." |
| 0:10-0:30 | Phone: the Claim Pass sheet, then PayPal's sandbox window. Log in and approve. The phone shows "Claim Pass linked". | In the phone, **Get Claim Pass**, pick **$100**, then **Save PayPal**. Trim the typing in the edit. | "A buyer saves PayPal once, before the show. That's PayPal's vault: the boutique keeps a token, never the card, under a spending cap. Nothing is charged yet." |
| 0:30-0:45 | Voice listing: the draft reads #9 Sage Linen Button Down, $36.00, S ×2, M ×1. It carries one warning: "price read from a bare number (36); confirm it". | **Use a sample**, then **Draft listing**, then **Confirm and put on air** | "The host lists by talking. 'Number 9, sage linen button down, two smalls and a medium, thirty six.' It flags the bare number, and nothing goes live until the seller confirms." |
| 0:45-0:53 | The phone stamps the claim YOURS. The seller's feed shows jess GRANTED. | In the phone's chat, type `sold 9 S` and send | "With a Claim Pass, a claim is confirmed the moment it lands. Nobody checks out during the show." |
| 0:53-1:12 | #12 M: ava and dana GRANTED, each with a 5-minute pay-now timer. ben WAITLIST #1, cleo WAITLIST #2. Open **Why?** on ben's ticket. | Run sheet **#12**, choose **4 buyers race for 2 items**, then **Simulate** | "Four buyers, two mediums. Claims are ranked by the platform's own timestamp, not by when they reached us. Two win, two wait in line, and every ticket says why. These four have no Claim Pass, so they get five minutes to pay." |
| 1:12-1:32 | #7 S: gia GRANTED, then flipped to WAITLIST #1, and hal GRANTED. Open **Audit**: "pre-empted on #7 S black … arrived 900ms after the grant, inside the 2000ms settle window". | **#7**, choose **Late-arriving earlier comment**, then **Simulate** | "Networks are uneven. hal typed first, but his comment landed almost a second after gia's. Grants stay provisional for two seconds, so the earlier comment still wins." |
| 1:32-1:55 | #21 Hinglish burst. meera_j "bhaiya 21 L de do na" GRANTED. ananya_s "mujhe 21 S chahiye" GRANTED. neha_r WAITLIST #1. "mast hai yaar 😍" CHATTER. "kya 21 red mein hai?" and "ye kitne ka hai?" QUESTION. *Groq:* isha "21 L pakka" and simran.b "S wala mera" go to **Needs you**. | **#21**, choose **Hinglish burst**, then **Simulate** | "Real chat is Hinglish and slang. Rules settle the clear comments instantly, and the unclear ones go to an LLM on Groq. 'Mast hai yaar' is chatter, 'ye kitne ka hai' is a question. When the model isn't sure, like '21 L pakka', the seller decides, because a wrong sale costs more than asking." |
| 1:55-2:05 | isha becomes GRANTED, held for pay-now. simran.b becomes WAITLIST #1, and neha_r moves to #2. | On isha's card, **Approve L · rust**. On simran.b's card, **Approve S · rust**. | "One tap puts the claim on the size the buyer named. The small is already gone, so simran joins the waitlist, ahead of neha, because she commented first." |
| 2:05-2:25 | Close-out: jess's cart is #9 S at $36.00 plus $8.00 shipping. After the charge, the card shows **Ship to** with the sandbox buyer's PayPal address, then "vault order … · capture …". | **End show**, then **Charge 1 Claim Pass cart · $44.00** | "The show ends, and every buyer gets one cart with combined shipping. Claim Pass carts are charged in one go, against the saved PayPal, while the buyer is offline. The ship-to address comes from their PayPal wallet." |
| 2:25-2:45 | ava's row shows a $42.00 link. On PayPal's sandbox checkout, log in and pay. Back on Claim!: "Confirming with PayPal…", then PAID. Close-out: ava's cart is charged, with a Ship to. | On ava's row, **Send pay-now link**, then the **Open pay-now link** icon (new tab), then **Pay Now** on PayPal | "Buyers without a Claim Pass get one link for everything they hold. They pay on PayPal's own checkout and land back on a receipt." |
| 2:45-2:55 | jess's card: "Refunded $5.00", then "Tracking added; PayPal notifies the buyer". On Render with webhooks connected, the order line gains "· refund confirmed by PayPal". | **Refund** $5. Then **Add tracking** with USPS and any number. | "Refunds and tracking are one click each, through PayPal's APIs. PayPal's signed webhooks come back in, so the seller sees PayPal confirm it." |
| 2:55-3:00 | **Ledger**: the AG Grid table with its Ship to column, then **Export CSV** | **Ledger**, then **Export CSV** | "Claim!: PayPal Vault and Orders, an LLM on Groq, AG Grid, running on Render." |

## Notes for the recording

- **If a *Groq* card doesn't appear.** In both measured runs, isha and simran.b went to review. If the model settles one of them differently in a take, approve whichever card is there, or skip that beat.
- **Saving the Claim Pass inside the phone pane.**
  - PayPal's window opens from the phone pane with no console errors (checked 2026-10-06).
  - The full approval was last recorded in the standalone buyer room (2026-10-05).
  - If the window closes without "Claim Pass linked", open **Buyer room** from the header and save the pass there.
- **Pay-now in sandbox.**
  - After the buyer pays on PayPal's checkout, PayPal sends them back to `/pay`, which captures without a second click.
  - That return path was checked up to PayPal refusing an order nobody had approved (2026-10-06). The order stayed open and payable.
  - A full sandbox payment through the checkout page has not been recorded yet. Do it once in a dry run.
- **Refund and tracking in sandbox.** Both passed in the gateway spike. The dry run is their first pass through the app's UI.
- **Webhooks.**
  - They arrive only on the deployed URL, after `PAYPAL_WEBHOOK_ID` is set (see [DEPLOY.md](DEPLOY.md)).
  - PayPal can take from seconds to minutes to deliver.
  - If the confirmation hasn't arrived, cut that line. Never stage it.
- **No decline in this cut.** The sandbox has no scripted decline. The Devpost text covers the fallback, and the mock run below shows it.
- **Twitch.** **Read a Twitch chat** connects to any live channel, read-only. It is not in the cut, because a live channel's chat can't be planned.

## Mock-mode fallback

If PayPal's sandbox is down, or the login misbehaves on the day, record with no PayPal keys.
- The banner reads "Sandbox not connected: simulated payments". Say so in the voice-over.
- Groq still runs, so the "p95 resolve" card still reads "rules + groq".
- The Claim Pass sheet saves without a PayPal window.

Run the same beats in the same order (measured 2026-10-06):
- **Simulated buyers hold Claim Passes.** Most of their grants are confirmed on the pass instead of held for pay-now.
- **Close-out charges 4 Claim Pass carts, $165.00 due.**
  - jess $44.00, ava $42.00 and ananya_s $37.00 are charged.
  - dana's $42.00 declines.
  - On dana's card: **Offer a pay-now link**, then **Open pay-now link**, then **Pay with PayPal**.
- **Ship-to addresses are placeholders** ("843 Main St, San Jose") made from the buyer's name.
