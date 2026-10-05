# Annotator agreement: dev-real3.jsonl (was heldout-v2.jsonl, held-out v2, burned 2026-10-05)

- Rows: 350, all labelled by A. B labelled 148 candidate rows blind to A.
- Kind agreement on those rows: 144/148; Cohen's kappa (6 kinds) 0.958; kappa (claim/change vs not) 0.956.
- Rows both called claim: 52; same item codes on 49.
- Disagreements (A / B): question / cancel x1, cancel / claim x1, claim / other x1, claim / question x1.
- Merged gold: claim 55, change 0, cancel 3, waitlist 0, question 64, other 228; disputed 4, disputed items 3.

Resolution rule (fixed before labels were read): same kind is kept, with items reduced to the codes both chose and disputed size/colour/qty set to null; different kinds where either says claim or change become a review-only claim (items [], tag disputed), so any grant on them is harmful; other different kinds keep A's kind, tagged disputed.

How the rows were chosen and labelled:
- Annotator A labelled all 350 rows of `eval/raw/dev-real3/to-label.jsonl`. Its labels are in `dev-real3.a.jsonl`.
- Annotator B was a separate agent and never saw A's labels. It labelled two sets of candidate rows; both are in `dev-real3.b.jsonl`:
  - 145 rows picked by a keyword regex before any labels existed (`to-label-b.jsonl`). The regex matches claim, cancel and change words in English, Hinglish and Devanagari, and rows made only of numbers or slot letters.
  - 3 rows A labelled claim, change, cancel or waitlist that the regex had missed (`to-label-b2.jsonl`).
- No resolver output was used to choose rows or to resolve disagreements.
- Both annotators followed `eval/raw/dev-real3/labelling-guide.md`.
