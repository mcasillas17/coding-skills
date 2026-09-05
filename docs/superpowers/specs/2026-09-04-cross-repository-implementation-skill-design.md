# Cross-Repository Implementation Skill Design

## Summary

Create a portable implementation skill that can run from Claude, GitHub Copilot,
Codex, and Gemini/Antigravity. The skill implements a task in the Git repository
containing the agent's current working directory, asks a configured panel of
independent reviewer agents to inspect the work, fixes their actionable findings,
and repeats until the work converges or reaches a ten-round safety limit.

After convergence, the skill updates impacted documentation and automatically
creates a pull request.

## Goals

- Accept task context as an inline prompt or a local file.
- Operate on one repository per invocation.
- Use the repository containing the agent's current working directory by default.
- Share one workflow and policy across supported agent harnesses.
- Use harness-specific adapters only where agent and tool invocation differs.
- Run independent correctness, tests, security, documentation, architecture, and
  performance reviews.
- Fix all accepted actionable findings and repeat review until none remain.
- Stop after ten review rounds rather than loop indefinitely.
- Update only documentation affected by the implementation.
- Automatically commit, push, and open a pull request after successful convergence.
- Produce an auditable completion report.

## Non-Goals

- Coordinating one task across multiple repositories in a single invocation.
- Requiring every harness to expose identical agent or tool APIs.
- Applying every reviewer suggestion without evidence or triage.
- Updating unrelated documentation or creating screenshots and diagrams by default.
- Force-pushing, rewriting history, suppressing checks, or performing production
  changes without any separately required approval.

## Architecture

### Canonical Core

The repository will contain one harness-neutral workflow that defines all shared
invariants:

1. Resolve the target repository from the current working directory.
2. Load and normalize the task context.
3. Read repository-specific instructions and conventions.
4. Implement and validate the task.
5. Run the configured reviewer panel.
6. Triage and fix actionable findings.
7. Repeat review and repair until convergence or the round limit.
8. Update impacted documentation.
9. Commit, push, and create a pull request.

The canonical core is the source of truth for reviewer semantics, convergence,
failure handling, documentation policy, and reporting.

### Harness Adapters

Thin adapters will support:

- Claude
- GitHub Copilot
- Codex
- Gemini/Antigravity

Each adapter translates the canonical operations into the capabilities available
in its harness:

- spawning a reviewer agent;
- passing task, diff, source, and validation context;
- collecting structured findings;
- running repository commands;
- capturing screenshots when warranted;
- interacting with Git;
- creating a pull request.

Adapters must not redefine workflow policy. If a harness cannot perform a required
operation, its adapter must report that limitation explicitly rather than silently
skipping the operation.

### Reviewer Registry

A versioned reviewer registry will define:

- reviewer role;
- purpose and review boundaries;
- expected structured output;
- primary agent mapping per harness;
- fallback agent or fallback role per harness;
- retry behavior;
- default enablement.

The default panel contains:

- correctness;
- tests;
- security;
- documentation;
- architecture;
- performance.

Repository-local configuration can add, remove, or remap roles.

## Configuration

Configuration is declarative and schema-validated. Values are layered in this
order, with later layers overriding earlier ones:

1. Canonical defaults.
2. Harness adapter defaults.
3. Repository-local configuration.
4. Explicit invocation options.

The default configuration includes:

- the six default reviewer roles;
- a maximum of ten review rounds;
- role-specific fallback mappings;
- actionable-finding convergence rules;
- impact-based documentation updates;
- one retry before falling back after a reviewer execution failure.

Configuration validation must reject:

- unknown keys;
- duplicate reviewer roles;
- invalid agent mappings;
- circular or impossible fallback chains;
- invalid round limits;
- unsupported task sources.

## Task Resolution

The first version accepts:

- an inline task prompt;
- a path to a local task file.

The task is normalized into:

- objective;
- explicit requirements;
- constraints;
- acceptance criteria;
- affected surfaces;
- expected documentation impact.

If essential behavior remains ambiguous after repository inspection, the skill
must ask for clarification before editing code.

## Execution Flow

### 1. Initialize

- Verify that the current working directory is inside a Git repository.
- Treat that repository as the target unless an explicit repository override is
  provided.
- Read applicable repository instruction files.
- Detect the default branch and configured remotes.
- Inspect worktree state without discarding or overwriting unrelated changes.
- Create an isolated feature branch or worktree when the harness and repository
  support it.
- Stop if existing changes cannot be safely isolated.

### 2. Implement

- Inspect the relevant code and prior patterns.
- Create a complete implementation that follows repository conventions.
- Add or update tests when behavior changes.
- Run the smallest existing validation commands that cover the changed behavior.
- Do not introduce new build, lint, or test tooling unless the task requires it.

### 3. Review

Run all configured reviewer roles independently. Each reviewer receives:

- normalized task context;
- acceptance criteria;
- repository instructions relevant to the change;
- current diff;
- relevant files;
- validation output;
- findings from prior rounds and their dispositions when applicable.

Reviewers are read-only and return structured findings containing:

- stable finding ID;
- reviewer role;
- title;
- severity;
- confidence;
- file and line evidence;
- explanation;
- actionable recommendation;
- status.

### 4. Triage and Repair

The implementation agent:

- merges duplicate findings;
- verifies evidence;
- accepts actionable findings that improve requirement compliance, correctness,
  safety, maintainability, performance, tests, or documentation;
- rejects unsupported, duplicate, contradictory, or purely stylistic findings;
- records a reason for every rejection;
- fixes every accepted finding;
- reruns checks affected by the fixes.

### 5. Converge

Review rounds continue against the updated implementation until every completed
reviewer returns no actionable findings.

The workflow stops after ten rounds. If actionable findings remain at that point,
the run fails closed, does not create a pull request, and reports the unresolved
findings.

A review round does not count as converged if a required reviewer neither completes
nor reaches an available fallback.

## Reviewer Failure and Fallback

If a configured reviewer is unavailable:

1. Use the configured fallback agent for the same role.
2. If that mapping is unavailable, use the configured fallback role.
3. If no fallback can satisfy the review contract, stop the run.

If a reviewer crashes or returns malformed output, retry it once before using the
fallback chain.

The skill must never silently reduce the configured review coverage.

## Documentation

Documentation updates are impact-based.

The documentation reviewer identifies affected:

- README sections;
- setup and usage instructions;
- API or configuration references;
- examples;
- architecture and flow diagrams;
- screenshots and user-facing walkthroughs.

The implementation agent updates only affected documentation. It updates or creates
diagrams when architecture, control flow, or integration boundaries materially
change. It captures screenshots only when:

- a user-facing workflow materially changed; and
- the repository already uses screenshots, or written instructions would otherwise
  be unclear.

Screenshot and diagram assets use stable repository paths and include appropriate
alt text or captions.

## Pull Request Creation

After convergence, documentation updates, and final validation, the skill:

1. Creates focused commits.
2. Pushes the feature branch without force.
3. Automatically opens a pull request.

The pull request body includes:

- task summary;
- implementation summary;
- validation performed and results;
- review roles and number of rounds;
- accepted and fixed findings;
- intentionally rejected findings and reasons;
- documentation changes;
- relevant screenshots or diagrams.

Invoking the skill authorizes normal commit, push, and pull request creation for the
task. Destructive actions, production changes, releases, purchases, or other
separately sensitive operations still require explicit approval.

## Failure Handling

The workflow fails closed when it encounters:

- no Git repository;
- unresolved task ambiguity;
- conflicting repository instructions;
- unsafe interaction with unrelated working-tree changes;
- failing required validation;
- unresolved actionable feedback after ten rounds;
- unavailable reviewers with no valid fallback;
- missing push remote;
- authentication failure;
- push failure;
- pull request creation failure.

Failures must preserve the work and report the exact blocking condition and recovery
step. The skill must not present a partial run as successful.

## Completion Report

Every run reports:

- target repository;
- branch;
- commits created;
- validation commands and results;
- review rounds completed;
- findings accepted and fixed;
- findings rejected with reasons;
- documentation changed;
- pull request URL.

Failed runs additionally report unresolved findings and the blocking condition.

## Testing Strategy

### Core Scenario Tests

Fixture repositories will cover:

- inline task input;
- local-file task input;
- clean first-round convergence;
- findings fixed over multiple rounds;
- duplicate findings;
- contradictory findings;
- reviewer fallback;
- reviewer retry and failure;
- malformed reviewer output;
- ten-round limit;
- dirty working tree;
- failing validation;
- documentation-only impact;
- diagram update triggers;
- screenshot triggers;
- missing remote;
- missing authentication;
- successful pull request preparation.

### Adapter Contract Tests

Each harness adapter must prove that it can:

- launch or delegate to a reviewer;
- preserve role-specific prompts;
- return the canonical finding schema;
- distinguish reviewer failure from zero findings;
- run validation commands;
- expose Git and pull request operation results;
- report unsupported capabilities explicitly.

### Pull Request Tests

Default automated tests use a mocked or dry-run publication boundary. A separate
opt-in integration test may create a pull request in a disposable repository.

## Success Criteria

The skill is complete when:

- the same canonical workflow is usable through all four harness adapters;
- a run defaults to the Git repository containing the current working directory;
- inline and local-file tasks are supported;
- all six default reviewer roles run with validated fallbacks;
- accepted findings are fixed and re-reviewed;
- convergence cannot be claimed while actionable findings or incomplete required
  reviews remain;
- the ten-round cap prevents infinite loops;
- impacted documentation is updated without unrelated churn;
- successful runs automatically open pull requests;
- failures preserve work and clearly explain the blocker;
- automated scenario and adapter contract tests pass.
