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
    copilot: ["grok-4.7", "gemini-3.8-flash", "gpt-6.1-sol", "claude-opus-5.5"],
    claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
    codex: ["gpt-6-astra", "gpt-6.1-sol", "gpt-5.5"],
    gemini: ["gemini-3.8-flash", "gemini-3.1-pro-preview"],
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
test("every reviewer requests high reasoning effort, natively where the agent format allows", async () => {
  const value = config();
  assert.equal(value.reasoningEffort, "high");
  const { resolvePanel } = await import("../skills/knights-of-the-round-table/scripts/harness.mjs");
  for (const harness of Object.keys(value.panels)) {
    for (const reviewer of resolvePanel(value, harness)) assert.equal(reviewer.effort, "high");
  }
  const { renderAgents } = await import("../scripts/render-agents.mjs");
  const rendered = renderAgents(value, { [value.prompt]: "Review." });
  for (const file of Object.values(rendered.claude)) assert.match(file, /^effort: high$/m);
  for (const file of Object.values(rendered.codex)) assert.match(file, /^model_reasoning_effort = "high"$/m);
  // Copilot agent profiles and Gemini CLI's strict agent schema have no effort field.
  for (const file of [...Object.values(rendered.copilot), ...Object.values(rendered.gemini)]) assert.doesNotMatch(file, /effort/);
});
test("reasoning effort must be a supported level and is not repository-overridable", () => {
  for (const reasoningEffort of [undefined, "extreme", "", 3]) {
    const value = { ...config(), reasoningEffort };
    if (reasoningEffort === undefined) delete value.reasoningEffort;
    assert.ok(validateConfig(value).includes("reasoningEffort must be one of low, medium, high, xhigh, max"), String(reasoningEffort));
  }
  assert.throws(() => mergeConfig(config(), { reasoningEffort: "low" }), /unknown key: reasoningEffort/);
});
