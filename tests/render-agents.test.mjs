import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { renderAll } from "../scripts/render-agents.mjs";

const repositoryRoot = new URL("..", import.meta.url);
const harnessDirectories = {
  claude: "generated/claude/agents",
  copilot: "agents",
  codex: "generated/codex/agents",
  gemini: "generated/gemini/agents",
};

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
    config: {
      reviewers: [
        {
          role: "correctness",
          prompt: "reviewers/correctness.md",
          harnesses: {
            claude: 'quoted: "reviewer"',
            copilot: 'quoted: "reviewer"',
            codex: 'quoted: "reviewer"',
            gemini: 'quoted: "reviewer"',
          },
        },
      ],
    },
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
