import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolvePanel } from "../skills/knights-of-the-round-table/scripts/harness.mjs";
import { loadEffectiveConfig } from "../skills/knights-of-the-round-table/scripts/validate-config.mjs";

const root = new URL("..", import.meta.url).pathname;
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "knights-native-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") } };
}
function installed(command) { return spawnSync(command, ["--version"], { encoding: "utf8", timeout: 15000 }).status === 0; }

test("installed Claude native validator accepts explicit agents and rejects directory-valued agents", t => {
  if (!installed("claude")) return t.skip("Claude CLI is not installed; native validation not exercised");
  const { home, env } = fixture(t);
  const run = path => spawnSync("claude", ["plugin", "validate", path, "--json"], { env, cwd: home, encoding: "utf8", timeout: 20000 });
  const valid = run(join(root, ".claude-plugin/plugin.json"));
  assert.equal(valid.status, 0, valid.stderr + valid.stdout);
  assert.equal(JSON.parse(valid.stdout).success, true);
  const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  const panel = resolvePanel(loadEffectiveConfig({ repositoryRoot: root }), "claude", { mode: "plugin", pluginName: manifest.name });
  assert.deepEqual(manifest.agents.slice().sort(), panel.map(r => `./generated/claude/agents/${r.id}.md`).sort());
  // Claude Agent SDK's initialize control message enumerates real dispatch IDs.
  // No user message is sent, so no inference is requested. `plugin details` in
  // 2.1.261 undercounts explicit file-list agents; the dispatch registry does not.
  const initialized = spawnSync("claude", [
    "--plugin-dir", root, "--print", "--input-format", "stream-json",
    "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--strict-mcp-config",
  ], {
    env, cwd: home, encoding: "utf8", timeout: 20000,
    input: JSON.stringify({ type: "control_request", request_id: "discovery", request: { subtype: "initialize", hooks: {} } }) + "\n",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const response = initialized.stdout.trim().split("\n").map(line => JSON.parse(line))
    .find(message => message.type === "control_response" && message.response?.request_id === "discovery");
  const discovered = response?.response?.response?.agents;
  assert.ok(Array.isArray(discovered), "native initialization must enumerate agents");
  for (const entry of panel) {
    assert.equal(discovered.find(agent => agent.name === entry.invocationId)?.model, entry.model);
  }
  mkdirSync(join(home, ".claude-plugin"), { recursive: true });
  writeFileSync(join(home, ".claude-plugin/plugin.json"), JSON.stringify({ ...manifest, agents: "./generated/claude/agents/" }));
  const invalid = run(join(home, ".claude-plugin/plugin.json"));
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).success, false);
});

test("installed Copilot discovers the plugin in an isolated home without installation or model requests", t => {
  if (!installed("copilot")) return t.skip("Copilot CLI is not installed; native discovery not exercised");
  const { home, env } = fixture(t);
  const result = spawnSync("copilot", ["--plugin-dir", root, "plugin", "list"], { env, cwd: home, encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const pluginName = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")).name;
  assert.ok(result.stdout.includes(pluginName));
  const panel = resolvePanel(loadEffectiveConfig({ repositoryRoot: root }), "copilot", { mode: "plugin", pluginName });
  for (const r of panel) {
    assert.equal(r.invocationId, `${pluginName}:${r.id}`);
    assert.ok(readFileSync(join(root, `agents/${r.id}.agent.md`), "utf8").includes(`model: "${r.model}"`));
  }
  // Native plugin list exposes plugin names, not per-agent execution metadata.
  // This assertion deliberately does not claim live per-agent/model execution.
});

test("installed Gemini loader parses exact models and local IDs without inference", async t => {
  const located = spawnSync("which", ["gemini"], { encoding: "utf8" });
  if (located.status !== 0) return t.skip("Gemini CLI not installed");
  const executable = realpathSync(located.stdout.trim());
  const bundle = dirname(executable);
  let candidates;
  try { candidates = readdirSync(bundle).filter(name => /^core-.*\.js$/.test(name)); }
  catch { return t.skip("Installed Gemini layout does not expose its loader"); }
  let loader;
  for (const candidate of candidates) {
    const module = await import(pathToFileURL(join(bundle, candidate)));
    if (module.loadAgentsFromDirectory) { loader = module.loadAgentsFromDirectory; break; }
  }
  if (!loader) return t.skip("Installed Gemini does not export loadAgentsFromDirectory");
  const { home } = fixture(t);
  cpSync(join(root, "generated/gemini/agents"), join(home, "agents"), { recursive: true });
  const result = await loader(join(home, "agents"));
  assert.deepEqual(result.errors, []);
  const entries = loadEffectiveConfig({ repositoryRoot: root }).panels.gemini;
  for (const entry of entries) {
    const agent = result.agents.find(a => a.name === entry.id);
    assert.ok(agent, entry.id);
    assert.equal(agent.modelConfig.model, entry.model);
  }
});
