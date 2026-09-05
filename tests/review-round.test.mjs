import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateRound as wrapper } from "../scripts/review-round.mjs";
import { evaluateRound, preflight, resolvePanel } from "../skills/knights-of-the-round-table/scripts/review-round.mjs";
import { parseYamlDocument } from "../skills/knights-of-the-round-table/scripts/parse-yaml.mjs";
const config = () => parseYamlDocument(readFileSync(new URL("../skills/knights-of-the-round-table/config/reviewers.yaml", import.meta.url), "utf8"));
test("root wrapper delegates to the canonical evaluator", () => assert.equal(wrapper, evaluateRound));
test("runtime invocation IDs distinguish plugin agents from local IDs and Codex companion roles", () => {
  const cfg = config();
  for (const host of ["claude", "copilot"]) {
    const plugin = resolvePanel(cfg, host, { mode: "plugin", pluginName: "knights-of-the-round-table" });
    const standalone = resolvePanel(cfg, host);
    assert.equal(plugin[0].invocationId, `knights-of-the-round-table:${plugin[0].id}`);
    assert.equal(standalone[0].invocationId, standalone[0].id);
  }
  assert.equal(resolvePanel(cfg, "codex", { mode: "plugin", pluginName: "knights-of-the-round-table" })[0].invocationId, "knights-sol");
  assert.throws(() => resolvePanel(cfg, "antigravity"), /unsupported/);
  assert.throws(() => resolvePanel(cfg, "gemini", { mode: "plugin", pluginName: "x" }), /standalone/);
  assert.throws(() => resolvePanel(cfg, "copilot", { mode: "plugin" }), /plugin-name/);
});
test("preflight blocks missing companions, unverified models, incorrect discovery and implicit substitution", () => {
  const cfg = config(), opts = { mode: "plugin", pluginName: "knights-of-the-round-table" };
  const inventory = {
    harness: "codex", ...opts, readOnly: true, independent: true, modelSelectionVerified: true,
    companionAgentsInstalled: true, agents: cfg.panels.codex.map(r => ({ id: r.id, model: r.model, available: true })),
  };
  assert.equal(preflight(cfg, "codex", opts, inventory).length, 2);
  for (const mutate of [
    i => i.companionAgentsInstalled = false, i => i.modelSelectionVerified = false,
    i => i.independent = false, i => i.readOnly = false, i => i.agents.pop(),
    i => i.agents[0].model = "cheaper", i => i.agents[0].id = "wrong:knights-sol",
    i => i.mode = "standalone", i => i.harness = "gemini",
  ]) {
    const bad = structuredClone(inventory); mutate(bad);
    assert.throws(() => preflight(cfg, "codex", opts, bad));
  }
  cfg.panels.codex[0].fallback = { id: "backup", model: "backup-model" };
  inventory.agents[0] = { id: "backup", model: "backup-model", available: true };
  const selected = preflight(cfg, "codex", opts, inventory)[0];
  assert.equal(selected.selected.model, "backup-model");
  assert.match(selected.selected.reason, /unavailable/);
});
test("CLI errors on missing, unknown, duplicate and incomplete options", () => {
  const script = new URL("../scripts/review-round.mjs", import.meta.url).pathname;
  for (const args of [[], ["garbage"], ["snapshot"], ["panel", "--repo", "."], ["panel", "--repo", ".", "--harness"], ["snapshot", "--repo", ".", "--repo", "."], ["evaluate", "/missing", "--repo", ".", "--harness", "copilot", "--mode", "standalone"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "");
  }
  assert.equal(spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" }).status, 0);
});
