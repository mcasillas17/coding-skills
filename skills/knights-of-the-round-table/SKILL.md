---
name: knights-of-the-round-table
description: Use when the user asks for full implementation and pull-request delivery of a coding task in the current Git repository, validated by an independent panel of review agents. NOT for review-only requests with no implementation, work outside a Git repository, or a single invocation spanning multiple repositories.
license: MIT
compatibility: Requires Git, a configured push remote, GitHub (or equivalent) authentication, and a harness able to spawn or delegate to reviewer agents.
metadata:
  version: "0.1.0"
---

# Knights of the Round Table

## Overview

This skill implements a software task and its materially affected documentation
in one Git repository, then convenes an independent, read-only reviewer panel to
inspect the complete change. It fixes every accepted finding, re-reviews from
scratch, and repeats until the panel finds nothing actionable or the run is
blocked. Only a clean round permits final validation and an automatic pull request.

**Core principle:** convergence is proven by the structured reviewer contract and
`scripts/review-round.mjs`, never claimed from prose. A round only counts once every
required reviewer role has completed, and a pull request only opens once every round
is clean.

**Architecture / implementation:** The installed skill must remain self-contained.
The skill-local evaluator at `scripts/review-round.mjs` and the source-package root
wrapper at `../../scripts/review-round.mjs` are both required: installed copies
execute the skill-local evaluator, while repository tooling uses the root wrapper
to delegate to that same implementation.

## Preconditions

Before doing any work:

1. Load required process or domain skills for the task at hand (for example
   test-driven-development for code changes).
2. Resolve the target repository by running `git rev-parse --show-toplevel` from the
   agent's current working directory. Use that repository unless the invocation
   explicitly overrides it.
3. Accept the task only as an inline prompt or a readable local task file.
   Do not fetch the task from a URL, ticket system, or remote API — those are
   unsupported task sources.
4. Read applicable repository instruction files (for example `AGENTS.md`,
   `CLAUDE.md`, or `CONTRIBUTING.md`) before planning or editing anything.
5. Inspect the worktree. Preserve unrelated in-progress changes and isolate this
   task's work (a feature branch or worktree) when the harness and repository
   support it. Before the first commit, create or select a dedicated non-default
   task branch. Stop if unrelated changes cannot be safely isolated or that branch
   cannot be established.
6. Resolve skill-owned paths relative to the installed skill directory. Load its
   canonical `config/reviewers.yaml`, then merge an optional repo-root
   `.knights-of-the-round-table.yaml` override. The override may add roles or
   remap agents and fallbacks, but it must not remove or disable the six canonical
   roles. It must also pass the canonical schema validation. The override must not
   weaken any hard gate; after schema validation, the orchestrator separately
   enforces these invariants:
   `reviewerRetryCount` must remain `1`, `maxReviewRounds` must not exceed `10`,
   and the publication gate cannot be disabled. Reject an override that conflicts
   with those invariants.
7. Detect the current harness (Claude, Copilot, Codex, or Gemini) and select its
   adapter from `references/harness-adapters.md`. Before relying on a capability,
   confirm the current harness actually supports it. Only a missing
   reviewer-spawning capability may use the configured fallback. If a
   required validation, Git, or pull request capability is unavailable, stop and
   report it rather than treating a reviewer fallback as a substitute.

## Resolve the task

Normalize the inline prompt or local file into: objective, explicit requirements,
constraints, acceptance criteria, affected surfaces, and expected documentation
impact. If essential behavior is still ambiguous after inspecting the repository,
ask the user for clarification before editing any code.

## Implement

1. Inspect the relevant code, tests, and existing conventions.
2. Write a complete implementation that follows those conventions. Add or update
   tests whenever behavior changes — do not skip test-driven development for this
   step.
3. Run the smallest existing validation commands that cover the changed behavior.
4. Do not introduce new build, lint, or test tooling unless the task requires it.

## Review and repair loop

1. The canonical default panel has six roles: **correctness**, **tests**,
   **security**, **documentation**, **architecture**, and **performance**. After
   applying a valid override, run every role in the effective configuration
   independently and read-only. No reviewer may edit files, commit, push, or open
   a pull request.
2. Give every reviewer the normalized task, acceptance criteria, relevant
   repository instructions, current diff, relevant files, current validation
   output, and prior-round findings with their dispositions.
3. Every reviewer must return the exact JSON contract defined in
   `references/reviewer-contract.md`; the adapter must normalize that payload into
   the evaluator result envelope.
4. If a reviewer is unavailable or returns malformed output, retry it exactly once.
   If the retry also fails, make one configured fallback attempt using that role's
   configured `fallbackRole`: run the original role's prompt and contract through
   the fallback role's assigned agent, and report the result under the original
   required role name so `evaluateRound` sees it as coverage for that role — a
   fallback changes the executor, not the required role. If that fallback attempt
   also fails, or no `fallbackRole` is configured, or the configured `fallbackRole`
   is itself unavailable or malformed, then stop the run. Never silently reduce
   reviewer coverage: every role in the effective configuration must complete, and
   an unresolved role blocks the run rather than continuing shorthanded.
5. Evaluate every round with `scripts/review-round.mjs` (or its `evaluateRound`
   function). See `references/review-loop.md` for the full state machine, retry and
   fallback sequence, and deduplication rules.
6. Triage findings: merge duplicates, verify evidence, and accept only findings that
   improve requirement compliance, correctness, safety, maintainability,
   performance, tests, or documentation. Reject unsupported, contradictory, or
   purely stylistic findings. Every rejected finding must record concrete evidence
   or a stated reason — never a bare rejection.
7. Fix every accepted finding. After fixing any accepted finding, rerun every
   validation command affected by that change, then start an entirely new, full
   configured review round with every role in the effective configuration. Do not
   re-query only the reviewer that raised the finding — one accepted fix
   invalidates the whole round.
8. Repeat until the effective `maxReviewRounds`, which may be lower but must never
   exceed the hard maximum of 10 review rounds. If actionable findings remain when
   `round` reaches the effective limit — including round 10 — the run is blocked:
   stop immediately, do not touch documentation or open a pull request, and report
   the unresolved findings and blocking reviewers.
9. Time pressure, urgency, deadlines, or an already-long run never authorize
   skipping a retry, a fallback, a full round, or any other gate in this loop.
10. Reaching any particular round number, including round 10, never by itself
   authorizes publication. The round count is not evidence of correctness — only
   zero actionable findings across every required, completed role is.

## Documentation

Documentation updates are impact-based and mandatory whenever they are affected.
Use `references/documentation-and-pr.md` for the exact impact test across README
sections, usage and setup instructions, configuration or API references, examples,
architecture diagrams, and screenshots. Update only what the task materially
affects; do not perform unrelated documentation churn. Skipping a materially
affected document is not allowed.

Complete every materially affected documentation update **before** the round that
converges — a clean round must already reflect any documentation the code change
requires. Any code or documentation change after a clean round invalidates convergence
and requires rerunning the affected validation plus a full configured review round
with every role in the effective configuration before publishing.

## Publish

1. Run final validation after the last code or documentation change.
2. Do not open a pull request of any kind, including a draft pull request, unless
   every required reviewer role has completed — through its primary agent or a
   configured fallback — and no actionable findings remain.
3. Create focused commits and push the feature branch without force. Then
   automatically open the pull request using `assets/pr-body-template.md` (see
   `references/documentation-and-pr.md` for the exact body requirements).
4. Invoking this skill authorizes normal commits, a normal push, and opening the
   pull request for this task. Never force-push or rewrite shared history — that
   authorization never covers force.
5. Destructive actions, production changes, releases, purchases, or other
   separately sensitive operations still require the user's explicit, separate
   consent, even though normal commit, push, and PR creation are pre-authorized.

## Failure conditions

Stop and report the exact blocking condition and recovery step, preserving all
work, when any of the following occurs:

- no Git repository is found from the current working directory;
- the task source is not an inline prompt or a readable local file;
- essential task behavior remains ambiguous after inspection;
- conflicting repository instructions cannot be reconciled;
- unrelated working-tree changes cannot be safely isolated;
- a dedicated non-default task branch cannot be created or selected;
- the repository override fails schema validation or weakens a hard gate;
- the evaluator helper is unavailable;
- required validation fails;
- actionable findings remain at the effective `maxReviewRounds` (at most 10),
  which is a blocked run;
- a required reviewer role has no working primary agent or fallback;
- there is no configured push remote;
- Git authentication fails;
- the push fails;
- pull request creation fails.

Never present a partial or blocked run as successful.

## Completion report

Every run reports: target repository; branch; commits created; validation commands
and results; review rounds completed; findings accepted and fixed; findings
rejected with reasons; roles executed via fallback and the executing agent;
documentation changed; and the pull request URL. A blocked run additionally
reports every unresolved finding and the exact blocking condition.

## Quick reference

| Step | Rule |
| --- | --- |
| Repository | `git rev-parse --show-toplevel` from the current working directory |
| Task source | inline prompt or readable local file only |
| Config | canonical `reviewers.yaml` + optional repo-root `.knights-of-the-round-table.yaml` |
| Reviewers | correctness, tests, security, documentation, architecture, performance |
| Reviewer failure | retry once → one configured fallback attempt (`fallbackRole`) → stop |
| Round limit | effective `maxReviewRounds`, never above the hard maximum of 10; findings remaining at that round is blocked |
| Accepted fix | rerun affected validation + a full new review round |
| Rejected finding | requires recorded evidence or reason |
| Publish gate | every required review complete and no actionable findings remain |
| Git safety | commit/push/PR authorized; never force; sensitive actions need consent |

## Common mistakes / red flags

- Treating a high round number as proof of correctness — round count never
  authorizes publication.
- Re-reviewing with only the reviewer that raised an accepted finding instead of a
  full new round with every role in the effective configuration.
- Continuing with fewer reviewers after one fails instead of following the
  retry-then-fallback-then-stop sequence.
- Opening a draft pull request "just to save the review" before every required role
  has completed cleanly.
- Rejecting a finding without recording evidence or a stated reason.
- Skipping documentation updates that are materially affected by the change.
- Assuming time pressure or a long-running task justifies skipping a gate.
- Force-pushing or rewriting history to "clean up" commits before opening the PR.
- Treating normal commit/push/PR authorization as covering destructive, production,
  or otherwise sensitive actions — it does not.
