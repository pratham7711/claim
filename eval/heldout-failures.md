# Round-2 worklist: the held-out v1 failures, now dev data

Held-out v1 was scored once on 2026-10-05, in `eval/results/2026-10-05T10-17-42.md`. After that it was burned and renamed to dev data:

| Before | After |
|---|---|
| `heldout.jsonl` | `dev-real2.jsonl` |
| `heldout-claims.jsonl` | `dev-real2-claims.jsonl` |
| `heldout-shows.json` | `dev-real2-shows.json` |
| `eval/raw/heldout/` | `eval/raw/dev-real2/` |

Show ids are now `dev2-*`. The runner labels these sets "dev (was held-out v1, burned 2026-10-05)". Their numbers are in-sample from here on.

Round 2 made the resolver precision-first. A harmful grant is far worse than a comment landing in the seller's review lane, so:
- The rules auto-grant only unambiguous first-person claim patterns.
- Everything else is capped below 0.8 and goes to the LLM or to review.
- When the rules positively identify a non-claim, the LLM answer is capped at 0.75 too (`llmCap` / `capReason`).

None of the fixes below copies a dev sentence. Each class has its own test cases in `packages/resolver/src/precision.test.ts`.

## Classes and what was done

| # | Class (round-1 example) | Round-2 fix | Status |
|---|---|---|---|
| 1a | Third-person subject ("X wants it") | A third-person verb form (wants, needs, claims…), or a subject pronoun / relative noun before a cue verb, or Hindi usko/unko… marks the claim as someone else's. Rules return other; the LLM is capped. | fixed on dev |
| 1b | Negated cue ("not me") | A negation before the cue ("not", "never", "don't", "not for me") or Hindi "nahi" after it. | fixed on dev |
| 1c | Past report ("I claimed after…") | "claimed" is no longer a cue. Past forms (claimed, bought, got, took…) and Hindi perfectives (maine…, ho gaya, kar diya, de di…) mark a report. | fixed on dev |
| 1d | Cue aimed at a non-item ("claim <noun>") | A cue verb whose object is an unknown word, with no code, title or variant in the comment, is capped for rules and LLM. | fixed on dev; costs recall ("claim boba" now goes to review) |
| 2 | Number lists ("1 3 5") | Any number that is not a listed code caps the comment for rules and LLM. A bare code with no cue is at most 0.85, and a bare single digit is 0.75 (review). Digits inside a username ("name525") are skipped. | fixed on dev |
| 3 | Grades ("claim 9.6") | A decimal ≤ 10 with one or two places is a grade, not a code. After a cue it claims the on-screen item at ≤ 0.85; with nothing on screen it is not granted. | fixed on dev |
| 4 | "No cue" settled at 0.85 | Comments with an item reference (number, size, colour, ye/this/it/wala), Hindi, or an unknown word in a short comment are routed to the LLM. A Hinglish spelling normaliser covers about 150 variants (kr/krdo/muje/chaiye/nhi/kese/btao/dikhao/he→hai in Hindi context…), plus Devanagari forms of the claim, question and pronoun words. | done; routing grew (dev-real2: 50 → 137 routed) |
| 5 | "How do I book" read as a claim | A how/where/which/kaise/kis/kab word before the cue makes the comment a question. | fixed on dev |
| 6 | "question" as a fallback | The prompt now says: show requests are other, and "if you cannot tell, answer other ≤ 0.4". | partly. LLM kind accuracy on dev-real2 is still below rules only (0.774 vs 0.829). |
| 7 | LLM harmful grant ("got 1…") | Covered by 1c: a past report caps the LLM. | fixed on dev |
| 8 | Changes and swaps (Hindi "dusra wala") | Glossary entry only. | open |
| 9 | Shades outside the catalogue | Product decision, not addressed. | open |
| new | Wish or hypothetical ("I need all the X") granted by the LLM | A hypothetical now caps the LLM answer too. This came from the round-2 dev run (synthetic). | fixed on dev |
| new | Title word + variant without a cue ("romper 3T pink") | Lowered from 0.80 to 0.75: a title word is a weaker reference than a code. | deliberate recall loss |

## Gate result on the dev sets (round 2)

Rules-only harmful is 0 and rules + claude-cli harmful is 0 on synthetic, real, dev-real2 and dev-real2-claims. See `eval/results/2026-10-05T10-40-35.md`.

- **Recall fell where the rules used to guess.** dev-real2-claims dropped from 0.294 to 0.235 with rules only.
- **The LLM adds no grants on dev-real2.** Every claim it could have granted there is either capped or below 0.8.

## Still open for a later round

- Hindi changes and swaps (class 8), and colour shades (class 9).
- **LLM kind accuracy.** On Hinglish chatter it still prefers question over other.
- **Recall on unnumbered US claim sales.** "claim <character name>" refers to the comic on screen, but the catalogue title doesn't contain the name, so it goes to review. A per-item alias list (what the host calls the item) would fix it without loosening the rule.

## Held-out v2 (scored once after the dev gates passed)

Results are in `eval/results/2026-10-05T11-11-52.md`, and the failure patterns are in `eval/heldout-v2-failures.md`.

The dev gates did not carry over. Held-out v2 had 2 harmful grants with rules only and 4 with rules + claude-cli, mostly from a colour or size with no claim word in single-item Indian shows.
