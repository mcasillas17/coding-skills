import { assertValidConfig, DIMENSIONS, HARNESSES } from "./validate-config.mjs";

export function resolvePanel(config, harness, { mode = "standalone", pluginName } = {}) {
  assertValidConfig(config);
  if (harness === "antigravity") throw new Error("Native Antigravity is unsupported: use the separately verified Gemini CLI integration, not Gemini syntax in Antigravity");
  if (!HARNESSES.includes(harness)) throw new Error(`unsupported harness: ${harness}`);
  if (!["standalone", "plugin"].includes(mode)) throw new Error("mode must be standalone or plugin");
  if (mode === "plugin" && harness === "gemini") throw new Error("Gemini CLI uses standalone companion agents; no native plugin adapter");
  if (mode === "plugin" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginName ?? "")) throw new Error("plugin mode requires the discovered plugin-name");
  const invocation = id => mode === "plugin" && ["claude", "copilot"].includes(harness) ? `${pluginName}:${id}` : id;
  return config.panels[harness].map(entry => ({
    id: entry.id, model: entry.model, effort: config.reasoningEffort, invocationId: invocation(entry.id), coverage: [...DIMENSIONS],
    fallback: entry.fallback ? { ...entry.fallback, effort: config.reasoningEffort, invocationId: invocation(entry.fallback.id) } : null,
  }));
}

// Inventory is host/operator evidence, not something task text may assert.
// Model availability must be checked on the executing account at invocation time.
export function preflight(config, harness, options, inventory) {
  const panel = resolvePanel(config, harness, options);
  if (!inventory || inventory.harness !== harness || inventory.mode !== options.mode ||
      (options.mode === "plugin" && inventory.pluginName !== options.pluginName)) {
    throw new Error("preflight requires current host inventory for this harness, mode and plugin");
  }
  if (harness === "codex" && inventory.companionAgentsInstalled !== true) {
    throw new Error("Codex plugin does not register agents. Run node scripts/install.mjs --harness codex from the source package, then restart Codex and verify companion discovery");
  }
  if (inventory.readOnly !== true || inventory.independent !== true || inventory.modelSelectionVerified !== true ||
      !Array.isArray(inventory.agents)) throw new Error("host must attest independent read-only agents and verified model selection with an agents inventory");
  return panel.map(reviewer => {
    const available = target => inventory.agents.some(agent => agent.id === target.invocationId && agent.model === target.model && agent.available === true);
    if (available(reviewer)) return { ...reviewer, selected: { id: reviewer.invocationId, model: reviewer.model } };
    if (reviewer.fallback && available(reviewer.fallback)) return {
      ...reviewer, selected: { id: reviewer.fallback.invocationId, model: reviewer.fallback.model, reason: "Requested reviewer unavailable in current host inventory" },
    };
    throw new Error(`Unavailable reviewer ${reviewer.invocationId} (${reviewer.model}); verify host discovery/model access or configure an explicit fallback in .knights-of-the-round-table.yaml`);
  });
}
