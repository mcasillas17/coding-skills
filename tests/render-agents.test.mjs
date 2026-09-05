import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function harnessNames(name) {
  return {
    claude: name,
    copilot: name,
    codex: name,
    gemini: name,
  };
}

function validConfig(overrides = {}) {
  return {
    version: 1,
    maxReviewRounds: 10,
    reviewerRetryCount: 1,
    documentationPolicy: "impact-based",
    taskSources: ["inline-prompt", "local-file"],
    reviewers: [
      {
        role: "correctness",
        prompt: "reviewers/correctness.md",
        fallbackRole: null,
        harnesses: harnessNames("correctness-reviewer"),
      },
    ],
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
  writeFileSync(join(promptDirectory, "correctness.md"), "Review only.");
  return projectRoot;
}

function removeRendererProject(projectRoot) {
  rmSync(projectRoot, { recursive: true, force: true });
}

function checkedInUrl(harness, relativePath) {
  return new URL(
    `../${harnessDirectories[harness]}/${relativePath}`,
    import.meta.url,
  );
}

function runRenderer(...args) {
  return spawnSync(
    process.execPath,
    ["scripts/render-agents.mjs", ...args],
    {
      cwd: repositoryRoot,
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

test("renderer produces six reviewers for every harness", () => {
  const rendered = renderAll();

  assert.deepEqual(Object.keys(rendered), [
    "claude",
    "copilot",
    "codex",
    "gemini",
  ]);
  for (const [harness, files] of Object.entries(rendered)) {
    assert.equal(
      Object.keys(files).length,
      6,
      `${harness} should contain six reviewers`,
    );
  }
});

test("all generated reviewers preserve the JSON contract and read-only constraints", () => {
  const rendered = renderAll();

  for (const [harness, files] of Object.entries(rendered)) {
    for (const content of Object.values(files)) {
      const prompt = embeddedPrompt(harness, content);
      assert.match(prompt, /Review only\. Do not edit files/);
      assert.match(prompt, /evidence-backed actionable findings/i);
      assert.match(prompt, /Do not report formatting preferences/);
      assert.match(prompt, /Return JSON only\./);
      assert.match(prompt, /"reviewer"/);
      assert.match(prompt, /"findings"/);
      assert.match(prompt, /"id": "finding:<stable-slug>"/);
      assert.match(prompt, /"severity": "critical\|high\|medium\|low"/);
      assert.match(prompt, /"confidence": 1/);
      assert.match(prompt, /"file": "relative\/path"/);
      assert.match(prompt, /"line": 1/);
      assert.match(prompt, /"title": "Short finding"/);
      assert.match(prompt, /"evidence": "Concrete evidence"/);
      assert.match(prompt, /"recommendation": "Specific actionable fix"/);
      assert.match(prompt, /"status": "open"/);
      assert.match(prompt, /same stable finding ID across reviewer roles/i);
      assert.match(prompt, /confidence.*integer from 1 through 10/i);
      assert.match(prompt, /empty `findings` array/);
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
    assert.match(content, /model: inherit/);
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
    assert.match(content, /model: inherit/);
  }

  const escaped = renderAll({
    config: validConfig({
      reviewers: [
        {
          role: "correctness",
          prompt: "reviewers/correctness.md",
          fallbackRole: null,
          harnesses: {
            claude: 'quoted: "reviewer"',
            copilot: 'quoted: "reviewer"',
            codex: 'quoted: "reviewer"',
            gemini: 'quoted: "reviewer"',
          },
        },
      ],
    }),
    prompts: {
      "reviewers/correctness.md": "Line one\nLine \"two\"\\three",
    },
  });

  assert.match(escaped.copilot['quoted: "reviewer".agent.md'], /name: "quoted: \\"reviewer\\""/);
  assert.match(escaped.claude['quoted: "reviewer".md'], /name: "quoted: \\"reviewer\\""/);
  assert.match(escaped.gemini['quoted: "reviewer".md'], /name: "quoted: \\"reviewer\\""/);
  assert.match(
    escaped.codex['quoted: "reviewer".toml'],
    /name = "quoted: \\"reviewer\\""/,
  );
  assert.match(
    escaped.codex['quoted: "reviewer".toml'],
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

test("renderer rejects duplicate output filenames instead of overwriting", () => {
  const config = validConfig({
    reviewers: [
      {
        role: "correctness",
        prompt: "reviewers/correctness.md",
        fallbackRole: null,
        harnesses: harnessNames("shared-reviewer"),
      },
      {
        role: "tests",
        prompt: "reviewers/tests.md",
        fallbackRole: "correctness",
        harnesses: harnessNames("shared-reviewer"),
      },
    ],
  });

  assert.throws(
    () =>
      renderer.renderAgents(config, {
        "reviewers/correctness.md": "Correctness prompt.",
        "reviewers/tests.md": "Tests prompt.",
      }),
    /duplicate output filename for claude: shared-reviewer\.md/,
  );
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
          config: { reviewers: [] },
        }),
      /reviewers must be a non-empty array/,
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
  config.reviewers[0].prompt = "../outside.md";

  try {
    assert.throws(
      () => renderAll({ projectRoot, config }),
      /reviewers\[0\] prompt must be a safe relative path/,
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
  const current = runRenderer("--check");
  assert.equal(current.status, 0, current.stderr);
  assert.equal(
    current.stdout.trim(),
    "Generated reviewer agents are current.",
  );
  assert.equal(current.stderr, "");

  const rendered = renderAll();
  const [relativePath, expected] = Object.entries(rendered.copilot)[0];
  const generatedUrl = checkedInUrl("copilot", relativePath);

  try {
    writeFileSync(generatedUrl, `${expected}\n`);
    const drifted = runRenderer("--check");
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /Generated reviewer agents are out of date:/);
    assert.match(drifted.stderr, new RegExp(`agents/${relativePath}`));
    assert.equal(drifted.stdout, "");
  } finally {
    writeFileSync(generatedUrl, expected);
  }
});
