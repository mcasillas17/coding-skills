# Reviewer Contract

The generated reviewer prompts and `scripts/review-round.mjs` sit on opposite
sides of an adapter boundary. JSON object key order is not significant and is not
validated; field names, types, and allowed values are.

## Raw reviewer payload

Each successful reviewer invocation returns the shape already required by the
generated reviewer prompts:

```json
{
  "reviewer": "correctness",
  "findings": []
}
```

The raw reviewer payload has no result-level `status`. The harness adapter
validates it and preserves the `findings` array without summarizing or fabricating
content, then adds `status: "completed"` while normalizing it into the evaluator
result envelope below. For a primary invocation, the raw `reviewer` must match the
required role. For a fallback invocation, the raw `reviewer` is advisory and the
adapter must discard that label after validating the payload. Set the envelope's
`reviewer` to the original required role so the evaluator credits the correct
coverage. Derive executor identity from the configured `fallbackRole` and current
harness mapping, then record that fallback executor separately in the completion
report. If invocation fails or is deliberately skipped, the adapter creates a
`failed` or `skipped` envelope instead; it must not manufacture an empty
successful review.

## Reviewer input

Every independent reviewer receives the same complete review package:

- normalized task context and acceptance criteria;
- relevant repository instructions;
- the current diff and relevant files;
- current validation output;
- prior-round findings and their recorded dispositions, when applicable.

The adapter must pass this context without granting write access. Omitting part of
the package is incomplete review coverage, not a reason to infer a clean result.

## Evaluator result envelope

```json
{
  "reviewer": "correctness",
  "status": "completed",
  "findings": []
}
```

- `reviewer` — the configured role name (for example `correctness`, `tests`,
  `security`, `documentation`, `architecture`, `performance`).
- `status` — one of `completed`, `failed`, or `skipped`. This is the **result**
  status (did the reviewer run successfully?), which is a different concept from a
  finding's own status.
  - `completed` — the reviewer ran and `findings` is present (an array, possibly
    empty).
  - `failed` — the reviewer crashed, timed out, or returned malformed output; this
    triggers the retry/fallback sequence in `references/review-loop.md`.
  - `skipped` — the reviewer was intentionally not run for this round.
- `findings` — required and must be an array when `status` is `completed`. A
  `failed` or `skipped` result may omit `findings` entirely, or include a valid
  array of findings; either shape validates. A non-completed result's findings,
  if present, are not actionable — the role remains incomplete regardless of
  their content, because `evaluateRound` only draws actionable findings from
  results with `status: completed`.

Round evaluation does not require input JSON key order — it validates keys and
values by name, not by position.

## Round document

Pass the normalized evaluator envelopes to `evaluateRound` in this top-level
shape:

```json
{
  "round": 1,
  "maxRounds": 10,
  "requiredReviewers": ["correctness", "tests"],
  "results": [
    {
      "reviewer": "correctness",
      "status": "completed",
      "findings": []
    },
    {
      "reviewer": "tests",
      "status": "completed",
      "findings": []
    }
  ]
}
```

- `round` and `maxRounds` are positive integers, and `round` must not exceed
  `maxRounds`.
- `requiredReviewers` is a non-empty array of unique configured role names.
- `results` is an array with at most one result per required role.
- An unknown top-level key is a hard error.
- A duplicate result for one reviewer is a hard error.
- A result whose `reviewer` is not listed in `requiredReviewers` is a hard error.

The CLI exits with exit code `0` for `converged`, exit code `2` for `actionable`,
and exit code `3` for `incomplete`, `limit-reached`, or invalid input.

## Finding schema

Each entry in `findings` is a raw finding with exactly these fields. The table and
example show the canonical output order used by `evaluateRound`:

| Field | Type | Constraint |
| --- | --- | --- |
| `id` | string | non-empty, stable across rounds and across reviewer roles for the same underlying issue |
| `severity` | string | one of the four severity levels below |
| `confidence` | integer | an integer from 1 through 10 |
| `file` | string | non-empty relative path |
| `line` | integer | positive integer |
| `title` | string | non-empty short summary |
| `evidence` | string | non-empty concrete evidence from the task, diff, files, or check output |
| `recommendation` | string | non-empty, specific, actionable fix |
| `status` | string | must always be `open` — see "Raw status vs. disposition" below |

`severity` must be one of `critical | high | medium | low`, listed here from most
to least urgent.

Finding IDs must be unique within one reviewer's `findings` array. Reusing the
same ID in a single result is a hard error; matching IDs from different completed
reviewers are cross-role duplicates and are merged.

```json
{
  "id": "finding:stable-slug",
  "severity": "critical",
  "confidence": 8,
  "file": "relative/path.ts",
  "line": 42,
  "title": "Short finding",
  "evidence": "Concrete evidence",
  "recommendation": "Specific actionable fix",
  "status": "open"
}
```

## Raw status vs. disposition

A raw finding's `status` field is always `open`: reviewers report issues, they do
not resolve them, so this schema has no `accepted`, `fixed`, `rejected`, or
`duplicate` value for `status`. Those four values are **orchestration
dispositions** — decisions the implementer records during triage, tracked
separately from the raw contract (for example in the completion report), never
written back into a finding's `status` field. See `references/review-loop.md` for
how `accepted`, `fixed`, `rejected`, and `duplicate` are assigned and enforced.

## What the round evaluator adds

`evaluateRound` adds `reportedBy` to every actionable finding. For a unique finding
it contains one reviewer; for duplicate findings — the same `id` reported by more
than one completed reviewer — it names every reviewer that raised the merged
entry:

```json
{
  "id": "finding:stable-slug",
  "severity": "critical",
  "confidence": 8,
  "file": "relative/path.ts",
  "line": 42,
  "title": "Short finding",
  "evidence": "Concrete evidence",
  "recommendation": "Specific actionable fix",
  "status": "open",
  "reportedBy": ["architecture", "correctness"]
}
```

`evaluateRound` then classifies the whole round as `converged`, `actionable`,
`incomplete`, or `limit-reached` (see `references/review-loop.md`) based on which
required reviewers completed and whether any actionable findings remain.

## Constraints for every reviewer

- Review only. Never edit files, commit, push, or open a pull request.
- Report evidence-backed actionable findings only.
- Never report a bare style preference unless it violates an explicit repository
  rule.
- Return JSON only — no prose outside the structure above.
