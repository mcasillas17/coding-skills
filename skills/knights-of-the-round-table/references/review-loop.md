# Review Loop

This reference defines the exact state machine used to decide whether a review
round is done, and the retry, fallback, deduplication, and repair rules that
surround it. `scripts/review-round.mjs` implements `evaluateRound(round)`, which is
the single source of truth for these states — never infer convergence from prose.
The orchestrator must construct each round document from the validated effective
configuration: `maxRounds` equals `maxReviewRounds`, and `requiredReviewers`
contains exactly every effective reviewer role. Treat any mismatch as a hard
orchestration error before calling the evaluator.

## Round states

`evaluateRound` returns one of exactly four states:

| State | Meaning |
| --- | --- |
| `incomplete` | One or more required reviewer roles did not complete this round (no result, or a result with status other than `completed`). The round proves nothing until every required role is `completed`. |
| `actionable` | Every required role completed and at least one actionable finding remains, and `round < maxRounds`. Fix the findings and start a new round. |
| `limit-reached` | Every required role completed, at least one actionable finding remains, and `round >= maxRounds` reaches the effective limit (never above 10). This is a **blocked** run: stop, do not touch documentation, and do not open a pull request. |
| `converged` | Every required role completed and zero actionable findings remain. Required documentation must already be present; only this state permits final validation and publishing. |

## Reviewer retry and fallback sequence

For each configured reviewer role, in order:

1. Run the role's primary agent for the current harness.
2. If it is unavailable, times out, or returns malformed output, **retry it exactly
   once**.
3. If the retry also fails, make **one configured fallback attempt** using that
   role's configured `fallbackRole` (for example `tests` falls back to
   `correctness`): run the original role's prompt and contract through the
   fallback role's assigned agent, and report the result under the original
   required role name so `evaluateRound` sees it as coverage for that role — a
   fallback changes the executor, not the required role.
4. If that fallback attempt also fails, or no `fallbackRole` is configured, or the
   configured `fallbackRole` is itself null, unavailable, or malformed, then stop
   the run. Never silently reduce reviewer coverage by continuing with fewer roles
   than are configured — an unresolved role makes the round `incomplete`, not
   converged.

Never continue, proceed, or publish with reduced reviewer coverage, known coverage
gaps, or any required reviewer remaining incomplete.

## Deduplication and `reportedBy`

Multiple reviewers may report the same underlying issue. `evaluateRound` groups
findings by their stable `id` across all completed reviewers in the round and
merges duplicates into one actionable entry, recording every reviewer that raised
it in a `reportedBy` array (sorted lexically). This is why finding IDs must be
stable across roles for the same issue: the round evaluator uses `id` alone to
detect a duplicate, not free-text similarity.

Finding IDs must be unique within a single reviewer's `findings` array; a repeated
ID from one reviewer is a hard contract error, not a duplicate to merge. When
different reviewers use the same ID, the merged finding keeps the report with the
highest severity, then the highest confidence, then the lexically first reviewer
name. `reportedBy` still lists every reporting role.

## Raw status versus orchestration disposition

The reviewer contract's `status` field is always `open` — reviewers only ever
report open findings; they never resolve their own findings. Resolution is a
separate, implementer-owned concept called a **disposition**, tracked outside the
raw JSON contract (for example in the completion report), with exactly these
values:

- `accepted` — the implementer verified the finding and will fix it;
- `fixed` — an accepted finding's fix has been applied and validated;
- `rejected` — the implementer determined the finding is unsupported, duplicate,
  contradictory, or purely stylistic, with recorded evidence or a stated reason;
- `duplicate` — the finding was merged into another finding's `id` via
  `reportedBy` rather than tracked separately.

Never write a disposition value into the raw `status` field; the schema in
`references/reviewer-contract.md` only accepts `open` there.

## Repair: full round after every accepted fix

Every accepted finding, once fixed, must:

1. Trigger a rerun of every affected validation command.
2. Trigger an entirely new, full round — every configured reviewer role runs
   again from scratch against the updated implementation.

Do not re-query only the reviewer that raised the fixed finding. A partial
re-review — asking one role to confirm a fix while skipping other configured
roles — never counts as a completed round and can hide new findings the fix
introduced elsewhere.

Any code or documentation change made after a `converged` result invalidates that
result. Rerun affected validation and start another full configured round before
publishing.

## The ten-round limit

Round numbers start at 1. Stop at the effective `maxReviewRounds`, which may be
lower but must never exceed the hard **maximum of 10 review rounds**. If
`evaluateRound` returns `limit-reached`, the run is **blocked**: report every
unresolved actionable finding and the reviewers that raised them, and stop
without creating a pull request. Reaching round 10 — or any round — is never
itself evidence of correctness; only a `converged` result is.
