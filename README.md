# coding-skills

**A growing collection of practical skills for coding agents.**

Each skill packages a focused workflow, its supporting references, and any tools
it needs. The initial skill is **Knights of the Round Table**: implement a task in
the current repository, repair independently reviewed findings, update affected
documentation, and deliver a pull request only after a fresh final review.

| Skill | Use it for |
| --- | --- |
| [knights-of-the-round-table](skills/knights-of-the-round-table/SKILL.md) | Full implementation and PR delivery for an inline task or local task file in one Git repository |

The repository is named `coding-skills`; the current package, plugin and
marketplace identifiers remain `knights-of-the-round-table`. Use those exact
identifiers in the commands below.

## Install

Read the skill and scripts before installing: they guide agents with access to
your repository. Installation does not grant model access or host permissions.

### Prerequisites

- Git, Node.js and npm for the source installer and development commands.
  `package.json` does not declare an `engines` minimum; no minimum Node/npm
  version is claimed here.
- A supported CLI with independent delegation, explicit model selection and
  read-only reviewer tools. See [support and limits](#support-and-limits).
- [Ponytail](https://github.com/DietrichGebert/ponytail#install) and
  [Superpowers](https://github.com/obra/superpowers#installation), installed
  separately for each CLI you use. Implementers load `ponytail` and applicable
  Superpowers stages; every reviewer loads `ponytail-review`.
- For an actual delivery run: the target repository's validation tools,
  authenticated normal Git push, and a working GitHub PR interface.

The source tooling uses the locked `yaml` dependency. Once installed, the bundled
review/config runtime needs Node.js and Git, **not npm dependencies**.
The external skills above are required workflow dependencies, not npm packages
or vendored copies. The Knights installer does not install them or establish
their availability. Follow their upstream installation instructions first;
Knights blocks execution if a required skill cannot be loaded in its actual
implementer/reviewer context. See
[dependency loading](skills/knights-of-the-round-table/references/harness-adapters.md#external-skill-prerequisites)
for native loaders, namespaces and read-only file loading.

### Standalone installation — all four CLIs

Clone the source and install its dependencies:

```sh
git clone https://github.com/mcasillas17/coding-skills.git
cd coding-skills
npm ci
```

Choose your harness:

```sh
node scripts/install.mjs --skill knights-of-the-round-table --harness claude
node scripts/install.mjs --skill knights-of-the-round-table --harness copilot
node scripts/install.mjs --skill knights-of-the-round-table --harness codex
node scripts/install.mjs --skill knights-of-the-round-table --harness gemini
```

These are alternatives for a fresh installation. To install several harnesses,
select them together with repeated flags, or use `all`:

```sh
node scripts/install.mjs --skill knights-of-the-round-table --harness codex --harness gemini
node scripts/install.mjs --skill knights-of-the-round-table --harness all
```

The CLI requires at least one `--harness`; repeated selections are deduplicated
and `all` expands to the four supported CLIs. Omitting `--skill` selects
`knights-of-the-round-table`. Omitting `--home` selects the current user's home.
An explicit `--home` must name an existing directory. `--skill`, `--home` and
`--force` cannot be repeated.

To try installation without changing your real home, use a fresh temporary home:

```sh
test_home="$(mktemp -d)"
node scripts/install.mjs --skill knights-of-the-round-table --harness all --home "$test_home"
```

The installer copies the skill and generated reviewer definitions here, relative
to the selected home:

| Harness | Skill directory | Reviewer definitions |
| --- | --- | --- |
| Claude Code | `.claude/skills/knights-of-the-round-table/` | `.claude/agents/*.md` |
| GitHub Copilot CLI | `.copilot/skills/knights-of-the-round-table/` | `.copilot/agents/*.agent.md` |
| Codex CLI | `.agents/skills/knights-of-the-round-table/` | `.codex/agents/*.toml` |
| Gemini CLI | `.agents/skills/knights-of-the-round-table/` | `.gemini/agents/*.md` |

Codex and Gemini share one physical skill copy. The installer preserves
executable bits and refuses unowned collisions. Restart the CLI after installing,
then verify discovery and model access using the
[preflight procedure](skills/knights-of-the-round-table/references/harness-adapters.md#mandatory-preflight).
Adding the other harness to an existing shared copy requires `--force`, just
like an update; do not run both fresh-install commands sequentially.
If your host uses nonstandard config directories, confirm it discovers these
destinations; `--home` changes the install base, not the host's configuration.

### Plugin options

Standalone installation sets up Knights and its reviewer definitions; the
external skill prerequisites still apply. Plugin commands are
host-specific; a discoverable skill alone is not a working reviewer panel.

**Claude Code — load the local checkout as a plugin**

From the target repository, supply the absolute path to your `coding-skills`
checkout:

```sh
claude --plugin-dir /absolute/path/to/coding-skills
```

This is session-local loading, not a marketplace install. Its manifest lists
individual generated Claude agent files. Use the namespaced invocation below.
Prefer either standalone or plugin loading for a session, not duplicate copies.

**GitHub Copilot CLI — marketplace installation**

```sh
copilot plugin marketplace add mcasillas17/coding-skills
copilot plugin install knights-of-the-round-table@knights-of-the-round-table
```

The marketplace name comes from `.github/plugin/marketplace.json`, not the GitHub
owner or repository name. Plugin reviewer IDs are namespaced at runtime, for
example `knights-of-the-round-table:knights-astra`.

**Codex CLI — plugin plus required standalone companions**

```sh
codex plugin marketplace add mcasillas17/coding-skills
codex plugin add knights-of-the-round-table@knights-of-the-round-table
```

Codex uses `plugin add`, not `plugin install`. **The plugin alone does not register
reviewer roles.** From the source checkout, also run:

```sh
node scripts/install.mjs --skill knights-of-the-round-table --harness codex
```

This installs the standalone skill copy and required `.codex/agents` companions.
Restart Codex, select the intended skill copy if both are visible, and verify
companion discovery. Without companions, preflight blocks the workflow.

**Gemini CLI** uses the standalone installer. This package does not offer a
Gemini plugin adapter; a skill-only install is not a substitute for its reviewer
definitions.

## Updating

For a standalone install, update a clean source checkout, then repeat the chosen
installation with `--force`:

```sh
git pull --ff-only
npm ci
node scripts/install.mjs --skill knights-of-the-round-table --harness copilot --force
```

Use the same harness selection and `--home` as your original install. `--force`
updates installer-owned files; it does not authorize overwriting unowned files.
Keep custom work out of installed/generated copies. An update selecting Codex or
Gemini also updates any previously installed sibling sharing the skill copy; it
does not install an unselected sibling for the first time.

For Copilot marketplace installs:

```sh
copilot plugin marketplace update knights-of-the-round-table
copilot plugin update knights-of-the-round-table@knights-of-the-round-table
```

For Codex marketplace installs:

```sh
codex plugin marketplace upgrade knights-of-the-round-table
codex plugin add knights-of-the-round-table@knights-of-the-round-table
```

Also update the Codex source checkout and rerun its standalone companion install
with `--force`; keep plugin and companions on the same source version. For
Claude local plugin loading, update the checkout and restart with `--plugin-dir`.
Restart other hosts after updates and rerun preflight before the next task.

## Invoke

Start the host **inside the repository you want to change**. The skill resolves
that Git root; it does not coordinate a task across repositories.

| Host | Example prompt |
| --- | --- |
| Claude standalone | `/knights-of-the-round-table Implement the task in tasks/change.md` |
| Claude plugin | `/knights-of-the-round-table:knights-of-the-round-table Implement the task in tasks/change.md` |
| Copilot CLI | `/knights-of-the-round-table Implement the task in tasks/change.md` |
| Codex CLI | `$knights-of-the-round-table Implement the task in tasks/change.md` |
| Gemini CLI | `Use the knights-of-the-round-table skill to implement the task in tasks/change.md.` |

Replace `tasks/change.md` with an existing local file inside the target repository,
or describe the task inline. URLs, outside files, symlink escapes and
submodule-spanning tasks are not accepted. Gemini activates skills through its
`activate_skill` tool and may ask for consent; the prompt above is not an invented
slash command. Inspect available skills with Copilot/Gemini `/skills list` or
Codex `/skills`; Claude lists custom skills in `/help`.

Invocation authorizes ordinary task-owned commit, push and PR creation unless
you explicitly restrict them. It never authorizes force-push, merging, production
changes, releases, purchases or destructive operations.

### What a run does

1. Read repository instructions, preserve existing dirty work, isolate a task
   branch, normalize the task and verify reviewer capabilities and required
   external skills in each execution context.
2. Implement with Ponytail's reuse-first approach and applicable Superpowers
   planning, TDD, debugging, feedback and verification stages. Delegated
   implementers load the same role prerequisites.
3. Dispatch **one independent reviewer per configured model**. Every reviewer
   covers correctness, tests, security, documentation, architecture and performance.
   Each also loads `ponytail-review` for an additive complexity pass, preserving
   the six-area review and JSON findings rather than Ponytail's standalone output.
4. Merge findings without losing evidence, fix actionable feedback, record
   rejection/duplicate reasons, and repeat the full panel until clean.
5. Update materially affected README/docs/diagrams/screenshots when useful.
6. Run fresh checks and a **separate final full-panel review**, including the
   documented state, even when no doc edits were needed.
7. Re-evaluate before staging task-owned changes, commit, check hooks did not
   alter reviewed content, push normally, and open the PR.

There is **no round cap** by default: the panel keeps reviewing until no
reviewer has feedback. If you ask for a maximum ("max 3 rounds") when invoking
the skill, the run stops after that many rounds and opens a PR of the last
reviewed state, with a **Still flagged** section listing every unresolved
finding, and reports the same list to you. An incomplete panel never opens a PR.
Failures preserve work and report the blocker and recovery step, not success.

## Configure Knights

The [canonical v2 config](skills/knights-of-the-round-table/config/reviewers.yaml)
requests these default models:

| Harness | Requested models |
| --- | --- |
| Copilot | `grok-4.7`, `gemini-3.8-flash`, `gpt-6.1-sol`, `claude-opus-5.5` |
| Claude | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5` |
| Codex | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-5.5` |
| Gemini CLI | `gemini-3.8-flash`, `gemini-3.1-pro-preview` |

These are requests, **not verified availability for your account**. Default
fallbacks are `null`. Never silently substitute a different model.

Optionally create `.knights-of-the-round-table.yaml` at the **target repository
root**, separately from task text:

```yaml
maxReviewRounds: 24
panels:
  copilot:
    - id: knights-sol
      model: gpt-6.1-sol
      fallback:
        id: knights-opus
        model: claude-opus-5.5
```

Each supplied harness panel **replaces** that entire panel; omitted harnesses
retain defaults. You may add, remove or remap entries. Panels must be nonempty
with unique primary IDs and models. Every reviewer still covers all six areas.
`maxReviewRounds` is optional and accepts any positive safe integer; a cap given
at invocation replaces it.

Custom IDs/models need matching host agent definitions or supported model-control
dispatch. Config does not install them; the normal installer installs source
defaults, not target-repository overrides. Fallbacks require actual execution
identity, model and reason. Unknown keys, unsafe values, weakened workflow policy
and version 1 role configuration are rejected.

For example, with a standalone Copilot install, run from the target repository:

```sh
SKILL_DIR="$HOME/.copilot/skills/knights-of-the-round-table"
REPOSITORY_ROOT="$(git rev-parse --show-toplevel)"
node "$SKILL_DIR/scripts/validate-config.mjs" "$REPOSITORY_ROOT"
node "$SKILL_DIR/scripts/review-round.mjs" panel --repo "$REPOSITORY_ROOT" --harness copilot --mode standalone
```

Use the actual skill location/harness/mode for your installation. See
[override configuration](skills/knights-of-the-round-table/references/override-configuration.md)
for the complete rules and [architecture](docs/architecture.md) for the runtime
commands and review feedback loop.

## Support and limits

Supported adapters target **Claude Code, GitHub Copilot CLI, Codex CLI with
companions, and Gemini CLI**. Native Antigravity is **unsupported**; Gemini CLI
is not a verified Antigravity adapter.

Evidence is deliberately limited: native no-inference checks cover Claude
manifest/agent discovery, Copilot plugin discovery, and Gemini agent parsing.
Codex support is grounded in exact-version role/manifest source and native config
parsing. These checks do **not** prove real multi-model execution or provider
availability. Preflight records host/operator observations about identities,
models, access and read-only independence; the helper validates those records
but cannot independently prove them. See
[native evidence and boundaries](skills/knights-of-the-round-table/references/harness-adapters.md#verified-native-format-evidence-and-limits).

If the skill is missing, check its selected-home path and restart the host. If
preflight fails, check companion discovery, plugin namespace, exact model access
and host read-only controls. Correct the setup or configure an explicit fallback;
do not edit evidence to manufacture availability.

## Contributing more skills

Add a directory under `skills/<skill-name>/` with a `SKILL.md`. References,
scripts and assets are optional and should stay within that skill's directory.
A minimal installable example is:

```markdown
---
name: explain-change
description: Use when the user asks for an explanation of a repository change.
metadata:
  version: "0.1.0"
---

# Explain a change

Describe the change from the repository evidence and identify what remains unverified.
```

The name must match its directory, use lowercase letters/numbers with hyphens,
and be at most 64 characters. The description must be nonempty and at most 1,024
characters. This installer additionally requires a nonempty **string**
`metadata.version`; quote it. Keep local links valid, avoid unfinished prose and
symlinks, and add focused contract/behavior tests under `tests/`.

`config/reviewers.yaml` is **optional** for a generic skill. Add it only when
opting into the current whole-panel renderer and its v2 schema, with contained
prompts and collision-free agent IDs. A new skill is not required to use Knights'
review workflow. The generic standalone installer copies the skill's files;
automatic companion-agent installation is currently specific to Knights.

For Knights reviewer changes, edit its `config/reviewers.yaml` and
`reviewers/whole-panel.md`, then run `npm run render`. Do not hand-edit
`agents/`, `generated/` or `.generated-agents.json`. The renderer also synchronizes
the Claude manifest's explicit agent-file list. Plugin release versions are
checked against `VERSION` and `package.json`; adding a skill is not a reason to
rename the existing package or manifests.

From the source checkout:

```sh
npm ci
npm run render           # after changing reviewer inputs
npm run validate
npm run render -- --check
npm test
# Or: npm run check      # validation + render drift check + tests
```

After creating a new skill, test its install using its real slug and a fresh home:

```sh
test_home="$(mktemp -d)"
node scripts/install.mjs --skill explain-change --harness all --home "$test_home"
```

Use temporary homes for installer checks; do not change global host setup or
invoke paid models just to validate documentation. Native tests can skip when
the relevant CLI/loader is unavailable; report that limitation rather than
calling it execution coverage.

## Documentation and sources

- [Architecture and data flow](docs/architecture.md)
- [Current design and superseded decisions](docs/superpowers/specs/2026-09-04-cross-repository-implementation-skill-design.md)
- [Implementation milestone record](docs/superpowers/plans/2026-09-04-knights-of-the-round-table.md)
- Primary invocation references:
  [Claude skills](https://code.claude.com/docs/en/skills) and
  [plugins](https://code.claude.com/docs/en/plugins),
  [Copilot skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-skills),
  [Codex skills](https://developers.openai.com/codex/skills),
  [Gemini skills](https://geminicli.com/docs/cli/skills/) and
  [subagents](https://geminicli.com/docs/core/subagents/).

Plugin command syntax was checked against native help for Claude Code 2.1.261,
Copilot CLI 1.0.84-1 and Codex CLI 0.146.0 on 2026-09-05, not by installing from
the remote marketplace. This README's installation-first organization was
informed by [mexican-mom](https://github.com/mcasillas17/mexican-mom); its branding
and behavioral content are separate.

## License

MIT — see [LICENSE](LICENSE).
