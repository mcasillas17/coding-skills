# Review loop

The implementation review converges first, then useful affected documentation is
updated, then a final fresh full panel reviews the documented state. Keep one
monotonic round counter across both phases. Default budget is 10; use the positive
safe-integer repository-configured cap. At the cap the workflow is blocked,
including a clean final report: reserve budget for final review, never reset it.

Each round runs ONE independent reviewer per configured primary model. Every
reviewer examines all six dimensions, not a slice of the change. Capture the
current snapshot and config digest before dispatch; reload config and recompute
the snapshot when evaluating. Results from earlier snapshots are stale even if
HEAD did not move. Any changed code, docs, index or untracked task artifact
requires fresh review.

## Failed reviewer

1. Retry the same requested reviewer/model once.
2. If still unavailable, failed or malformed, attempt its explicit fallback once.
3. Record `execution.id`, `execution.model`, fallback `reason`, original
   `requestedModel`, original reviewer slot, full coverage and current snapshot.
4. No configured fallback, unavailable fallback, malformed fallback or missing
   capability blocks. Never silently reduce the full configured panel or report
   the fallback as if the requested model had run.

Preflight can select an explicitly configured fallback when current inventory
already establishes primary unavailability; do not make paid requests merely to
repeat an access error. Unexpected execution failures use the bounded retry
sequence. The host attests these attempts; the evaluator validates records only.

## Findings and triage

The machine identity is `(file, line, id, title)`, never generic ID alone.
Different locations or different defect titles remain distinct. Matching reports
combine deterministically using highest severity, then confidence, then reviewer
ID; **all evidence and provenance** remain in `reports`. Explicit operator triage
may associate other true duplicates, but cannot erase source reports.

Validate every finding; fix actionable feedback. Rejections need concrete
evidence or reason. Preserve dispositions outside the review surface and give
them to the next full panel. All open reported findings remain actionable to the
evaluator; it has no "accept my rejection and publish" escape hatch. A fresh full
panel must independently return no actionable feedback.

## Evaluator states

| State | Meaning | Exit |
| --- | --- | --- |
| `converged` | full current panel complete; no findings; below cap | 0 |
| `actionable` | feedback remains below cap | 2 |
| `incomplete` | configured reviewer missing, failed or skipped | 3 |
| `limit-reached` | at configured cap, even if no findings | 3 |
| schema/config/snapshot error | invalid or stale records; cannot evaluate | 1 |

`publicationReady` is false for implementation rounds and every blocked state.
It is true only for a converged `final` report. It is a machine gate, not proof of
LLM execution, test success, completed docs or permission to publish. The host
must also verify those workflow gates. No draft PR to bypass them.
