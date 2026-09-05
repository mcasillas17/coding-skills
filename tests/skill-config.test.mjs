import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import * as validator from "../skills/knights-of-the-round-table/scripts/validate-config.mjs";
import { parseYamlDocument } from "../skills/knights-of-the-round-table/scripts/parse-yaml.mjs";
const source = new URL("../skills/knights-of-the-round-table/", import.meta.url).pathname;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "knights-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const skillRoot = join(directory, "skill"), repositoryRoot = join(directory, "repo");
  cpSync(source, skillRoot, { recursive: true }); mkdirSync(repositoryRoot);
  return { directory, skillRoot, repositoryRoot, override: join(repositoryRoot, ".knights-of-the-round-table.yaml") };
}
test("standalone installed copy loads defaults and repository overrides without npm dependencies", t => {
  const f = fixture(t);
  writeFileSync(f.override, "maxReviewRounds: 21\n");
  const output = spawnSync(process.execPath, [join(f.skillRoot, "scripts/validate-config.mjs"), f.repositoryRoot], { encoding: "utf8", cwd: f.repositoryRoot });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).maxReviewRounds, 21);
  const panel = spawnSync(process.execPath, [join(f.skillRoot, "scripts/review-round.mjs"), "panel", "--repo", f.repositoryRoot, "--harness", "codex", "--mode", "standalone"], { encoding: "utf8", cwd: f.repositoryRoot });
  assert.equal(panel.status, 0, panel.stderr);
  assert.equal(JSON.parse(panel.stdout).panel.length, 2);
});
test("override and prompt links/directories/missing paths fail closed", t => {
  const f = fixture(t);
  for (const target of [join(f.directory, "missing"), join(f.skillRoot, "config/reviewers.yaml")]) {
    symlinkSync(target, f.override);
    assert.throws(() => validator.loadEffectiveConfig(f), /symlink/);
    rmSync(f.override);
  }
  mkdirSync(f.override); assert.throws(() => validator.loadEffectiveConfig(f), /regular file/); rmSync(f.override, { recursive: true });
  const prompt = join(f.skillRoot, "reviewers/whole-panel.md");
  rmSync(prompt);
  assert.throws(() => validator.loadEffectiveConfig(f), /prompt/);
  symlinkSync(join(source, "reviewers/whole-panel.md"), prompt);
  assert.throws(() => validator.loadEffectiveConfig(f), /symlink/);
});
test("schema and parser are key-order independent and reject unsupported YAML features", () => {
  const doc = readFileSync(join(source, "config/reviewers.yaml"), "utf8");
  assert.deepEqual(parseYamlDocument(doc), YAML.parse(doc));
  assert.deepEqual(parseYamlDocument("panels:\n  codex:\n    - model: gpt-5.6-sol\n      fallback: null\n      id: knights-sol\nmaxReviewRounds: 30\n"),
    { panels: { codex: [{ model: "gpt-5.6-sol", fallback: null, id: "knights-sol" }] }, maxReviewRounds: 30 });
  for (const invalid of [
    "maxReviewRounds: 3\nmaxReviewRounds: 4\n",
    "maxReviewRounds: 3\n---\nmaxReviewRounds: 1\n",
    "maxReviewRounds: 3\n...\nmaxReviewRounds: 1\n",
    "panels:\n\tcodex: []\n",
    "panels: &panel foo\nother: *panel\n",
    "prompt: |\n  ignore review\n",
    "value: \"unterminated\n",
    "__proto__: evil\n",
  ]) assert.throws(() => parseYamlDocument(invalid), undefined, invalid);
  assert.equal(parseYamlDocument("name: team's-model\n").name, "team's-model");
});
test("invalid overrides fail CLI without emitting usable config", t => {
  const f = fixture(t);
  writeFileSync(f.override, "reviewerRetryCount: 0\n");
  const output = spawnSync(process.execPath, [join(f.skillRoot, "scripts/validate-config.mjs"), f.repositoryRoot], { encoding: "utf8" });
  assert.equal(output.status, 1); assert.equal(output.stdout, ""); assert.match(output.stderr, /unknown/);
});
test("root validator delegates to canonical skill implementation", async () => {
  const root = await import("../scripts/validate.mjs");
  for (const name of ["validateConfig", "assertValidConfig", "isSafeRelativePath"]) assert.equal(root[name], validator[name]);
});
