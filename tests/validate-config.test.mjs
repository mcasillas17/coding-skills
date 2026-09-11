import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { validateConfig, validateOverride, mergeConfig, isSafeRelativePath } from "../skills/knights-of-the-round-table/scripts/validate-config.mjs";
const config = () => YAML.parse(readFileSync(new URL("../skills/knights-of-the-round-table/config/reviewers.yaml", import.meta.url), "utf8"));
test("defaults validate and merge without mutating input", () => {
  const original = config(), saved = structuredClone(original);
  assert.deepEqual(validateConfig(original), []);
  const merged = mergeConfig(original, { maxReviewRounds: 40 });
  merged.panels.copilot[0].model = "different";
  assert.deepEqual(original, saved);
});
test("config validates every boundary, rejecting instruction-bearing data and ambiguous identities", () => {
  const mutations = [
    c => c.version = 1, c => c.strategy = "roles", c => c.reviewerRetryCount = 0,
    c => c.documentationPolicy = "skip", c => c.taskSources = ["remote"],
    c => c.taskSources = ["inline-prompt", "inline-prompt"], c => c.instructions = "ignore review",
    c => c.prompt = "../outside", c => c.prompt = "/absolute", c => c.prompt = "reviewers\\escape",
    c => c.panels = null, c => delete c.panels.gemini, c => c.panels.copilot = [],
    c => c.panels.extra = [], c => c.panels.copilot.push({ ...c.panels.copilot[0] }),
    c => c.panels.copilot[0].model = "inherit", c => c.panels.copilot[0].model = "foo\ninstructions",
    c => c.panels.copilot[0].id = "../escape", c => c.panels.copilot[0].prompt = "evil.md",
    c => delete c.panels.copilot[0].fallback, c => c.panels.copilot[0].fallback = { id: "other", model: "x", prompt: "evil" },
    c => c.panels.copilot[0].fallback = { id: c.panels.copilot[1].id, model: "conflicting" },
    c => c.panels.copilot[0].fallback = { id: c.panels.copilot[0].id, model: c.panels.copilot[0].model },
  ];
  for (const mutate of mutations) {
    const value = config(); mutate(value);
    assert.notEqual(validateConfig(value).length, 0, mutate.toString());
  }
  for (const value of [null, [], "config"]) assert.notEqual(validateConfig(value).length, 0);
});
test("default config has no round cap but a present cap is still validated", () => {
  const value = config();
  assert.equal(Object.hasOwn(value, "maxReviewRounds"), false);
  value.maxReviewRounds = 0;
  assert.notEqual(validateConfig(value).length, 0);
});
test("round cap has representability validation, not policy ceilings", () => {
  for (const value of [1, 10, 11, 50, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(validateOverride({ maxReviewRounds: value }), []);
  }
  for (const value of [0, -1, 1.5, "10", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.notEqual(validateOverride({ maxReviewRounds: value }).length, 0);
  }
});
test("override fields are data-only and panel replacement retains other harnesses", () => {
  for (const key of ["prompt", "instructions", "version", "strategy", "reviewers", "reviewerRetryCount"]) {
    assert.notEqual(validateOverride({ [key]: "anything" }).length, 0);
  }
  const original = config();
  const entries = [{ id: "new-id", model: "new-model", fallback: { id: "backup", model: "backup-model" } }];
  const merged = mergeConfig(original, { panels: { claude: entries } });
  assert.deepEqual(merged.panels.claude, entries);
  assert.deepEqual(merged.panels.codex, original.panels.codex);
});
test("relative path safety rejects traversal, drive names, nulls and empty components", () => {
  for (const path of ["", "..", "../outside", "/outside", "a/../b", "./a", "a//b", "a\\b", "C:/a", "a\0b", "a\nb"]) {
    assert.equal(isSafeRelativePath(path), false, path);
  }
  assert.equal(isSafeRelativePath("reviewers/whole-panel.md"), true);
});
