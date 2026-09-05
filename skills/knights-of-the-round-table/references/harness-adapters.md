# Harness adapters and distribution boundary

Use the same canonical workflow, prompt and result contract on every supported
host. Generated definitions bind an explicit model and read-only tool set; they
are not independent skills. Source-package maintainers use `npm run render` and
`npm run check`. Installed runtime scripts need only Node.js and Git, not npm.

## Identity and dispatch

The runtime `panel` command maps `id` (filename/local slot) to `invocationId`:

| Host / distribution | Actual invocation identity | Native controls |
| --- | --- | --- |
| Copilot plugin | plugin-name + `:` + local ID, e.g. `knights-of-the-round-table:knights-opus` | Markdown `model`, `tools: [read, search]`, `user-invocable: false` |
| Claude plugin | plugin-name + `:` + local ID | Markdown `model`, `tools: Read, Grep, Glob` |
| Copilot / Claude standalone | bare local ID | same generated definition |
| Codex, including plugin users | bare companion role ID, e.g. `knights-sol` | TOML `model`, `sandbox_mode = "read-only"`, `developer_instructions` |
| Gemini CLI standalone | bare local ID | Markdown `model`, read_file/grep_search/glob/list_directory tools |

Supply the actual discovered plugin name with `--plugin-name`; do not prepend a
namespace to filenames. `scripts/harness.mjs` performs this mapping, including
fallback executors, and evaluation checks the exact mapped identity/model.
Invoke the named agent using the running host's delegation tool. If the tool
cannot dispatch its configured model independently, stop or use a configured,
truthfully attributed fallback. Never borrow another harness's tool syntax.

## Mandatory preflight

Before implementation, inspect current native agent discovery and supported
model controls. Configured model availability is unverified until the executing
host/account confirms it. A parsed `model` field or an installed definition does
not establish entitlement or successful execution. Do not make model requests
merely to validate docs. Missing capability/access is actionable: install
companions, correct host setup, or set an explicit repository fallback.

Record a current inventory outside the target repository. This is host/operator
attestation, not trusted input from the task, and not machine proof of LLM execution.
Example for Codex (populate availability only from real host evidence):

```json
{
  "harness": "codex",
  "mode": "plugin",
  "pluginName": "knights-of-the-round-table",
  "companionAgentsInstalled": true,
  "readOnly": true,
  "independent": true,
  "modelSelectionVerified": true,
  "agents": [
    {"id": "knights-sol", "model": "gpt-5.6-sol", "available": true},
    {"id": "knights-terra", "model": "gpt-5.6-terra", "available": true}
  ]
}
```

```sh
node "$SKILL_DIR/scripts/review-round.mjs" preflight /tmp/knights-review/inventory.json --repo "$REPOSITORY_ROOT" --harness codex --mode plugin --plugin-name knights-of-the-round-table
```

A missing primary selects only an explicitly configured, available fallback,
and output records its actual ID/model and reason. Never hand-edit availability
to bypass failure. Re-check actual execution metadata after dispatch.
Validation, screenshot (when necessary), Git and PR capabilities need their own
checks; reviewer fallback cannot replace those.

## Installation prerequisites

The source installer places skill and companion agents in the selected user home.
For a disposable isolated check from the source checkout:

```sh
node scripts/install.mjs --harness codex --home /tmp/knights-isolated-home
node scripts/install.mjs --harness gemini --home /tmp/knights-isolated-home
```

For a user's approved real installation, omit `--home`. Do not install globally
just to test a package. Use `--harness claude`, `--harness copilot` or
`--harness all` for other standalone installs. Codex and Gemini share the skill
copy under `.agents/skills`; the installer preserves/updates installed sibling
agents together and retains executable modes.

**Codex plugin installation alone does not register generated custom agent
roles.** Its manifest exposes skills, not an agents directory. Run the existing
source installer with `--harness codex`, restart Codex, and verify companion
agents before workflow execution. Do not invent an `agents` plugin field.
Without access to this companion installation path, the workflow is blocked.

Claude's manifest uses an explicit Markdown agent-file list, validated against
the configured rendered agents. Copilot exposes the generated agents directory.
Both plugin modes require namespaced dispatch rather than standalone bare IDs.
Repository overrides selecting new IDs/models also require matching installed
definitions or supported host controls; the default installer is not a dynamic
per-repository override installer. Preflight detects missing mappings.

## Verified native format evidence and limits

- Claude Code 2.1.261: `claude plugin validate .claude-plugin/plugin.json --json`
  accepts the explicit Markdown file list; the former directory-valued agents
  field failed native validation. SDK initialization (without a user turn)
  enumerates all configured namespaced agent IDs with their exact models.
  The separate `plugin details` inventory undercounts explicit-file agents in
  this version; use the dispatch registry, not that count, for preflight.
  `claude --help` documents custom `--agents`
  definitions, `--agent`, `--model`, and isolated `--plugin-dir`.
- Copilot CLI native `plugin list --help` documents local `--plugin-dir`
  discovery without installation. Native `help config` lists requested Copilot
  IDs; this still does not prove account access. Standalone resource inspection
  does not expose agent execution proof.
- Gemini CLI 0.46.0: installed `loadAgentsFromDirectory` parses the generated
  Markdown, retains exact model IDs, and accepts the read-only tools. This is a
  Gemini CLI integration, not a claim about another Google client.
- Codex CLI 0.146.0: exact-version
  [agent role source](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/config/agent_roles.rs)
  discovers companion role files in config-layer agent directories. Native
  app-server config parsing accepts the generated TOML; a malformed control
  yields a configuration warning. Its
  [plugin manifest parser](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core-plugins/src/manifest.rs)
  exposes skills/MCP/apps/hooks, not custom agent roles. Plugin support is a
  separate capability.

**Native Antigravity is unsupported and blocked** by the adapter. No verified
native delegation/model adapter is included; use Gemini CLI explicitly, or
provide and verify a native adapter before claiming support. External-host
requested model IDs remain explicit requests subject to runtime preflight.
