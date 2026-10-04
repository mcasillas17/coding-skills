# Result contract v2

The evaluator checks config, snapshot, requested/actual identity and six-area
coverage consistency. It **cannot prove** an LLM ran, read every file, used its
reported model or remained independent. The host/operator must attest those
facts from real dispatch/results, never fill them from task instructions.

`evaluateRound(round, context)` requires a separately loaded effective `config`,
`harness`, `mode`, optional discovered `pluginName`, and a fresh `snapshot` from
`createSnapshot(repositoryRoot, {artifacts})`. Do not build that context from the
round. The CLI performs both loads itself; an API caller has the same obligation.
`requiredReviewers` and `maxRounds` are not report fields. The selected config
panel and `maxReviewRounds` are authoritative.

## Example (one result shown, not a complete default panel)

```json
{
  "version": 2,
  "round": 1,
  "phase": "implementation",
  "configDigest": "<digest emitted by panel command>",
  "snapshotDigest": "<digest emitted by snapshot command>",
  "results": [{
    "reviewer": "knights-sol",
    "status": "completed",
    "requestedModel": "gpt-6.1-sol",
    "execution": {
      "id": "knights-of-the-round-table:knights-sol",
      "model": "gpt-6.1-sol"
    },
    "snapshotDigest": "<same current snapshot digest>",
    "coverage": ["correctness", "tests", "security", "documentation", "architecture", "performance"],
    "findings": []
  }]
}
```

All configured reviewers need their own result. `reviewer` is the local slot ID;
`execution.id` is the actual invocation identity (namespaced for Copilot/Claude
plugins, bare for standalone and Codex companion agents). Fallback uses the
original slot/requestedModel, actual configured fallback ID/model and a nonempty
`execution.reason`. Every completed review must cover all six dimensions exactly
once, on the current snapshot. A partial review must use `failed` or `skipped`.
Unknown keys, duplicates, model mismatch, stale digests and malformed fields fail.

Findings use `id`, `severity` (critical/high/medium/low), `confidence` (1–10),
`file` (safe repository-relative path), `line` (positive integer), `title`,
`evidence`, `recommendation`, and `status: "open"`. Failed/skipped results cannot
certify convergence. Do not relabel open feedback "fixed" in old reports.

## CLI

```sh
node "$SKILL_DIR/scripts/review-round.mjs" snapshot --repo "$REPOSITORY_ROOT" --artifact task.md
node "$SKILL_DIR/scripts/review-round.mjs" panel --repo "$REPOSITORY_ROOT" --harness copilot --mode plugin --plugin-name knights-of-the-round-table
node "$SKILL_DIR/scripts/review-round.mjs" evaluate /tmp/knights-review/round.json --repo "$REPOSITORY_ROOT" --harness copilot --mode plugin --plugin-name knights-of-the-round-table --artifact task.md
```

The helpers emit JSON to stdout without writing the repository. Save records in
an invocation-specific external directory. Use identical explicit artifacts
throughout, particularly for ignored local task files. All nonignored untracked
files are included automatically. Tracked deletions, working file bytes/modes,
symlink target text, index entries and HEAD are fingerprinted. No link targets
outside the repo are read. Explicit artifact symlinks and submodules block.
Capture detects ordinary concurrent changes with two matching reads; this is
not a sandbox or protection against a hostile concurrent writer.
