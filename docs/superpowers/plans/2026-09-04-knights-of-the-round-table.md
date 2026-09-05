# Knights of the Round Table — implementation milestone record

**Status: original implementation recipe superseded; reconciled 2026-09-05.**
This is a record of delivered components, not a task-by-task plan to execute
again. The original 2026-09-04 code samples and unchecked steps described an
earlier role-based design; the Git history retains them for historical reference.
Do not recreate its removed role prompts, fixtures or validation expectations.

The [current design](../specs/2026-09-04-cross-repository-implementation-skill-design.md),
[README](../../../README.md) and [architecture guide](../../architecture.md)
describe the current product. Runtime policy is in
[`SKILL.md`](../../../skills/knights-of-the-round-table/SKILL.md) and its references.

## Authoritative current workflow

One current Git root and inline/contained local task → safe task isolation and
observed host preflight → implementation and checks → one independent reviewer
per model, each covering all six areas → transparent triage and repair until the
full configured panel is clean → impact-based docs/README/diagrams/screenshots
when useful → fresh final documentation-inclusive panel → task-owned commit,
normal push and PR only after all gates pass.

Configuration v2 replaces selected harness panels and accepts a positive
safe-integer round cap (default 10), not an immutable reviewer floor or role cap.
The budget covers both phases. A clean final round at the inclusive cap can pass;
actionable/incomplete feedback at the cap blocks. Minimum 1 is accepted as data;
the complete workflow needs at least 2 rounds.

## Delivered milestones

“Delivered” describes repository artifacts, not live-model QA approval or remote
publication. Test files listed below are verification entry points, not an
assertion that every check ran in every environment.

| Original milestone | Current outcome and evidence |
| --- | --- |
| 1. Package and test foundation | **Implemented.** Node ESM, `VERSION`, MIT license, locked `yaml` dependency and built-in test runner. `tests/package.test.mjs` checks the npm command contract. No Node/npm engine minimum is declared. |
| 2. Reviewer configuration | **Implemented; original schema superseded.** Skill-local `config/reviewers.yaml`, dependency-free `scripts/validate-config.mjs` and `parse-yaml.mjs` define v2 panels and safe root overrides. Covered by `tests/core-v2.test.mjs`, `skill-config.test.mjs` and `validate-config.test.mjs`. |
| 3. Prompts and host definitions | **Implemented; area-role prompts replaced.** One `reviewers/whole-panel.md` feeds model-specific read-only definitions for Claude, Copilot, Codex and Gemini. `scripts/render-agents.mjs` owns generated outputs and synchronizes the Claude manifest file list. `tests/render-agents.test.mjs` covers rendering and ownership. |
| 4. Deterministic round evaluation | **Implemented; original self-declared panel contract replaced.** Skill-local `review-round.mjs`, `snapshot.mjs` and `harness.mjs` bind reports to independent config/current content, actual execution identity and full coverage. `tests/runtime-v2.test.mjs` and `review-round.test.mjs` cover current behavior. |
| 5. Canonical workflow and references | **Implemented.** `SKILL.md`, five focused references, whole-panel prompt and `assets/pr-body-template.md` document the two-phase workflow. `tests/skill-contract.test.mjs` checks important prose contracts; it does not prove agents obeyed them in live execution. |
| 6. Cross-harness installer | **Implemented.** `scripts/install.mjs` installs selected skills, preserves executable bits and protects unowned files. Knights companions are installed with the skill. Codex/Gemini share a skill copy and previously installed siblings update together. `tests/install.test.mjs` covers isolated-home installation/update and failure behavior. |
| 7. Manifests and distribution validation | **Implemented with explicit boundaries.** Claude explicit-file agents, Copilot directory agents and Codex skills-only plugin plus standalone companions. `scripts/validate.mjs` and `tests/repository-validation.test.mjs` check discovery and drift. Native Antigravity is unsupported. |
| 8. Installation, workflow and architecture docs | **Documented in this reconciliation.** Root README presents `coding-skills` as a growing collection and explains install/update/invoke/config/contribution. Architecture includes Mermaid data flow and feedback loop. No screenshot is needed for the terminal-only workflow. |
| 9. Package verification and handoff | **Ongoing release gate, not a historical approval.** Use current commands below. Native tests have explicit skip boundaries; live provider access, independent multi-model execution and remote delivery are not established by static/unit tests. |

## Changes that superseded the original recipe

- `7b29eb7` introduced the whole-panel core and native adapter gates, replacing
  role-based review policy with explicit model panels and runtime evidence.
- `075a284` corrected the inclusive cap: a complete clean final round at the cap
  may pass; a clean implementation round still needs its separate final round.
- `ea35996` synchronized the Claude explicit agent list with rendered models and
  handled tracked-file replacement snapshots.
- This documentation reconciliation replaces obsolete installation instructions,
  hard-coded agent counts and uncreated test-file recipes with actual current
  source paths and support boundaries.

Source-of-truth agent edits go through the skill config/prompt and
`npm run render`, never direct edits of generated definitions. Root package and
plugin identities remain unchanged; the collection can grow without a cosmetic
rename. A generic skill can omit reviewer config, but its installer metadata
still needs a string `metadata.version`.

## Current verification entry points

From the source checkout:

```sh
npm ci
npm run validate
npm run render -- --check
node --test tests/skill-contract.test.mjs tests/skill-config.test.mjs tests/runtime-v2.test.mjs
node --test tests/native-host.test.mjs
```

`npm run check` is the complete package gate: validator, render drift check and
`npm test`. Run it for release/runtime changes. For prose-only changes, run
relevant existing contracts, verify links and examples, and inspect the diff;
do not cite obsolete fixed test/agent counts from the original plan.

An isolated installer check, when relevant, uses a new temporary home:

```sh
test_home="$(mktemp -d)"
node scripts/install.mjs --skill knights-of-the-round-table --harness all --home "$test_home"
```

Do not install globally, request paid inference, or create remote PRs just to
validate documentation. The
[harness reference](../../../skills/knights-of-the-round-table/references/harness-adapters.md)
separates native no-inference Claude/Copilot/Gemini checks and recorded Codex
source/config parsing from account-specific model access.

## Handoff boundary

This milestone record does not authorize publication, claim independent review,
or mark an end-to-end model run complete. A delivery run must still satisfy the
current final publication gate and any explicit user restrictions. Preserve
unrelated work, report verification commands/results and remaining blockers,
and do not merge.
