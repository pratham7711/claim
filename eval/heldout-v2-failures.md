# Round-3 worklist: the held-out v2 failures, now dev data

Held-out v2 was scored once, on 2026-10-05, in `eval/results/2026-10-05T11-11-52.md`. After that run it was burned and renamed to dev data:

| Before | After |
|---|---|
| `eval/data/heldout-v2.jsonl` (merged gold) | `eval/data/dev-real3.jsonl` |
| `heldout-v2.a.jsonl`, `heldout-v2.b.jsonl` (annotators) | `dev-real3.a.jsonl`, `dev-real3.b.jsonl` |
| `heldout-v2-shows.json` | `dev-real3-shows.json` |
| `heldout-v2-agreement.md` | `dev-real3-agreement.md` |
| `eval/raw/heldout-v2/` | `eval/raw/dev-real3/` |

Show ids are now `dev3-*`. The runner labels the set "dev (was held-out v2, burned 2026-10-05)", and its numbers are in-sample from here on.

The round-2 failure analysis that this worklist replaces is in that results file and in the round-2 report.

None of the fixes below copies a dev sentence. Each class has its own test cases in `packages/resolver/src/precision.test.ts`.

## Classes and what was done

| # | Class | Round-3 fix | Status |
|---|---|---|---|
| 1 | A size or colour with no claim word is granted (3 of the 4 v2 harmful grants) | **Rules:** "variant only" now scores 0.75 and is routed; with no claim word at all, the LLM is also capped ("a size or colour with no claim word"). **LLM:** validation caps any claim/change whose comment has no claim word (below). Weak first-person words like "mera"/"mujhe" still count as a claim word for the LLM. | fixed on dev; costs recall: synthetic rules-only grant recall fell .812 → .644, all 40 lost grants were variant-only |
| 2 | The LLM turns a position word into a code ("last …"), 1 harmful | **Prompt:** "never work out a code from position or description words unless exactly one item fits; otherwise items []". **`validateLlmResult(raw, ctx, text)`:** keeps an LLM code only if the comment names it (a written code, a slot letter, or a title word only that item has), or if it is the on-screen item and the comment has no position word (last, previous, next, pichla, pehle, agla, dusra…). Otherwise the code is dropped and the claim goes to review with no item; the engine opens a "no-item" review for it. | fixed on dev |
| 3 | Single-letter slot codes not read | When every catalogue code is a single letter, a letter right after a claim word (or after another slot letter: "claim c and d") is a code. "a" and "i" also need nothing after them. Bare letters stay unread. | fixed on dev; recall only |
| 4 | One stand-in item carries every colour of the show, so a plain "book for me" cannot pick a variant | Left for MAIN (engine and data model). | open; 5 misses on dev-real3 with rules + cli |
| 5 | Colour words in an item's own title read as a variant ("48 green dino") | A colour that is in the item's title and is not one of its variants is description, not a variant request. | fixed on dev |
| 6 | Claims by description or price | Left alone: review is the safe outcome. | open; 4 misses on dev-real3 with rules + cli |
| 7 | Long or polite Hinglish claims capped at 0.75 ("words beside the cue") | Left alone: review is the safe outcome. | open; 2 misses on dev-real3 with rules only, 0 with rules + cli (the LLM grants both) |
| 8 | The LLM prompt never showed codes past its first 60 lines | `buildCatalogue` now always lists the on-screen item and every item a comment in the batch names, then fills to 60 in catalogue order. The heading no longer says "newest first". | fixed |
| 9 | LLM granted with no claim word ("test N", "yeah") | **Prompt:** "No claim word, no claim". **Validation:** a claim or change is capped at 0.75 unless the comment has a claim or change word, or is nothing but a code (a lone single-digit code does not count, matching the rules). | fixed |
| 10 | "question" is still the LLM's fallback | Not addressed this round. | open |

New rule: a claim the LLM cannot place keeps kind claim with no item, at ≤ 0.5. Before, it became question at 0.3. The engine routes a claim with no item to review.

## Gate result on the dev sets (round 3)

Harmful grants are 0, with rules only and with rules + claude-cli, on synthetic, real, dev-real2, dev-real2-claims and dev-real3. See `eval/results/2026-10-05T11-28-37.md` (36 claude-cli calls, batch 30).

| set | rules only: grants / harmful / recall | rules + cli: grants / harmful / recall |
|---|---|---|
| synthetic | 168 / 0 / .644 | 169 / 0 / .649 |
| real | 62 / 0 / .866 | 62 / 0 / .866 |
| dev-real2 | 7 / 0 / .350 | 7 / 0 / .350 |
| dev-real2-claims | 7 / 0 / .206 | 8 / 0 / .235 |
| dev-real3 | 26 / 0 / .543 | 29 / 0 / .609 |

Every grant on the dev sets sits at confidence 0.85 or above. The rules produce no grants between 0.80 and 0.85, so on these sets the 0.80 auto-accept line and a 0.85 line would accept the same rule grants.

## Held-out v3 (scored once after these gates passed)

Results are in `eval/results/2026-10-05T12-00-59.md`, and the failure patterns are in `eval/heldout-v3-failures.md`.

Held-out v3 had 3 harmful grants under rules only and under rules + claude-cli. All three were rule bare-code grants at 0.85 in one US show: two were number-game guesses and one was a likely typo, and each code differed from the item on screen.
