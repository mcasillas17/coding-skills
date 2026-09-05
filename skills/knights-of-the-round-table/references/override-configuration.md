# Override Configuration

The installed skill loads `config/reviewers.yaml` first, then optionally reads
`.knights-of-the-round-table.yaml` from the target repository root. The canonical
configuration is policy; the repository file is a narrow customization layer, not
a replacement configuration.

Run the skill-local validator from the resolved repository root:

```bash
node "$SKILL_DIR/scripts/validate-config.mjs" "$REPOSITORY_ROOT"
```

On success it writes the effective configuration as JSON to stdout. A non-zero
exit is a blocked run: report the validation error and do not review, publish, or
fall back to a hand-written merge.

The validator uses only Node.js built-ins and files shipped inside the installed
skill. Overrides use the block-style YAML mappings and sequences shown below;
advanced YAML features such as custom tags, anchors, aliases, and multiline
scalars are rejected.

## Canonical invariants

- Canonical `maxReviewRounds` is exactly 10.
- `reviewerRetryCount` is exactly 1.
- The canonical roles are `correctness`, `tests`, `security`, `documentation`,
  `architecture`, and `performance`; they cannot be removed or disabled.
- Canonical role identities, focus prompts, and fallback roles are immutable.
  Prompt paths cannot be overridden.
- Every effective prompt path is a safe relative path whose real target exists as
  a regular file and resolves inside the installed skill. Symlink escapes are
  rejected.

## Override schema

The override is a YAML mapping with only these optional top-level keys:

| Key | Value |
| --- | --- |
| `maxReviewRounds` | Integer from 1 through 9. This can only lower the canonical cap. |
| `reviewers` | Array of role-keyed reviewer changes and at most 10 extra reviewer roles. |

Unknown keys are rejected, even when their value matches the canonical value.

An entry for an existing canonical role has this schema:

```yaml
role: correctness
harnesses:
  copilot: repository-correctness-reviewer
```

Only `role` and `harnesses` are allowed. `harnesses` is a non-empty partial
harness mapping: supplied agent names replace the canonical mapping for those
harnesses, and omitted harnesses keep their canonical values. A canonical
reviewer's `prompt` and `fallbackRole` cannot be overridden.

An extra role has this complete schema:

```yaml
role: accessibility
prompt: reviewers/accessibility.md
fallbackRole: correctness
harnesses:
  claude: accessibility-reviewer
  copilot: accessibility-reviewer
  codex: accessibility-reviewer
  gemini: accessibility-reviewer
```

An extra role must provide `role`, `prompt`, `fallbackRole`, and all four
`harnesses`. Its prompt must be shipped inside the installed skill and pass the
same real-path containment check as every canonical prompt. An override may add
at most 10 extra reviewer roles, bounding the effective panel at 16 roles and the
worst-case retry/fallback path at 48 reviewer executions per round, or 480 across
the hard maximum of 10 rounds.

## Merge algorithm

1. Parse and validate the canonical configuration, including all canonical
   invariants and prompt files.
2. If no override exists, return a copy of the canonical configuration.
3. Validate the override schema without applying partial results.
4. If present, replace `maxReviewRounds` with the validated lower value.
5. Merge `reviewers` by exact `role`:
   - for an existing canonical role, merge only supplied harness agent mappings;
   - for a new role, append the complete reviewer entry in override order.
6. Validate the complete effective configuration, fallback graph, harness-agent
   uniqueness, and every prompt's real path.
7. Emit the effective configuration only after every check succeeds.
