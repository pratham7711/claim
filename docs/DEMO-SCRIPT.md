# Demo video script

There are two cuts: a 3-minute walkthrough and a 30-second version. Both are recorded on a fresh demo show in mock-payment mode. The banner reads "Sandbox not connected: simulated payments", and the "p95 resolve" card reads "rules · LLM off". The voice-over says so; do not imply live PayPal money or an LLM in this recording.

**Setup.**
1. Run `npm run dev` and open http://localhost:3011 in Chrome.
2. Click **Start a demo show**. The split screen at `/demo/<showId>` shows the seller console on the left and the buyer phone on the right.
3. Record at 1440 px or wider so both panes are readable.
4. Do the beats **in this order**. Every simulated outcome below was measured by driving this order through the API (2026-10-05). A different order changes the stock each step sees, and so changes the results.

**Times.** Simulations play out in real time: about 0.5 s for the race, 1.3 s for the late comment, 1.9 s for the bundle, about 3.3 s for the slang burst and 2.6 s for the Hinglish burst. Leave a beat of silence or trim in the edit.

## 3-minute version

| Time | On screen | Action that produces it | Voice-over |
|---|---|---|---|
| 0:00-0:12 | Landing page, then the split screen | **Start a demo show** | "Boutiques sell on live video. When an item is on camera, the chat floods: 'sold', 'me', '12 M', in slang and in Hindi. Someone has to decide who was first, and then chase everyone for payment." |
| 0:12-0:32 | Voice listing panel: the draft shows #9 Sage Linen Button Down, $36.00, S x2, M x1, plus one warning | **Use a sample**, then **Draft listing**, then **Confirm and put on air**. Then click **#12** in the Run sheet. | "Claim! starts with the host's own words. 'Number 9, sage linen button down, two smalls and a medium, thirty six.' That becomes a listing. It flags that the price was a bare number, and nothing goes live until the seller confirms." |
| 0:32-0:55 | Live comments: ava GRANTED, dana GRANTED, ben WAITLIST #1, cleo WAITLIST #2. Item board for #12 M. Open **Why?** on ben's ticket. | On #12, choose **4 buyers race for 2 items**, then **Simulate** | "Four buyers, two mediums. Claims are ranked by the platform's own timestamp, not by when they reached us. Two win, two wait in order, and every ticket says why." |
| 0:55-1:20 | #7 on air. gia's ticket shows GRANTED, then flips to WAITLIST #1. hal GRANTED. Open **Audit**: "pre-empted on #7 S ... arrived 894ms after the grant, inside the 2000ms settle window". | Click **#7** in the Run sheet, choose **Late-arriving earlier comment**, then **Simulate** | "Networks are uneven. hal typed first, but his comment landed almost a second after gia's. Grants stay provisional for two seconds, so the earlier comment still wins. hal has no saved PayPal, so he gets a five-minute pay-now hold. If he doesn't pay, the dress goes to gia." |
| 1:20-1:32 | #21 on air. nora: "sold 21 M and 12 L" gives two grants, then "claim 7 M too 🛍️" gives one more. | Click **#21**, choose **One buyer, three items, one cart**, then **Simulate** | "One buyer, two items in one comment, a third a moment later, across three different listings." |
| 1:32-2:00 | Slang burst, then Hinglish burst, scrolling. Then the **Needs you** review panel: 7 cards with the "Unsure" chip and plain reasons such as "Didn't say which size or colour." The "Needs you" KPI reads 7. | Choose **Messy slang burst**, **Simulate**. Then **Hinglish burst**, **Simulate**. | "Real chat is messy. 'can i get a small' is a claim. 'how much is shipping?' is a question. 'mast hai yaar' is chatter. 'bhaiya 21 L de do na' is a claim. Anything the desk isn't sure about, like a bare 'SOLD!!!' or 'me me me', goes to the seller instead of being granted. Getting a sale wrong costs more than asking." |
| 2:00-2:12 | Needs you panel: isha's "21 L pakka" becomes GRANTED (pay-now hold). kendall_b's "me me me 🙋‍♀️" becomes REJECTED. Optionally open **Resolver detail** on one card. | On isha's card, click **Approve L · rust**; L is preselected because she named it. On kendall_b's card, click **Reject**. Mouse or keyboard (J/K, A, R). | "One tap approves a claim onto the size the buyer named, or rejects it. If they didn't name a size, the seller has to pick one first." |
| 2:12-2:35 | Close-out page: carts for ava $42.00, dana $42.00, nora $111.00 (three items, shipping $0.00) and shopwithsam $37.00. Toast: 3 charged, dana declined. The button is replaced by "Every Claim Pass cart is charged". | **End show**, then **Charge 4 Claim Pass carts · $232.00** | "End the show and every buyer gets one cart with combined shipping. nora's three items ship free because she passed a hundred dollars. Buyers who saved PayPal with a Claim Pass are charged in one go, without being online. dana's card declines." |
| 2:35-2:48 | dana's card, then the pay page: $34.00 plus $8.00 shipping. **Pay with PayPal**, captured. dana's supplementary cart is charged. | On dana's card: **Offer a pay-now link**, then the link icon labelled "Open pay-now link" (new tab), then **Pay with PayPal** | "A decline doesn't lose the sale. dana's dress goes back on a pay-now link, and she pays at checkout. Or the seller can release it to the next person on the waitlist." |
| 2:48-2:58 | nora's charged cart: "Refunded $5.00", then "Tracking added; PayPal notifies the buyer" | **Refund** $5, then **Add tracking** (USPS + a number) | "Refunds and tracking are one click each, and a double-clicked refund is only sent once." |
| 2:58-3:00 | Banner close-up: "Sandbox not connected: simulated payments" | none | "Payments in this video are simulated. The same flow is coded against PayPal's sandbox: Vault, Orders, refunds and tracking." |

**Notes for the recording**
- **Combined shipping vs free shipping.** nora's cart shows $0.00 shipping because the subtotal ($111.00) is over the $100 free-shipping line. Every other cart shows the $8.00 first-item rate. To show the "$8 + $2 per extra item" rule, narrate it rather than claim nora's cart shows it.
- **The other close-out path.** **Release to waitlist** on dana's card promotes ben (Claim Pass, WAITLIST #1 on #12 M), and the button then offers one more Claim Pass charge. This is covered by `apps/web/lib/service.test.ts` ("closes out: charges Claim Pass carts, declines one, and cascades the declined unit to the waitlist").
- **Don't click "Approve N ready" in this cut.** The panel offers it when two or more cards have item and variant known. Bulk-approving changes the stock for the later beats, and that path was not measured.
- **Skip "Cancel, then waitlist promotion" in this cut.** Run after the race, dana cancels and ben is promoted (measured). dana then has no cart, so the decline beat at 2:12 would not happen.
- **hal's lease.** hal's 5-minute hold lapsing to gia is real (covered by the service test "expires an unpaid hold on the clock and promotes the next buyer"), but it is too slow for the cut. Mention it; don't wait for it.
- **Voice listing.** Chrome uses the browser's speech recognition. If the mic misbehaves on the recording machine, **Use a sample** fills the same text.

## 30-second version

| Time | On screen | Action | Voice-over |
|---|---|---|---|
| 0:00-0:05 | Split screen, #12 on air | **Start a demo show** | "Live-sale chat floods with 'sold' and 'me'. Claim! decides who got it." |
| 0:05-0:13 | ava and dana GRANTED, ben and cleo WAITLIST. Then on #7, hal pre-empts gia. | **4 buyers race for 2 items**. Then **#7** and **Late-arriving earlier comment**. | "Ranked by the platform's timestamp. Even a comment that arrives late wins if it was sent first." |
| 0:13-0:19 | #21: Hinglish burst. ananya_s "mujhe 21 S chahiye" and meera_j "bhaiya 21 L de do na" are GRANTED. Two cards land in **Needs you**. | **#21**, **One buyer, three items, one cart**, then **Hinglish burst** | "Hinglish and slang become claims. Anything unclear goes to the seller, not to a buyer." |
| 0:19-0:27 | Close-out: **Charge 4 Claim Pass carts · $232.00** (ava, dana, nora, ananya_s). dana declines. **Offer a pay-now link**, then **Pay with PayPal**. | **End show**, then charge, then pay-now | "One cart per buyer, charged through saved PayPal after the show. A decline falls back to a pay-now link." |
| 0:27-0:30 | Banner: simulated payments | none | "Claim! Payments simulated in this demo." |

The 30-second cut skips the voice listing, the slang burst and the review clicks. Its outcomes were measured separately in this exact order: race, then #7 late comment, then #21 bundle, then Hinglish burst.
- Without the slang burst, ananya_s gets #21 S (instead of WAITLIST #2), and only 2 comments go to review.
- The close-out still shows 4 Claim Pass carts and $232.00: ananya_s's $37.00 cart takes the place of shopwithsam's.
