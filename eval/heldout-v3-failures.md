# Held-out v3: result and failure patterns

Held-out v3 was scored once on 2026-10-05, after the round-3 dev gates passed. Results are in `eval/results/2026-10-05T12-00-59.md`, with per-comment predictions in `2026-10-05T12-00-59-predictions.jsonl`.

The source was frozen before the run: sha256 over every file in `packages/resolver/src` and `packages/llm/src` was `86d9b9fa3acfb72845acab7d933cddea60ebe08fb70861ab56c967f404e35f4f`. The hash matched just before the run and again after this write-up. Nothing in the resolver, the LLM package or the prompt changed after the run.

The run made 20 claude-cli calls: 9 for rules + cli, 7 for cli only, and 4 single-comment latency samples.

## The set

Seven replays, none overlapping held-out v1, held-out v2 or any dev set:

| show | source | format | items | rows in sample |
|---|---|---|---|---|
| v3-trusty | vD5j_ZHEJ7c | US vintage, numbered. Also 12 lettered bargain-bin codes, and a number-guessing game in chat | 52 | 50 |
| v3-sparkle | XxCmxitOa6I | US $5 jewellery, numbered | 64 | 50 |
| v3-gary | r5vtg_Y1IZQ | US comics, slots A–W, nothing marked on screen | 23 | 50 |
| v3-honey | mPYomEzM8Hc | Indian suits, one piece at a time | 1 (143 variants) | 50 |
| v3-zaid | dCbiICbLmIU | Indian chikankari kurtis, one at a time | 1 (195) | 50 |
| v3-sikka | LHC9htbwySY | Indian candles and diyas, one at a time | 1 (14) | 50 |
| v3-simran | k2cLnVEJNeg | Indian Xuping jewellery, one at a time | 1 (120) | 50 |

That is two multi-item numbered shows (trusty, sparkle), plus a third multi-item show with slot codes (gary), and four Indian one-piece-at-a-time shows. The search found no Indian numbered show.

- **Sample:** 350 rows, drawn with seed 20261005 from `eval/raw/heldout-v3/pool.jsonl`.
- **Masking:** 5 email or handle fragments in the pool were replaced with `[email]` before labelling.
- **Gold:** claim 52 (49 name a catalogue item, so they count toward grant recall), change 1, cancel 2, question 77, other 218.
- **Tags:** current-mismatch 7 (the item the timeline puts on screen differs from the one the comment is about), game-guess 6, disputed 1, disputed items 1.

## Annotation

The protocol is the same as v2. The merge rule in `eval/merge-labels.ts` was fixed before any label was read and has not changed since round 2.

- **Annotator A** labelled all 350 rows.
- **Annotator B** worked blind to A and labelled 151 rows:
  - 133 keyword candidates, picked by the round-2 regex with bare letters widened from A–J to A–Z;
  - plus the 18 rows A had called claim, change, cancel or waitlist that the regex missed.
- **Agreement:**
  - kind agreed on 150 of 151 rows;
  - Cohen's kappa is 0.989 over the 6 kinds and 0.985 for claim/change against everything else;
  - on the 51 rows both annotators called claim, they chose the same item codes on 50.
- **The one kind disagreement** was claim against other. The merge made it a review-only claim, so any grant on it scores as harmful.

Details are in `eval/data/heldout-v3-agreement.md`.

## Result

| config | kind acc | grants | harmful | grant precision | grant recall (n=49) |
|---|---|---|---|---|---|
| naive regex | .634 | 0 | 0 | – | 0 |
| rules only | .743 | 16 | 3 | .813 | .265 |
| rules + claude-cli | .703 | 16 | 3 | .813 | .265 |
| claude-cli only | .803 | 12 | 3 | .750 | .184 |

**Precision gate:** missed. The dev sets show 0 harmful grants, but held-out v3 has 3 under every config.

Per show, rules only. Rules + cli is identical on every show.

| show | grants | harmful | recall |
|---|---|---|---|
| v3-trusty | 8 | 3 | 5/5 |
| v3-sparkle | 7 | 0 | 7/16 |
| v3-honey | 0 | 0 | 0/8 |
| v3-zaid | 0 | 0 | 0/1 |
| v3-sikka | 1 | 0 | 1/11 |
| v3-simran | 0 | 0 | 0/8 |
| v3-gary | 0 | 0 | no grantable rows in the sample |

## Grant precision by confidence bucket

| config | 0.80–0.85 | 0.85–0.90 | ≥ 0.90 |
|---|---|---|---|
| rules only | – (0 grants) | .800 (15 grants, 3 harmful) | 1.000 (1, 0) |
| rules + claude-cli | – (0) | .800 (15, 3) | 1.000 (1, 0) |
| claude-cli only | – (0) | .000 (2, 2) | .900 (10, 1) |

The same buckets on the dev sets (`eval/results/2026-10-05T11-28-37.md`) are 1.000 everywhere. The only dev grant in 0.80–0.85 is one from the LLM on dev-real2-claims.

What this means for the auto-accept line:

- **The 0.80–0.85 band is empty** for the rules, on dev and on held-out alike. A line at 0.80 and a line at 0.85 accept the same grants.
- **Every harmful v3 grant comes from the rules** and sits at 0.85, the "bare code" score. Raising the line to 0.90 would remove all 3 harmful grants. It would also remove 12 of the 13 correct grants, leaving only "Book 380 green" at 0.95.
- **Bucketing does not separate the harmful bare codes from the correct ones.** Whether the code matches the on-screen item does (next section).

## Failure patterns

### Harmful grants (3, all in v3-trusty, all rule "bare code" at 0.85, under all three configs)

| comment | on screen | gold | why it is wrong |
|---|---|---|---|
| "54" | 56 | other | A guess in the chat number game (the host asked for numbers 50–60) |
| "35" | 56 | other | Also a game guess |
| "33" | 32 | review-only claim (items disputed) | Probably a typo for 32, so the annotators would not name the item |

All three are bare 2-digit numbers that are listed codes, typed while a *different* item was on screen. The LLM made the same three grants in cli-only mode.

Matching the bare code against the on-screen item separates them:

| set | bare-code rule grants where code = on-screen item | code ≠ on-screen item |
|---|---|---|
| held-out v3 | 9, all correct | 6: 3 harmful, plus 3 correct sparkle grants tagged current-mismatch |
| all five dev sets | 74, all correct | 4, all correct |

So a rule that sends an off-screen bare code to review would have removed every v3 harmful grant. It would cost 3 correct v3 grants and 4 correct dev grants. This was not applied: held-out v3 is now burned, and the change belongs to the next round's dev work.

### Did the round-3 validation matter on v3?

I replayed the cached LLM answers from this run through `validateLlmResult` without the comment text, which is the round-2 behaviour. This made 0 new calls and changed no source.

| config | grants / harmful as run | grants / harmful with text-blind validation |
|---|---|---|
| rules + claude-cli | 16 / 3 | 18 / 3 |
| claude-cli only | 12 / 3 | 14 / 3 |

- **What it cost:** the "no claim word" cap removed 2 correct grants, "214 liz cable" and "Liz Sánchez 466".
- **What it prevented:** no harmful grants. With the text-based checks off, the remaining validation (variant caps) and the rules' `llmCap` still kept every non-claim below 0.8. So v3 never exercised fixes 2b–2d on a harmful case.
- **The variant-only fix (2a)** also went unexercised. V3 has 7 comments with a size or colour and no claim word ("White mein 44", "48 yellow please", "yellow", "34"…). All 7 are non-claims (4 other, 3 question), and the rules held all of them at 0.75. Whether the round-2 rules would have granted them was not measured.

### Missed claims (36 of 49 under rules + cli)

| pattern | count | examples | what happens now |
|---|---|---|---|
| Union variant grid: one stand-in item carries every variant, and the comment's size, number or price does not pick one (class 4) | 12 | "ok mera 40 size kr do", "L book nidhi", "Book 1", "di 5 book", "Book for me 270", "book 2 pcs 175", "bhai mera bhi kardo" | claim at 0.75, "variant not given" |
| Code with a viewer name or one extra word, no claim word (sparkle) | 7 | "214 liz cable", "Liz Sánchez 466", "493 ×2", "151 set", "Missy Miller Green 59" | The rules see "code amid chatter". The LLM says claim and is capped at 0.75 by "no claim word" |
| Description or price instead of a code (class 6) | 6 | "book modak", "book hinga", "Book 6 heart diya", "chain book", "270", "480" | Rules: other or 0.75. The LLM reads unknown product words as a question at 0.8–0.9 |
| "bk" as an abbreviation of book, not read as a cue | 4 | "bk green", "bk 2 candle", "yes please bk 380", "bk9" | other at 0.6. The LLM caps at 0.75 or says question |
| Long Hinglish with a question word (class 7 shape) | 2 | "rate kya h mam krdo 7654", "mam mene 699 wala article book kiya tha wo cancell krke…" | question at 0.75 |
| Phone or order digits beside "book" or a size | 2 | "book 999056", "44 size 83283" ("Book 42 mam 749496" is counted under class 4) | Unknown number caps the comment |
| Late, restated or clarifying claim | 2 | "That was 214 for Linda Newman", "Oh yes set please" | other |
| Fragment | 1 | "bhi" | other |

### Kind accuracy

- **Rules + cli scores below both rules alone and cli alone:** .703 against .743 and .803.
- **The cause is the LLM's question fallback** (worklist class 10, still open). Rules + cli labels 57 "other" comments as question, against 25 for rules only. They reach the LLM because the rules route them.
- **Grants are unaffected:** a question is never granted.

## Leave-alone classes on v3 (counts only)

| class | v3 count (missed under rules only and under rules + cli) | dev-real3 count, for comparison |
|---|---|---|
| 4: one stand-in item carries every variant | 12 / 12 | 5 (rules + cli) |
| 6: claim by description or price | 6 / 6 | 4 (rules + cli) |
| 7: long polite Hinglish capped at 0.75 | 2 / 2 | 2 rules only, 0 rules + cli |

**Class 4 is the largest recall loss on v3.** It accounts for 12 of the 36 misses and appears in all four one-at-a-time shows. It needs an engine or data-model answer: either the item on screen carries its own variants, or a claim on a stand-in item is granted without a variant.

## What this set does not test

- **Indian numbered shows.** None was found, so v3 does not cover numbered Hinglish claims.
- **Cancels and changes.** There are 2 cancels and 1 change, too few to say anything.
- **Slot letters.** Gary has nothing marked on screen and no claims in the sample, so the letter rule saw no claims. Trusty mixes numbers with letters, so the letter rule (all-letter catalogues only) does not apply there either.
- **The 0.80–0.85 band.** No rule produces grants there, so its precision is unmeasured.


## Burned by MAIN, 2026-10-05

After reading this run, MAIN added one rule. A bare code for an item that is not on screen now goes to review: it is capped at the review line and not sent to the LLM. `commentEvidence` also stops counting it as the "type the number" claim cue, so the LLM cannot re-grant it.

Measured with rules only, on all dev sets, held-out v3 and synthetic (`results/2026-10-05T12-12-03.md`):
- Harmful grants: 0 everywhere. On v3 this went from 3 to 0.
- Grants: v3 went from 16 to 10, dev-real3 from 26 to 25, synthetic from 168 to 150.

That makes v3 in-sample for this rule. The next scored-once set is held-out v4, and it must come from fresh replays.
