import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as renderer from "../scripts/render-agents.mjs";

const { renderAll } = renderer;

const repositoryRoot = new URL("..", import.meta.url);
const harnessDirectories = {
  claude: "generated/claude/agents",
  copilot: "agents",
  codex: "generated/codex/agents",
  gemini: "generated/gemini/agents",
};

function validConfig(overrides = {}) {
  return {
    version: 2,
    strategy: "whole_panel",
    maxReviewRounds: 10,
    reviewerRetryCount: 1,
    documentationPolicy: "impact-based",
    taskSources: ["inline-prompt", "local-file"],
    prompt: "reviewers/whole-panel.md",
    panels: Object.fromEntries(Object.keys(harnessDirectories).map((harness) =>
      [harness, [{ id: "correctness-reviewer", model: "explicit-model", fallback: null }]])),
    ...overrides,
  };
}

function createRendererProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), "reviewer-renderer-"));
  const promptDirectory = join(
    projectRoot,
    "skills/knights-of-the-round-table/reviewers",
  );
  mkdirSync(promptDirectory, { recursive: true });
  writeFileSync(join(promptDirectory, "whole-panel.md"), "Review only.");
  mkdirSync(join(projectRoot, ".claude-plugin"));
  cpSync(new URL("../.claude-plugin/plugin.json", import.meta.url),
    join(projectRoot, ".claude-plugin/plugin.json"));
  return projectRoot;
}

function removeRendererProject(projectRoot) {
  rmSync(projectRoot, { recursive: true, force: true });
}

function createRendererCliProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), "reviewer-renderer-cli-"));
  const fixturePaths = [
    ".claude-plugin/plugin.json",
    "scripts/render-agents.mjs",
    "scripts/is-main-module.mjs",
    "skills/knights-of-the-round-table/scripts/parse-yaml.mjs",
    "skills/knights-of-the-round-table/scripts/validate-config.mjs",
    "skills/knights-of-the-round-table/config",
    "skills/knights-of-the-round-table/reviewers",
  ];

  for (const relativePath of fixturePaths) {
    const destination = join(projectRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(
      new URL(`../${relativePath}`, import.meta.url),
      destination,
      { recursive: true },
    );
  }
  return projectRoot;
}

function checkedInUrl(harness, relativePath) {
  return new URL(
    `../${harnessDirectories[harness]}/${relativePath}`,
    import.meta.url,
  );
}

function checkedInGeneratedSnapshot() {
  const rendered = renderAll();
  const snapshot = {};
  for (const [harness, files] of Object.entries(rendered)) {
    for (const relativePath of Object.keys(files)) {
      const ownedPath = `${harnessDirectories[harness]}/${relativePath}`;
      snapshot[ownedPath] = readFileSync(
        checkedInUrl(harness, relativePath),
        "utf8",
      );
    }
  }
  snapshot[".generated-agents.json"] = readFileSync(
    new URL("../.generated-agents.json", import.meta.url),
    "utf8",
  );
  return snapshot;
}

function runRenderer(projectRoot, ...args) {
  return spawnSync(
    process.execPath,
    [join(projectRoot, "scripts/render-agents.mjs"), ...args],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  );
}

function embeddedPrompt(harness, content) {
  if (harness !== "codex") {
    return content;
  }

  const match = /^developer_instructions = (.+)$/m.exec(content);
  assert.ok(match, "Codex agent must define developer_instructions");
  return JSON.parse(match[1]);
}

test("renderer produces one whole-panel agent per model with explicit native controls", () => {
  const config = validConfig();
  config.panels.copilot.push({ id: "another-model", model: "model-two", fallback: null });
  const prompt = "Review all six dimensions.\nLine \"two\"\\three";
  const rendered = renderer.renderAgents(config, { [config.prompt]: prompt });
  assert.deepEqual(Object.keys(rendered), Object.keys(harnessDirectories));
  for (const [harness, entries] of Object.entries(config.panels)) {
    assert.equal(Object.keys(rendered[harness]).length, entries.length);
    for (const { id, model } of entries) {
      const filename = `${id}${harness === "codex" ? ".toml" : harness === "copilot" ? ".agent.md" : ".md"}`;
      const content = rendered[harness][filename];
      assert.ok(content, `${harness} uses the local ID as filename`);
      const separator = harness === "codex" ? " = " : ": ";
      assert.ok(content.includes(`name${separator}${JSON.stringify(id)}`));
      assert.ok(content.includes(`model${separator}${JSON.stringify(model)}`));
      assert.ok(embeddedPrompt(harness, content).includes(prompt));
      assert.doesNotMatch(content, /model(?::| = )["']?inherit/);
    }
  }
});

test("all generated reviewers preserve the shared prompt without per-role rewriting", () => {
  const rendered = renderAll();
  const config = JSON.parse(JSON.stringify(
    renderer.renderRepositoryAgents().skills[0].config,
  ));
  const expected = readFileSync(new URL(`../skills/knights-of-the-round-table/${config.prompt}`, import.meta.url), "utf8").trimEnd();
  for (const [harness, files] of Object.entries(rendered)) {
    for (const content of Object.values(files)) {
      const prompt = embeddedPrompt(harness, content);
      assert.ok(prompt.includes(expected), `${harness} retains the complete shared prompt`);
    }
  }
});

test("harness adapters declare only read-only tools and safely escaped metadata", () => {
  const rendered = renderAll();

  for (const content of Object.values(rendered.copilot)) {
    assert.match(content, /tools: \[read, search\]/);
    assert.match(content, /user-invocable: false/);
  }
  for (const content of Object.values(rendered.claude)) {
    assert.match(content, /tools: Read, Grep, Glob/);
    assert.match(content, /model: "[^"]+"/);
  }
  for (const content of Object.values(rendered.codex)) {
    assert.match(content, /sandbox_mode = "read-only"/);
    assert.match(content, /developer_instructions = "/);
  }
  for (const content of Object.values(rendered.gemini)) {
    for (const tool of [
      "read_file",
      "grep_search",
      "glob",
      "list_directory",
    ]) {
      assert.match(content, new RegExp(`  - ${tool}`));
    }
    assert.match(content, /model: "[^"]+"/);
  }

  const escaped = renderAll({
    config: validConfig(),
    prompts: {
      "reviewers/whole-panel.md": "Line one\nLine \"two\"\\three",
    },
  });

  assert.match(
    escaped.codex["correctness-reviewer.toml"],
    /developer_instructions = "Line one\\nLine \\"two\\"\\\\three"/,
  );
});

test("checked-in generated agents match renderer output", () => {
  const rendered = renderAll();

  for (const [harness, files] of Object.entries(rendered)) {
    for (const [relativePath, expected] of Object.entries(files)) {
      assert.equal(
        readFileSync(checkedInUrl(harness, relativePath), "utf8"),
        expected,
      );
    }
  }
});

test("renderer output is deterministic", () => {
  assert.deepEqual(renderAll(), renderAll());
});

test("renderer check CLI runs correctly when invoked through a symlinked script path", () => {
  const directory = mkdtempSync(join(tmpdir(), "renderer-symlink-"));
  const realScriptPath = fileURLToPath(
    new URL("../scripts/render-agents.mjs", import.meta.url),
  );
  const linkPath = join(directory, "render-agents-link.mjs");
  symlinkSync(realScriptPath, linkPath);

  try {
    const result = spawnSync(process.execPath, [linkPath, "--check"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "Generated reviewer agents are current.");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("renderer rejects conflicting primary and fallback IDs instead of overwriting", () => {
  const config = validConfig();
  config.panels.claude[0].fallback = { id: "correctness-reviewer", model: "different-model" };
  assert.throws(
    () => renderer.renderAgents(config, { [config.prompt]: "Shared prompt." }),
    /conflict.*claude.*correctness-reviewer/i,
  );
});

test("renderer renders configured fallbacks once and deduplicates identical ID/model pairs", () => {
  const config = validConfig();
  config.panels.claude = [
    { id: "primary", model: "primary-model", fallback: { id: "backup", model: "backup-model" } },
    { id: "second", model: "second-model", fallback: { id: "backup", model: "backup-model" } },
    { id: "backup", model: "backup-model", fallback: null },
  ];
  const rendered = renderer.renderAgents(config, { [config.prompt]: "Shared prompt." });
  assert.deepEqual(Object.keys(rendered.claude), ["primary.md", "backup.md", "second.md"]);
  assert.match(rendered.claude["backup.md"], /model: "backup-model"/);
  assert.ok(Object.values(rendered.claude).every((content) => content.includes("Shared prompt.")));
});

test("renderer allows unrestricted nonempty panel sizes without inventing inherited models", () => {
  const config = validConfig();
  config.panels.gemini = Array.from({ length: 23 }, (_, index) =>
    ({ id: `reviewer-${index}`, model: `model-${index}`, fallback: null }));
  assert.equal(Object.keys(renderer.renderAgents(config, { [config.prompt]: "Review." }).gemini).length, 23);
});

test("invalid empty reviewer config performs no writes or deletions", () => {
  const projectRoot = createRendererProject();
  const agentsDirectory = join(projectRoot, "agents");
  const manualPath = join(agentsDirectory, "manual.agent.md");
  const stalePath = join(agentsDirectory, "stale.agent.md");
  const manifestPath = join(projectRoot, ".generated-agents.json");
  const manifest = `${JSON.stringify(
    { version: 1, files: ["agents/stale.agent.md"] },
    null,
    2,
  )}\n`;
  mkdirSync(agentsDirectory, { recursive: true });
  writeFileSync(manualPath, "Hand-authored.");
  writeFileSync(stalePath, "Previously generated.");
  writeFileSync(manifestPath, manifest);

  try {
    assert.throws(
      () =>
        renderer.synchronizeGeneratedAgents({
          projectRoot,
          config: validConfig({ panels: { ...validConfig().panels, claude: [] } }),
        }),
      /claude.*non-empty array/,
    );
    assert.equal(readFileSync(manualPath, "utf8"), "Hand-authored.");
    assert.equal(readFileSync(stalePath, "utf8"), "Previously generated.");
    assert.equal(readFileSync(manifestPath, "utf8"), manifest);
    assert.deepEqual(readdirSync(agentsDirectory).sort(), [
      "manual.agent.md",
      "stale.agent.md",
    ]);
  } finally {
    removeRendererProject(projectRoot);
  }
});

test("renderer rejects traversal prompts before attempting to read them", () => {
  const projectRoot = createRendererProject();
  const config = validConfig();
  config.prompt = "../outside.md";

  try {
    assert.throws(
      () => renderAll({ projectRoot, config }),
      /prompt must be a safe relative path/,
    );
  } finally {
    removeRendererProject(projectRoot);
  }
});

test("renderer preserves unowned agent files and records generated ownership", () => {
  const projectRoot = createRendererProject();
  const manualPath = join(projectRoot, "agents/manual.agent.md");
  mkdirSync(join(projectRoot, "agents"), { recursive: true });
  writeFileSync(manualPath, "Hand-authored.");

  try {
    const result = renderer.synchronizeGeneratedAgents({
      projectRoot,
      config: validConfig(),
    });

    assert.equal(result.fileCount, 4);
    assert.equal(readFileSync(manualPath, "utf8"), "Hand-authored.");
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, ".generated-agents.json"), "utf8"),
    );
    assert.deepEqual(manifest, {
      version: 1,
      files: [
        "agents/correctness-reviewer.agent.md",
        "generated/claude/agents/correctness-reviewer.md",
        "generated/codex/agents/correctness-reviewer.toml",
        "generated/gemini/agents/correctness-reviewer.md",
      ],
    });
  } finally {
    removeRendererProject(projectRoot);
  }
});

test("renderer rejects a symlinked output file before modifying any targets", () => {
  const projectRoot = createRendererProject();
  const externalRoot = mkdtempSync(
    join(tmpdir(), "reviewer-renderer-external-"),
  );
  const externalPath = join(externalRoot, "outside.agent.md");
  const linkedPath = join(
    projectRoot,
    "agents/correctness-reviewer.agent.md",
  );
  const preservedPath = join(
    projectRoot,
    "generated/claude/agents/correctness-reviewer.md",
  );
  const checkedInBefore = checkedInGeneratedSnapshot();
  mkdirSync(join(projectRoot, "agents"), { recursive: true });
  mkdirSync(join(projectRoot, "generated/claude/agents"), {
    recursive: true,
  });
  writeFileSync(externalPath, "External target.");
  writeFileSync(preservedPath, "Preserve existing output.");
  symlinkSync(externalPath, linkedPath);

  try {
    assert.throws(
      () =>
        renderer.synchronizeGeneratedAgents({
          projectRoot,
          config: validConfig(),
        }),
      /generated output target must not be a symlink: agents\/correctness-reviewer\.agent\.md/i,
    );
    assert.equal(readFileSync(externalPath, "utf8"), "External target.");
    assert.equal(readFileSync(preservedPath, "utf8"), "Preserve existing output.");
    assert.equal(lstatSync(linkedPath).isSymbolicLink(), true);
    assert.deepEqual(checkedInGeneratedSnapshot(), checkedInBefore);
  } finally {
    removeRendererProject(projectRoot);
    removeRendererProject(externalRoot);
  }
});

test("renderer rejects non-regular output targets before modifying files", () => {
  const projectRoot = createRendererProject();
  const targetPath = join(
    projectRoot,
    "agents/correctness-reviewer.agent.md",
  );
  const earlierPath = join(
    projectRoot,
    "generated/claude/agents/correctness-reviewer.md",
  );
  mkdirSync(targetPath, { recursive: true });

  try {
    assert.throws(
      () =>
        renderer.synchronizeGeneratedAgents({
          projectRoot,
          config: validConfig(),
        }),
      /generated output target must be a regular file: agents\/correctness-reviewer\.agent\.md/i,
    );
    assert.equal(existsSync(earlierPath), false);
    assert.equal(lstatSync(targetPath).isDirectory(), true);
  } finally {
    removeRendererProject(projectRoot);
  }
});

test("renderer rejects a symlinked harness directory before modifying any targets", () => {
  const projectRoot = createRendererProject();
  const externalRoot = mkdtempSync(
    join(tmpdir(), "reviewer-renderer-external-"),
  );
  const externalSentinel = join(externalRoot, "sentinel.txt");
  const externalOutput = join(
    externalRoot,
    "correctness-reviewer.agent.md",
  );
  const earlierPath = join(
    projectRoot,
    "generated/claude/agents/correctness-reviewer.md",
  );
  const checkedInBefore = checkedInGeneratedSnapshot();
  writeFileSync(externalSentinel, "External directory.");
  symlinkSync(externalRoot, join(projectRoot, "agents"), "dir");

  try {
    assert.throws(
      () =>
        renderer.synchronizeGeneratedAgents({
          projectRoot,
          config: validConfig(),
        }),
      /harness output directory must not be a symlink: agents/i,
    );
    assert.equal(readFileSync(externalSentinel, "utf8"), "External directory.");
    assert.equal(existsSync(externalOutput), false);
    assert.equal(existsSync(earlierPath), false);
    assert.deepEqual(checkedInGeneratedSnapshot(), checkedInBefore);
  } finally {
    removeRendererProject(projectRoot);
    removeRendererProject(externalRoot);
  }
});

test("renderer rejects a symlinked ownership manifest before reading targets", () => {
  const projectRoot = createRendererProject();
  const externalRoot = mkdtempSync(
    join(tmpdir(), "reviewer-renderer-external-"),
  );
  const externalSentinel = join(externalRoot, "sentinel.txt");
  const earlierPath = join(
    projectRoot,
    "generated/claude/agents/correctness-reviewer.md",
  );
  const checkedInBefore = checkedInGeneratedSnapshot();
  writeFileSync(externalSentinel, "External directory.");
  symlinkSync(externalRoot, join(projectRoot, ".generated-agents.json"), "dir");

  try {
    assert.throws(
      () =>
        renderer.synchronizeGeneratedAgents({
          projectRoot,
          config: validConfig(),
        }),
      /ownership manifest target must not be a symlink: \.generated-agents\.json/i,
    );
    assert.equal(readFileSync(externalSentinel, "utf8"), "External directory.");
    assert.deepEqual(readdirSync(externalRoot), ["sentinel.txt"]);
    assert.equal(existsSync(earlierPath), false);
    assert.deepEqual(checkedInGeneratedSnapshot(), checkedInBefore);
  } finally {
    removeRendererProject(projectRoot);
    removeRendererProject(externalRoot);
  }
});

test("renderer safely removes an owned stale symlink without touching its target", () => {
  const projectRoot = createRendererProject();
  const externalRoot = mkdtempSync(
    join(tmpdir(), "reviewer-renderer-external-"),
  );
  const externalPath = join(externalRoot, "outside.agent.md");
  const stalePath = join(projectRoot, "agents/stale.agent.md");
  mkdirSync(join(projectRoot, "agents"), { recursive: true });
  writeFileSync(externalPath, "External target.");
  symlinkSync(externalPath, stalePath);
  writeFileSync(
    join(projectRoot, ".generated-agents.json"),
    `${JSON.stringify(
      { version: 1, files: ["agents/stale.agent.md"] },
      null,
      2,
    )}\n`,
  );

  try {
    renderer.synchronizeGeneratedAgents({
      projectRoot,
      config: validConfig(),
    });

    assert.equal(existsSync(stalePath), false);
    assert.equal(readFileSync(externalPath, "utf8"), "External target.");
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, ".generated-agents.json"), "utf8"),
    );
    assert.deepEqual(manifest.files, [
      "agents/correctness-reviewer.agent.md",
      "generated/claude/agents/correctness-reviewer.md",
      "generated/codex/agents/correctness-reviewer.toml",
      "generated/gemini/agents/correctness-reviewer.md",
    ]);
  } finally {
    removeRendererProject(projectRoot);
    removeRendererProject(externalRoot);
  }
});

test("check mode reports missing and stale owned outputs without modifying files", () => {
  const projectRoot = createRendererProject();

  try {
    renderer.synchronizeGeneratedAgents({
      projectRoot,
      config: validConfig(),
    });
    const missingPath = join(
      projectRoot,
      "agents/correctness-reviewer.agent.md",
    );
    const stalePath = join(projectRoot, "agents/stale.agent.md");
    const manifestPath = join(projectRoot, ".generated-agents.json");
    unlinkSync(missingPath);
    writeFileSync(stalePath, "Stale generated output.");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files.push("agents/stale.agent.md");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const beforeManifest = readFileSync(manifestPath, "utf8");

    const result = renderer.synchronizeGeneratedAgents({
      projectRoot,
      config: validConfig(),
      check: true,
    });

    assert.deepEqual(result.drift, [
      ".generated-agents.json",
      "agents/correctness-reviewer.agent.md",
      "agents/stale.agent.md",
    ]);
    assert.equal(existsSync(missingPath), false);
    assert.equal(readFileSync(stalePath, "utf8"), "Stale generated output.");
    assert.equal(readFileSync(manifestPath, "utf8"), beforeManifest);
  } finally {
    removeRendererProject(projectRoot);
  }
});

test("check mode succeeds when current and fails when a generated file drifts", () => {
  const projectRoot = createRendererCliProject();
  const checkedInBefore = checkedInGeneratedSnapshot();

  try {
    renderer.synchronizeGeneratedAgents({ projectRoot });
    const current = runRenderer(projectRoot, "--check");
    assert.equal(current.status, 0, current.stderr);
    assert.equal(
      current.stdout.trim(),
      "Generated reviewer agents are current.",
    );
    assert.equal(current.stderr, "");

    const rendered = renderAll({ projectRoot });
    const [relativePath, expected] = Object.entries(rendered.copilot)[0];
    const generatedPath = join(
      projectRoot,
      harnessDirectories.copilot,
      relativePath,
    );
    writeFileSync(generatedPath, `${expected}\n`);

    const drifted = runRenderer(projectRoot, "--check");
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /Generated reviewer agents are out of date:/);
    assert.match(drifted.stderr, new RegExp(`agents/${relativePath}`));
    assert.equal(drifted.stdout, "");
    assert.deepEqual(
      checkedInGeneratedSnapshot(),
      checkedInBefore,
      "renderer drift checks must not mutate checked-in generated agents",
    );
  } finally {
    removeRendererProject(projectRoot);
  }
});

test("CLI detects and repairs manifest-only drift while preserving unrelated plugin fields", (t) => {
  const projectRoot = createRendererCliProject();
  t.after(() => removeRendererProject(projectRoot));
  renderer.synchronizeGeneratedAgents({ projectRoot });
  const path = join(projectRoot, ".claude-plugin/plugin.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const expectedAgents = manifest.agents;
  const unrelated = { ...manifest, author: { name: "Fixture" }, custom: { nested: [1, true] } };
  delete unrelated.agents;
  writeFileSync(path, JSON.stringify({ ...unrelated, agents: [] }));
  const before = readFileSync(path, "utf8");

  const drifted = runRenderer(projectRoot, "--check");
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /\.claude-plugin\/plugin\.json/);
  assert.equal(readFileSync(path, "utf8"), before);
  const repaired = runRenderer(projectRoot);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...unrelated, agents: expectedAgents });
  assert.equal(runRenderer(projectRoot, "--check").status, 0);
});

for (const target of ["file symlink", "directory symlink", "directory", "invalid JSON", "array", "null", "missing"]) {
  test(`renderer rejects unsafe Claude manifest (${target}) before writes in both modes`, (t) => {
    const projectRoot = createRendererProject();
    const externalRoot = createRendererProject();
    t.after(() => removeRendererProject(projectRoot));
    t.after(() => removeRendererProject(externalRoot));
    const path = join(projectRoot, ".claude-plugin/plugin.json");
    const externalPath = join(externalRoot, ".claude-plugin/plugin.json");
    const before = readFileSync(externalPath, "utf8");
    if (target === "directory symlink") {
      rmSync(join(projectRoot, ".claude-plugin"), { recursive: true });
      symlinkSync(join(externalRoot, ".claude-plugin"), join(projectRoot, ".claude-plugin"));
    } else {
      unlinkSync(path);
      if (target === "file symlink") symlinkSync(externalPath, path);
      if (target === "directory") mkdirSync(path);
      if (target === "invalid JSON") writeFileSync(path, "{");
      if (target === "array") writeFileSync(path, "[]");
      if (target === "null") writeFileSync(path, "null");
    }
    for (const check of [true, false]) {
      assert.throws(() => renderer.synchronizeGeneratedAgents({
        projectRoot, config: validConfig(), check,
      }), /symlink|regular file|JSON|object|ENOENT/);
      assert.equal(existsSync(join(projectRoot, "agents")), false);
      assert.equal(existsSync(join(projectRoot, ".generated-agents.json")), false);
      assert.equal(readFileSync(externalPath, "utf8"), before);
    }
  });
}

test("renderer refuses an unowned output collision before changing the Claude manifest", (t) => {
  const projectRoot = createRendererProject();
  t.after(() => removeRendererProject(projectRoot));
  const path = join(projectRoot, "generated/claude/agents/correctness-reviewer.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "Hand-authored agent.");
  const manifestPath = join(projectRoot, ".claude-plugin/plugin.json");
  const before = readFileSync(manifestPath, "utf8");
  assert.throws(() => renderer.synchronizeGeneratedAgents({
    projectRoot, config: validConfig(),
  }), /unowned/i);
  assert.equal(readFileSync(path, "utf8"), "Hand-authored agent.");
  assert.equal(readFileSync(manifestPath, "utf8"), before);
  assert.equal(existsSync(join(projectRoot, ".generated-agents.json")), false);
});
