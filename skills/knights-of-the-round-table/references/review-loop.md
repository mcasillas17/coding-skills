# Review loop

The implementation review converges first, then useful affected documentation is
updated, then a final fresh full panel reviews the documented state. Keep one
monotonic round counter across both phases and never reset it.

There is no round cap by default: repeat until the full panel returns no
feedback. A cap exists only when the invoking user names one (`--max-rounds <n>`,
passed identically to every command) or the repository sets `maxReviewRounds`;
the invocation value wins. When the complete panel finishes round `n`, stop:
publish that exact reviewed state, listing every finding still flagged, even if
it was an implementation round and the final review never ran. Do not fix
findings after the last round; the PR must match the reviewed snapshot.

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
| `converged` | full current panel complete; no findings | 0 |
| `actionable` | feedback remains; no cap or below it | 2 |
| `incomplete` | configured reviewer missing, failed or skipped | 3 |
| `limit-reached` | full current panel complete at the user cap, not a clean final round; `actionable` lists what is still flagged (may be empty) | 4 |
| schema/config/snapshot error | invalid or stale records, or a round past the cap | 1 |

`publicationReady` is true for a converged `final` report and for `limit-reached`;
false otherwise. It is a machine gate, not proof of LLM execution, test success,
completed docs or permission to publish. The host must also verify those
workflow gates. No draft PR to bypass them.
