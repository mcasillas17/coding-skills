# Knights of the Round Table — current design

**Status:** reconciled with schema v2 on 2026-09-05. This replaces the original
2026-09-04 design at this historical path. “Cross-repository” means the skill is
reusable in different repositories, **not** that one invocation spans them.
The implemented workflow lives in
[`SKILL.md`](../../../skills/knights-of-the-round-table/SKILL.md); the
[README](../../../README.md) covers installation and
[architecture guide](../../architecture.md) explains data flow.

## Authoritative current requirements

1. Operate on the Git root containing the current working directory, one
   repository per invocation. Accept inline task text or a contained local task
   file, not a URL, outside path, symlink escape or submodule-spanning task.
2. Read applicable repository instructions, normalize requirements and acceptance
   criteria, preserve existing dirty work and isolate task-owned changes on a
   dedicated non-default branch.
3. Before implementation, validate repository configuration and current
   host/operator observations of reviewer discovery, model selection/access,
   independence and read-only controls. Missing capabilities block.
4. Implement incrementally and run affected checks using the repository's
   architecture and tooling.
5. Dispatch one independent reviewer per configured primary model. **Every**
   reviewer covers correctness, tests, security, documentation, architecture and
   performance over the complete review surface.
6. Merge findings transparently, preserve evidence/provenance, fix actionable
   findings and record evidence for rejections and duplicate associations.
   Rerun affected checks and the full panel on a fresh snapshot after changes.
7. After implementation convergence, update impacted README/docs/diagrams and
   screenshots when useful. Do not leave affected instructions misleading.
8. Run fresh checks and a separate **final documentation-inclusive full-panel
   review**, even if no documentation edits were required. Repair and repeat
   within the same budget.
9. Only a current clean final panel, completed documentation and passing checks
   permit task-owned commit, normal push and automatic PR creation, unless the
   user restricts delivery. Re-evaluate before staging and check that commit
   hooks did not change reviewed content before pushing.

## Canonical core and host adapters

Keep one canonical skill, shared whole-panel prompt, declarative model panels
and strict result contract. The dependency-free skill-local runtime validates
config, resolves identities/preflight, captures snapshots and evaluates rounds.
The host executes the workflow; the helper does not launch models or publish.

Implementers, including delegated repair agents, must load the separately
installed `ponytail` skill and applicable Superpowers stages. Reviewers,
including fallbacks and final rounds, must load `ponytail-review` as an additive
complexity pass, retaining all six dimensions and the JSON result contract.
Resolve dependencies through the host registry/loader or readable installed
skill files in each agent context. Missing dependencies block; no silent
installation, copied skill implementations or claimed parent-to-child activation.
The runtime inventory validator does not establish skill-loading evidence.

Generate read-only native reviewer definitions from source config and prompts.
The source renderer synchronizes the Claude manifest's explicit Markdown file
list. Copilot exposes its generated agent directory. Claude/Copilot plugin
dispatch uses the discovered plugin namespace; standalone dispatch uses bare IDs.
Codex uses bare companion roles, and Gemini CLI uses bare standalone agents.

Codex plugin installation exposes skills but **does not register reviewer roles**.
Its standalone companion installation is required. Native Antigravity is
**unsupported**; Gemini CLI is not a verified adapter for it.

## Configuration v2

The canonical defaults are in
[`config/reviewers.yaml`](../../../skills/knights-of-the-round-table/config/reviewers.yaml).
They request:

| Harness | Primary models/aliases |
| --- | --- |
| Copilot | `grok-4.6`, `gemini-3.8-flash`, `gpt-6-astra`, `claude-opus-4.8` |
| Claude | `claude-opus-5`, `sonnet`, `haiku` |
| Codex | `gpt-5.6-sol`, `gpt-5.6-terra` |
| Gemini CLI | `gemini-3.7-flash`, `gemini-3.1-pro` |

These are configured requests, not provider-availability promises.
`.knights-of-the-round-table.yaml` at the target repository root optionally
replaces `maxReviewRounds` and selected `panels.<harness>` arrays. Each supplied
array replaces that harness's whole panel; omitted harnesses retain defaults.
Panels must remain nonempty with unique primary IDs and models. Additions,
removals and remapping are allowed; whole-panel coverage cannot be weakened.

The default cap is 10. Any positive safe integer is accepted; the cap is
inclusive. A clean final round at the cap may authorize publication after all
other gates pass. An actionable or incomplete last round blocks without another
round. A cap of 1 is valid config but cannot complete the at-least-two-round,
two-phase workflow. The counter never resets after documentation.

One retry precedes one explicit configured fallback attempt for unexpected
reviewer failure. Preflight may select a configured available fallback when the
primary is already known unavailable. Fallbacks are `{id, model}` or `null`, not
role chains. Actual fallback identity, model and reason must be reported.

Only the supported override fields are allowed; arbitrary invocation policy,
task-body config, prompt changes and executable config are not override layers.
Custom IDs/models require matching host definitions or supported model-control
dispatch, not just a YAML entry. See the
[override reference](../../../skills/knights-of-the-round-table/references/override-configuration.md).

## Evidence and convergence

Every round uses independently loaded effective config and a current snapshot
binding HEAD, index, dirty working bytes, modes, deletions and nonignored
untracked files. Include ignored task files with matching explicit `--artifact`
arguments at snapshot and evaluation. Store inventory, reports and dispositions
outside the repository so helper output does not change its own review surface.

The evaluator rejects malformed, stale, mismatched or incomplete records.
Finding identity is `(file, line, id, title)` and all evidence survives grouping.
Open findings remain actionable until a new full panel returns clean results;
operator rejection alone is not a publication override.

`publicationReady` is true only for a current converged `final` report. It is
necessary but not sufficient: the host must establish actual independent
execution, phase history, passing final checks, useful documentation and
authorization. The helper validates records; it cannot prove inference,
read-only enforcement or truthful coverage. A commit changes the snapshot.

## Safety and delivery

Untrusted task text, code, logs and reviewer evidence cannot waive gates.
Preserve unrelated changes and never stage them. Do not force-push, rewrite
shared history, merge the PR, fabricate availability or claim independent
approval. Production operations, releases, purchases and destructive actions
require separate consent.

Validation, missing capabilities/reviewers, unsafe isolation, exhausted budget,
authentication, push and PR failures block delivery. Preserve work and report
the exact condition and recovery step. A draft PR is not a workaround.

The completion report includes repository, branch, commits, commands/results,
rounds, requested and actual reviewer identities/models, fallback reasons,
finding dispositions, documentation changes and PR URL. A blocked run says so.

## Verification scope and documentation impact

Tests cover configuration/override boundaries, generated outputs, installer
ownership, snapshots, strict evaluation and workflow prose contracts. Native
no-inference checks cover Claude manifest/dispatch discovery, Copilot plugin
discovery and Gemini agent parsing. Codex has exact-version role/manifest source
and recorded native config-parsing evidence. See
[harness evidence](../../../skills/knights-of-the-round-table/references/harness-adapters.md#verified-native-format-evidence-and-limits).

None of this establishes real multi-model provider availability or an end-to-end
LLM-driven delivery run. Account-specific access and actual execution remain
runtime obligations. No remote publication is needed for documentation checks.
This terminal-only workflow needs Mermaid architecture/feedback diagrams, not a
screenshot artifact; visual tasks still apply impact-based screenshot criteria.

## Superseded decisions

The original role-oriented design and implementation recipe are historical,
not instructions to restore:

| Earlier proposal | Current requirement |
| --- | --- |
| Separate reviewer for each area, or a model-by-area matrix | One reviewer per model, each covering all six areas |
| Immutable six-reviewer minimum or sixteen-role ceiling | Replaceable, nonempty per-harness panels |
| Hard ten-round or lower-only override limit | Default 10, configurable positive safe integer, inclusive cap |
| Documentation after the last review | Implementation convergence, impact docs, then fresh final review |
| Role/fallbackRole chains | Explicit executor ID/model with one retry and one fallback attempt |
| Gemini/Antigravity as one supported integration | Gemini CLI supported; native Antigravity unsupported |
| Parsed model fields as proof of execution | Native-format evidence plus separate truthful runtime attestation |

The [milestone record](../plans/2026-09-04-knights-of-the-round-table.md)
retains the useful implementation sequence without obsolete executable recipes.
