# Documentation and Pull Request Requirements

## Impact-based documentation

Documentation updates follow one rule: update only what the change materially
affects, and never skip an update that is materially affected. Apply this impact
test to each surface before publishing:

| Surface | Update it when |
| --- | --- |
| README sections | the change adds, removes, or alters a documented feature, command, or behavior described there |
| Setup and usage instructions | installation, configuration, or day-to-day usage steps changed |
| Configuration or API references | a config key, schema, endpoint, or public function signature changed |
| Examples | an existing example would now be misleading, or a new capability needs one to be discoverable |
| Architecture or flow diagrams | control flow, integration boundaries, or component responsibilities materially changed |
| Screenshots and user-facing walkthroughs | a user-facing workflow materially changed, and the repository already uses screenshots, or written instructions alone would be unclear |

Update diagrams and screenshots only when material — do not add or refresh either
one for changes that are internal, non-visual, or already clear from written
instructions. Screenshot and diagram assets use stable repository paths and
include alt text or captions.

## Final pull request gates

Never publish or open any pull request, including a draft pull request, before
convergence.

Do not open a pull request of any kind — including a draft pull request — until
all of the following hold:

1. Every configured model reviewer has independently covered all six dimensions, through its primary agent or a
   configured fallback (see `references/review-loop.md`).
2. No actionable findings remain (`evaluateRound` reports `converged` and
   `publicationReady: true` for a current final-phase snapshot below the cap).
3. Final validation has been run against the last code or documentation change and
   passed.
4. Impact-based documentation updates required by this change are already made.

## Sequence

1. Converge implementation review, then update materially affected documentation.
2. Run final validation and a final fresh full-model-panel review of the documented
   state. Keep the same round budget; incomplete or capped runs never publish.
3. Re-evaluate the current state before staging only task-owned changes. Create
   focused commits describing the change; verify hooks did not change the content.
4. Push the feature branch without force.
5. Automatically open the pull request using the body built from
   `assets/pr-body-template.md`.

## Pull request body requirements

The rendered body, based on `assets/pr-body-template.md`, must include:

- a task and implementation summary;
- validation performed and its results;
- the number of review rounds completed, requested models and actual invocation
  identities/models, including fallback reasons and coverage;
- every accepted and fixed finding;
- every intentionally rejected finding with its recorded evidence or reason;
- documentation changed, including any diagrams or screenshots;
- the pull request must never be opened as a substitute for finishing an
  incomplete round — an incomplete or blocked run has no pull request at all.
