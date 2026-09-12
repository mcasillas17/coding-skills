import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseYamlDocument } from "../skills/knights-of-the-round-table/scripts/parse-yaml.mjs";
import * as runtime from "../skills/knights-of-the-round-table/scripts/review-round.mjs";

const config = () => parseYamlDocument(readFileSync(new URL("../skills/knights-of-the-round-table/config/reviewers.yaml", import.meta.url), "utf8"));
const dimensions = ["correctness", "tests", "security", "documentation", "architecture", "performance"];
const snapshot = { version: 1, repositoryRoot: "/example/repository", head: "a".repeat(40), digest: "b".repeat(64), artifacts: [] };
function context() { return { config: config(), harness: "copilot", mode: "plugin", pluginName: "knights-of-the-round-table", snapshot }; }
function round(ctx = context(), phase = "implementation") {
  return {
    version: 2, round: 1, phase, configDigest: runtime.configDigest(ctx.config), snapshotDigest: ctx.snapshot.digest,
    results: ctx.config.panels[ctx.harness].map(entry => ({
      reviewer: entry.id, status: "completed", requestedModel: entry.model,
      execution: { id: `${ctx.pluginName}:${entry.id}`, model: entry.model },
      snapshotDigest: ctx.snapshot.digest, coverage: [...dimensions], findings: [],
    })),
  };
}
const finding = extra => ({
  id: "finding:missing-validation", severity: "medium", confidence: 8, file: "one.js", line: 1,
  title: "Missing validation", evidence: "Null reaches the write", recommendation: "Reject null", status: "open", ...extra,
});
test("snapshot and config APIs exist", () => {
  assert.equal(typeof runtime.createSnapshot, "function");
  assert.equal(typeof runtime.configDigest, "function");
});
test("requires the entire configured panel even if the report omits reviewers", () => {
  const ctx = context(), data = round(ctx);
  data.results.pop();
  assert.equal(runtime.evaluateRound(data, ctx).state, "incomplete");
  data.requiredReviewers = [data.results[0].reviewer];
  assert.throws(() => runtime.evaluateRound(data, ctx), /unknown.*requiredReviewers/);
});
test("implementation convergence is not publication readiness", () => {
  const ctx = context(), data = round(ctx);
  assert.equal(runtime.evaluateRound(data, ctx).publicationReady, false);
  data.phase = "final";
  assert.equal(runtime.evaluateRound(data, ctx).publicationReady, true);
});
test("default config has no round cap: feedback keeps the loop going at any round", () => {
  const ctx = context(), data = round(ctx, "final");
  assert.equal(ctx.config.maxReviewRounds, undefined);
  data.results[0].findings = [finding({})];
  data.round = 1000;
  const result = runtime.evaluateRound(data, ctx);
  assert.equal(result.state, "actionable");
  assert.equal(result.publicationReady, false);
  data.results[0].findings = [];
  assert.equal(runtime.evaluateRound(data, ctx).state, "converged");
});
for (const cap of [1, 2, 10]) {
  test(`clean final round converges at user cap ${cap}`, () => {
    const ctx = context(); ctx.config.maxReviewRounds = cap;
    const data = round(ctx, "final"); data.round = cap;
    const result = runtime.evaluateRound(data, ctx);
    assert.equal(result.state, "converged");
    assert.equal(result.publicationReady, true);
  });
  for (const phase of ["implementation", "final"]) {
    test(`complete ${phase} round at user cap ${cap} publishes with its unresolved findings`, () => {
      const ctx = context(); ctx.config.maxReviewRounds = cap;
      const data = round(ctx, phase); data.round = cap;
      data.results[0].findings = [finding({})];
      const result = runtime.evaluateRound(data, ctx);
      assert.equal(result.state, "limit-reached");
      assert.equal(result.publicationReady, true);
      assert.equal(result.actionable.length, 1);
    });
  }
}
test("clean implementation round at the user cap publishes without a final review", () => {
  const ctx = context(); ctx.config.maxReviewRounds = 3;
  const data = round(ctx); data.round = 3;
  const result = runtime.evaluateRound(data, ctx);
  assert.equal(result.state, "limit-reached");
  assert.equal(result.publicationReady, true);
  assert.deepEqual(result.actionable, []);
});
test("below the user cap feedback stays actionable, and rounds past it are rejected", () => {
  const ctx = context(); ctx.config.maxReviewRounds = 10;
  const data = round(ctx, "final");
  data.results[0].findings = [finding({})];
  data.round = 9;
  assert.equal(runtime.evaluateRound(data, ctx).state, "actionable");
  data.round = 11;
  assert.throws(() => runtime.evaluateRound(data, ctx), /round must be within configured maxReviewRounds/);
});
test("missing, failed and skipped reviewers still block a clean final round at the cap", () => {
  const ctx = context(); ctx.config.maxReviewRounds = 10;
  for (const status of ["missing", "failed", "skipped"]) {
    const data = round(ctx, "final"); data.round = ctx.config.maxReviewRounds;
    const reviewer = data.results[0].reviewer;
    if (status === "missing") data.results.shift();
    else data.results[0].status = status;
    const result = runtime.evaluateRound(data, ctx);
    assert.equal(result.state, "incomplete");
    assert.equal(result.publicationReady, false);
    assert.deepEqual(result.missingReviewers, [reviewer]);
  }
});
test("rejects stale snapshot, config, requested model, execution identity and incomplete coverage", () => {
  const ctx = context();
  for (const mutate of [
    r => r.snapshotDigest = "c".repeat(64),
    r => r.configDigest = "c".repeat(64),
    r => r.results[0].snapshotDigest = "c".repeat(64),
    r => r.results[0].requestedModel = "cheaper",
    r => r.results[0].execution.model = "cheaper",
    r => r.results[0].execution.id = r.results[0].reviewer,
    r => r.results[0].coverage.pop(),
    r => r.results[0].coverage.push("correctness"),
  ]) {
    for (const number of [1, 10]) {
      const data = round(ctx, "final"); data.round = number; mutate(data);
      assert.throws(() => runtime.evaluateRound(data, ctx));
    }
  }
});
test("fallback is configured, attributed and requires a reason", () => {
  const ctx = context();
  ctx.config.panels.copilot[0].fallback = { id: "alternative", model: "other-model" };
  const data = round(ctx);
  data.results[0].execution = { id: "knights-of-the-round-table:alternative", model: "other-model" };
  assert.throws(() => runtime.evaluateRound(data, ctx), /reason/);
  data.results[0].execution.reason = "Requested model rejected by host after retry";
  const result = runtime.evaluateRound(data, ctx);
  assert.equal(result.executions.find(e => e.reviewer === "knights-grok").fallback, true);
  assert.equal(result.executions.find(e => e.reviewer === "knights-grok").model, "other-model");
});
test("generic finding IDs in different files or defects never discard reports", () => {
  const ctx = context(), data = round(ctx);
  data.results[0].findings = [finding({})];
  data.results[1].findings = [finding({ file: "two.js" })];
  data.results[2].findings = [finding({ title: "Different defect at same location" })];
  assert.equal(runtime.evaluateRound(data, ctx).actionable.length, 3);
});
test("true same-location identity merges deterministically while retaining evidence and provenance", () => {
  const ctx = context(), data = round(ctx);
  data.results[0].findings = [finding({ evidence: "first evidence" })];
  data.results[1].findings = [finding({ evidence: "second evidence", severity: "high" })];
  const first = runtime.evaluateRound(data, ctx);
  assert.equal(first.actionable.length, 1);
  assert.equal(first.actionable[0].reports.length, 2);
  assert.equal(first.actionable[0].severity, "high");
  data.results.reverse();
  assert.deepEqual(runtime.evaluateRound(data, ctx), first);
});
test("failed/skipped results cannot certify convergence and invalid finding schema fails closed", () => {
  const ctx = context(), data = round(ctx);
  data.results[0].status = "failed";
  assert.equal(runtime.evaluateRound(data, ctx).state, "incomplete");
  for (const extra of [{ line: 0 }, { confidence: 11 }, { file: "../outside" }, { status: "fixed" }, { surprise: true }]) {
    const bad = round(ctx); bad.results[0].findings = [finding(extra)];
    assert.throws(() => runtime.evaluateRound(bad, ctx));
  }
});
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "knights-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "tracked"), "baseline"); git("add", "."); git("commit", "-qm", "fixture");
  return { root, git };
}
test("snapshot binds HEAD, staged content, dirty bytes, untracked files and mode without writes", t => {
  const { root, git } = repository(t);
  const digest = () => runtime.createSnapshot(root).digest;
  const clean = digest();
  assert.equal(digest(), clean);
  writeFileSync(join(root, "tracked"), "dirty");
  const dirty = digest(); assert.notEqual(dirty, clean);
  git("add", "."); assert.notEqual(digest(), dirty);
  const staged = digest(); writeFileSync(join(root, "task.md"), "artifact");
  assert.notEqual(digest(), staged);
  const untracked = digest(); chmodSync(join(root, "task.md"), 0o755);
  assert.notEqual(digest(), untracked);
  assert.match(git("status", "--short"), /task.md/);
});
test("snapshot includes explicit ignored task artifacts and rejects paths escaping the repository", t => {
  const { root } = repository(t);
  writeFileSync(join(root, ".gitignore"), "ignored.md\n");
  writeFileSync(join(root, "ignored.md"), "task");
  const first = runtime.createSnapshot(root, { artifacts: ["ignored.md"] });
  writeFileSync(join(root, "ignored.md"), "changed");
  assert.notEqual(runtime.createSnapshot(root, { artifacts: ["ignored.md"] }).digest, first.digest);
  assert.throws(() => runtime.createSnapshot(root, { artifacts: ["../outside"] }), /path|repository/);
  symlinkSync(tmpdir(), join(root, "escape"));
  assert.throws(() => runtime.createSnapshot(root, { artifacts: ["escape/a"] }));
});

for (const replacement of ["file-to-directory", "directory-to-file"]) {
  for (const staged of [false, true]) {
    test(`snapshot fingerprints ${staged ? "staged" : "unstaged"} ${replacement} replacements`, t => {
      const { root, git } = repository(t);
      const path = join(root, "tracked");
      const child = join(path, "nested/child");
      if (replacement === "directory-to-file") {
        rmSync(path);
        mkdirSync(join(path, "nested"), { recursive: true });
        writeFileSync(child, "original child");
        git("add", "-A"); git("commit", "-qm", "directory baseline");
      }
      const clean = runtime.createSnapshot(root).digest;
      rmSync(path, { recursive: true });
      if (replacement === "file-to-directory") {
        mkdirSync(join(path, "nested"), { recursive: true });
        writeFileSync(child, "replacement child");
      } else {
        writeFileSync(path, "replacement file");
      }
      if (staged) git("add", "-A");
      const beforeStatus = git("status", "--porcelain=v1", "-uall");
      const beforeIndex = git("ls-files", "--stage", "-z");
      const replaced = runtime.createSnapshot(root).digest;
      assert.notEqual(replaced, clean);
      assert.equal(runtime.createSnapshot(root).digest, replaced);
      assert.equal(git("status", "--porcelain=v1", "-uall"), beforeStatus);
      assert.equal(git("ls-files", "--stage", "-z"), beforeIndex);
      const replacementPath = replacement === "file-to-directory" ? child : path;
      writeFileSync(replacementPath, "changed replacement bytes");
      const changed = runtime.createSnapshot(root).digest;
      assert.notEqual(changed, replaced, "replacement content must be fingerprinted independently of deleted index paths");
      git("add", "-A");
      const stagedChange = runtime.createSnapshot(root).digest;
      assert.notEqual(stagedChange, changed, "staging must remain part of the snapshot");
      writeFileSync(replacementPath, "new dirty replacement bytes");
      assert.notEqual(runtime.createSnapshot(root).digest, stagedChange);
      const obsoleteArtifact = replacement === "file-to-directory" ? "tracked" : "tracked/nested/child";
      assert.throws(() => runtime.createSnapshot(root, { artifacts: [obsoleteArtifact] }),
        /artifact|regular files|ENOTDIR/);
    });
  }
}

test("snapshot rejects explicit replaced tracked artifacts before staging", t => {
  const { root, git } = repository(t);
  rmSync(join(root, "tracked"));
  mkdirSync(join(root, "tracked"));
  writeFileSync(join(root, "tracked/child"), "child");
  assert.throws(() => runtime.createSnapshot(root, { artifacts: ["tracked"] }), /artifact|regular files/);
  git("add", "-A"); git("commit", "-qm", "directory");
  rmSync(join(root, "tracked"), { recursive: true });
  writeFileSync(join(root, "tracked"), "replacement");
  assert.throws(() => runtime.createSnapshot(root, { artifacts: ["tracked/child"] }), /artifact|ENOTDIR/);
});

test("snapshot never treats parent symlinks or nonregular replacements as tracked deletions", t => {
  const { root, git } = repository(t);
  mkdirSync(join(root, "directory/nested"), { recursive: true });
  writeFileSync(join(root, "directory/nested/child"), "child");
  git("add", "-A"); git("commit", "-qm", "directory");
  rmSync(join(root, "directory"), { recursive: true });
  symlinkSync(tmpdir(), join(root, "directory"));
  assert.throws(() => runtime.createSnapshot(root), /symlink/);
  rmSync(join(root, "directory"));
  execFileSync("mkfifo", [join(root, "directory")]);
  assert.throws(() => runtime.createSnapshot(root), /regular|directory/);
  rmSync(join(root, "directory"));
  rmSync(join(root, "tracked"));
  execFileSync("mkfifo", [join(root, "tracked")]);
  assert.throws(() => runtime.createSnapshot(root), /regular/);
});

test("snapshot propagates filesystem access errors instead of recording tracked deletions", t => {
  if (process.getuid?.() === 0) return t.skip("root bypasses directory permissions");
  const { root, git } = repository(t);
  const directory = join(root, "restricted");
  mkdirSync(directory);
  writeFileSync(join(directory, "child"), "child");
  git("add", "-A"); git("commit", "-qm", "restricted directory");
  chmodSync(directory, 0);
  try {
    assert.throws(() => runtime.createSnapshot(root), { code: "EACCES" });
  } finally {
    chmodSync(directory, 0o755);
  }
});
const script = new URL("../skills/knights-of-the-round-table/scripts/review-round.mjs", import.meta.url).pathname;
test("CLI --max-rounds caps the run, binds the config digest and exits 4 at the limit", t => {
  const { root } = repository(t);
  const ctx = context(); ctx.snapshot = runtime.createSnapshot(root);
  const out = mkdtempSync(join(tmpdir(), "knights-round-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const cli = (...args) => spawnSync(process.execPath, [script, ...args, "--repo", root, "--harness", "copilot", "--mode", "plugin", "--plugin-name", ctx.pluginName], { encoding: "utf8" });
  assert.equal(JSON.parse(cli("panel").stdout).maxReviewRounds, null);
  const panel = JSON.parse(cli("panel", "--max-rounds", "2").stdout);
  assert.equal(panel.maxReviewRounds, 2);
  const data = round(ctx); data.round = 2; data.configDigest = panel.configDigest;
  data.results[0].findings = [finding({})];
  writeFileSync(join(out, "round.json"), JSON.stringify(data));
  const limited = cli("evaluate", join(out, "round.json"), "--max-rounds", "2");
  assert.equal(limited.status, 4, limited.stderr);
  assert.equal(JSON.parse(limited.stdout).publicationReady, true);
  const uncapped = cli("evaluate", join(out, "round.json"));
  assert.equal(uncapped.status, 1);
  assert.match(uncapped.stderr, /config digest/);
  for (const bad of ["0", "-1", "1.5", "1e3", "abc"]) assert.equal(cli("panel", "--max-rounds", bad).status, 1, bad);
});
test("CLI accepts a clean final round but rejects its snapshot after changes", t => {
  const { root } = repository(t);
  const ctx = context(); ctx.snapshot = runtime.createSnapshot(root);
  const data = round(ctx, "final");
  data.round = 50;
  const out = mkdtempSync(join(tmpdir(), "knights-round-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeFileSync(join(out, "round.json"), JSON.stringify(data));
  const args = [script, "evaluate", join(out, "round.json"), "--repo", root, "--harness", "copilot", "--mode", "plugin", "--plugin-name", ctx.pluginName];
  const fresh = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).publicationReady, true);
  writeFileSync(join(root, "new-artifact"), "not reviewed");
  const stale = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /snapshot/);
});
