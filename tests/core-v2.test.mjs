import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseYamlDocument } from "../skills/knights-of-the-round-table/scripts/parse-yaml.mjs";
import { validateConfig, mergeConfig } from "../skills/knights-of-the-round-table/scripts/validate-config.mjs";
import { evaluateRound } from "../scripts/review-round.mjs";

const config = () => parseYamlDocument(readFileSync(new URL("../skills/knights-of-the-round-table/config/reviewers.yaml", import.meta.url), "utf8"));
test("defaults are precisely the requested model panels, not six inherited role agents", () => {
  const value = config();
  assert.equal(value.strategy, "whole_panel");
  assert.deepEqual(Object.fromEntries(Object.entries(value.panels).map(([host, entries]) => [host, entries.map(e => e.model)])), {
    copilot: ["grok-4.6", "gemini-3.8-flash", "gpt-6-astra", "claude-opus-4.8"],
    claude: ["claude-opus-5", "sonnet", "haiku"],
    codex: ["gpt-5.6-sol", "gpt-5.6-terra"],
    gemini: ["gemini-3.7-flash", "gemini-3.1-pro"],
  });
});
test("repository can replace an entire panel and raise the cap", () => {
  const merged = mergeConfig(config(), { maxReviewRounds: 25, panels: { copilot: [{ id: "custom", model: "chosen-model", fallback: null }] } });
  assert.equal(merged.maxReviewRounds, 25);
  assert.equal(merged.panels.copilot.length, 1);
  assert.deepEqual(validateConfig(merged), []);
});
test("repository may configure more than sixteen reviewers", () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: `reviewer-${i}`, model: `model-${i}`, fallback: null }));
  assert.equal(mergeConfig(config(), { panels: { codex: entries } }).panels.codex.length, 20);
});
test("a round cannot declare its own panel and certify convergence without independent context", () => {
  assert.throws(() => evaluateRound({
    round: 1, maxRounds: 10, requiredReviewers: ["one"],
    results: [{ reviewer: "one", status: "completed", findings: [] }],
  }), /context|config|snapshot/i);
});
