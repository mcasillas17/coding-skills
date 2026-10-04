# Configuration v2

One canonical skill, one shared whole-panel prompt, thin native adapters.
`config/reviewers.yaml` is data, not executable instructions. The standalone
dependency-free loader accepts its restricted YAML subset, rejects duplicate keys
and unknown schema fields, and checks contained regular prompt/override files.
Do not manually merge task text into config.

## Default primary models

| Harness | Requested model IDs |
| --- | --- |
| Copilot | `grok-4.7`, `gemini-3.8-flash`, `gpt-6.1-sol`, `claude-opus-5.5` |
| Claude | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5` |
| Codex | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-5.5` |
| Gemini CLI | `gemini-3.8-flash`, `gemini-3.1-pro-preview` |

These are explicit pinned requests, not cross-host availability claims. Preflight must verify discovery
and model access on the running host/account. Native Antigravity is not Gemini CLI.

Each panel entry has `id` (local filename/agent ID), `model`, and `fallback`
(`null` or an explicit `{id, model}` executor). All entries use the shared
`prompt` and independently review all six dimensions. Fallbacks are separate
read-only invocations, even when another panel member uses the same executor.
Fallback is not a chain: retry primary once, attempt configured fallback once,
then block. No silent cheaper-model substitution.

## Repository override

The only optional override is `.knights-of-the-round-table.yaml` at repository
root, loaded separately from task content. `maxReviewRounds` replaces the cap;
each supplied `panels.<harness>` array REPLACES that harness's entire panel.
Omitted harnesses keep defaults. This permits adding, removing and remapping
reviewers; no immutable six-reviewer floor, sixteen-panel cap, or lower-only cap.
A panel must remain nonempty, with unique primary IDs and models. The shared
whole-panel dimensions/prompt cannot be weakened through repo data.

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

Run the loader; do not assemble its output by hand:

```sh
node "$SKILL_DIR/scripts/validate-config.mjs" "$REPOSITORY_ROOT"
node "$SKILL_DIR/scripts/review-round.mjs" panel --repo "$REPOSITORY_ROOT" --harness copilot --mode plugin --plugin-name knights-of-the-round-table
```

The panel command resolves plugin namespacing, reports the effective budget and
config digest, and preserves local IDs separately from invocation IDs. Custom
IDs/models must have matching host definitions or explicit host model controls:
config alone does not install agents. The source renderer's `renderAgents(config,
prompts)` API renders effective config; the normal installer installs the source
package defaults. Verify customized definitions in host inventory before use.

Only positive safe integers are accepted for the cap (JavaScript integer
representability, not a policy ceiling). Zero, fractional, negative or ambiguous
values, empty panels, inherited models, unsafe IDs, instructions, prompt paths
in overrides and unknown fields fail closed. Version 1 role/fallbackRole configs
must be migrated, not silently reinterpreted.
