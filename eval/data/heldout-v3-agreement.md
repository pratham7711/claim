# Annotator agreement: heldout-v3.jsonl

- Rows: 350, all labelled by A. B labelled 151 candidate rows blind to A.
- Kind agreement on those rows: 150/151; Cohen's kappa (6 kinds) 0.989; kappa (claim/change vs not) 0.985.
- Rows both called claim: 51; same item codes on 50.
- Disagreements (A / B): claim / other x1.
- Merged gold: claim 52, change 1, cancel 2, waitlist 0, question 77, other 218; disputed 1, disputed items 1.

Resolution rule (fixed before labels were read): same kind is kept, with items reduced to the codes both chose and disputed size/colour/qty set to null; different kinds where either says claim or change become a review-only claim (items [], tag disputed), so any grant on them is harmful; other different kinds keep A's kind, tagged disputed.

How the rows were chosen and labelled:
- Annotator A labelled all 350 rows of `eval/raw/heldout-v3/to-label.jsonl`; its labels are in `heldout-v3.a.jsonl`.
- Annotator B, a separate agent that never saw A's labels, labelled two sets of rows, both now in `heldout-v3.b.jsonl`:
  - 133 rows picked by a keyword regex before any labels existed (`to-label-b.jsonl`). This is the round-2 regex, with bare letters widened from A–J to A–Z.
  - 18 rows A labelled claim, change, cancel or waitlist that the regex had missed (`to-label-b2.jsonl`).
- No resolver output was used to pick rows or to settle disagreements.
- Both annotators followed `eval/raw/heldout-v3/labelling-guide.md`.
- The resolution rule is the one in `eval/merge-labels.ts`, unchanged since round 2.
