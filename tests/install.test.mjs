import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { install } from "../scripts/install.mjs";
import { renderAll } from "../scripts/render-agents.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const GENERATED_AGENT_SOURCE_DIRS = {
  claude: "generated/claude/agents",
  copilot: "agents",
  codex: "generated/codex/agents",
  gemini: "generated/gemini/agents",
};

const AGENT_HARNESS_DIRS = {
  claude: ".claude/agents",
  copilot: ".copilot/agents",
  codex: ".codex/agents",
  gemini: ".gemini/agents",
};

const SKILL_INSTALL_PATHS = {
  claude: (skill) => `.claude/skills/${skill}`,
  copilot: (skill) => `.copilot/skills/${skill}`,
  codex: (skill) => `.agents/skills/${skill}`,
  gemini: (skill) => `.agents/skills/${skill}`,
};

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function skillYaml() {
  return [
    "version: 1",
    "maxReviewRounds: 10",
    "reviewerRetryCount: 1",
    "documentationPolicy: impact-based",
    "taskSources:",
    "  - inline-prompt",
    "  - local-file",
    "reviewers:",
    "  - role: correctness",
    "    prompt: reviewers/correctness.md",
    "    fallbackRole: null",
    "    harnesses:",
    "      claude: correctness-reviewer",
    "      copilot: correctness-reviewer",
    "      codex: correctness-reviewer",
    "      gemini: correctness-reviewer",
    "  - role: security",
    "    prompt: reviewers/security.md",
    "    fallbackRole: null",
    "    harnesses:",
    "      claude: security-reviewer",
    "      copilot: security-reviewer",
    "      codex: security-reviewer",
    "      gemini: security-reviewer",
    "",
  ].join("\n");
}

// Same shape as skillYaml(), but with a single reviewer/harness agent name
// replaced so tests can exercise a malicious or renamed agent name without
// hand-maintaining a second full config fixture.
function skillYamlWithHarnessName(role, harness, name) {
  const marker = `      ${harness}: ${role}-reviewer`;
  const lines = skillYaml().split("\n");
  const index = lines.indexOf(marker);
  if (index === -1) {
    throw new Error(`fixture marker not found: ${marker}`);
  }
  lines[index] = `      ${harness}: ${name}`;
  return lines.join("\n");
}

function skillMarkdown({
  version = "0.1.0",
  name = "knights-of-the-round-table",
} = {}) {
  return (
    `---\nname: ${name}\n` +
    `description: "Fixture installer skill for automated tests."\n` +
    `license: MIT\n` +
    `metadata:\n  version: "${version}"\n---\n\n` +
    `# ${name}\n\nFixture skill body used only by install.mjs tests.\n`
  );
}

// Builds a minimal but fully valid `knights-of-the-round-table` project root:
// a real skill tree plus checked-in generated reviewer agents produced by the
// project's own renderer, so install.mjs can validate against real output
// without depending on (or mutating) the actual repository tree.
function createFixtureProjectRoot({
  skillVersion = "0.1.0",
  reviewersYaml = skillYaml(),
} = {}) {
  const projectRoot = tempDir("knights-install-fixture-");
  const skillDir = join(
    projectRoot,
    "skills/knights-of-the-round-table",
  );
  mkdirSync(join(skillDir, "reviewers"), { recursive: true });
  mkdirSync(join(skillDir, "config"), { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    skillMarkdown({ version: skillVersion }),
  );
  writeFileSync(join(skillDir, "config/reviewers.yaml"), reviewersYaml);
  writeFileSync(
    join(skillDir, "reviewers/correctness.md"),
    "Review requirements and edge cases only.\n",
  );
  writeFileSync(
    join(skillDir, "reviewers/security.md"),
    "Review exploitable trust-boundary risk only.\n",
  );

  const rendered = renderAll({ projectRoot });
  for (const [harness, files] of Object.entries(rendered)) {
    const directory = join(
      projectRoot,
      GENERATED_AGENT_SOURCE_DIRS[harness],
    );
    mkdirSync(directory, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      // The rendered filename is not validated here on purpose: fixtures
      // that intentionally use a path-traversal or multi-segment agent name
      // (see createTraversalFixtureProjectRoot) need this loop to plant the
      // matching bytes wherever that filename actually resolves, exactly as
      // a pre-hardening installer would read them.
      const filePath = join(directory, filename);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }
  }

  return projectRoot;
}

// Builds a project root whose reviewer config maps one harness's agent name
// to an unsafe value (path traversal, or a multi-segment path). The matching
// "generated" bytes are planted at whatever location that name resolves to,
// so the fixture proves the installer rejects the filename itself rather
// than merely failing to find a file that was never written.
function createTraversalFixtureProjectRoot({ role, harness, name }) {
  return createFixtureProjectRoot({
    reviewersYaml: skillYamlWithHarnessName(role, harness, name),
  });
}

function createGenericSkillFixture(projectRoot, name) {
  const skillDir = join(projectRoot, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillMarkdown({ name }));
  writeFileSync(join(skillDir, "NOTES.md"), "Additional fixture file.\n");
  return skillDir;
}

function readManifest(directory) {
  return JSON.parse(
    readFileSync(join(directory, ".knights-install.json"), "utf8"),
  );
}

function listEntries(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory).sort();
}

function withFixture(t, options) {
  const projectRoot = createFixtureProjectRoot(options);
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}

function withHome(t) {
  const home = tempDir("knights-install-home-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("installs the canonical skill and all harness reviewer agents", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  const result = install({
    projectRoot,
    home,
    harnesses: ["claude", "copilot", "codex", "gemini"],
  });

  assert.equal(result.skill, "knights-of-the-round-table");
  assert.equal(result.skillVersion, "0.1.0");
  assert.ok(Array.isArray(result.installedPaths));
  assert.ok(result.installedPaths.length > 0);

  for (const [harness, relativeSkillPath] of Object.entries(
    SKILL_INSTALL_PATHS,
  )) {
    const skillDir = join(home, relativeSkillPath("knights-of-the-round-table"));
    assert.equal(existsSync(join(skillDir, "SKILL.md")), true, harness);
    assert.equal(
      existsSync(join(skillDir, "config/reviewers.yaml")),
      true,
      harness,
    );
  }

  assert.equal(
    existsSync(join(home, ".claude/agents/security-reviewer.md")),
    true,
  );
  assert.equal(
    existsSync(join(home, ".copilot/agents/security-reviewer.agent.md")),
    true,
  );
  assert.equal(
    existsSync(join(home, ".codex/agents/security-reviewer.toml")),
    true,
  );
  assert.equal(
    existsSync(join(home, ".gemini/agents/security-reviewer.md")),
    true,
  );
  assert.equal(
    existsSync(join(home, ".claude/agents/correctness-reviewer.md")),
    true,
  );
});

test("deduplicates the shared codex/gemini skill install into one physical copy", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  install({ projectRoot, home, harnesses: ["codex", "gemini"] });

  const sharedDir = join(
    home,
    ".agents/skills/knights-of-the-round-table",
  );
  assert.equal(existsSync(sharedDir), true);
  const manifest = readManifest(sharedDir);
  assert.deepEqual([...manifest.harnesses].sort(), ["codex", "gemini"]);

  // Exactly one physical skill tree exists; codex and gemini are not
  // duplicated into separate directories.
  assert.equal(existsSync(join(home, ".agents/skills")), true);
  assert.deepEqual(readdirSync(join(home, ".agents/skills")), [
    "knights-of-the-round-table",
  ]);
});

test("force reinstall of one shared harness preserves the sibling harness's manifest entry", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  install({ projectRoot, home, harnesses: ["codex", "gemini"] });
  install({ projectRoot, home, harnesses: ["codex"], force: true });

  const sharedDir = join(
    home,
    ".agents/skills/knights-of-the-round-table",
  );
  const manifest = readManifest(sharedDir);
  assert.deepEqual([...manifest.harnesses].sort(), ["codex", "gemini"]);
  assert.equal(existsSync(join(sharedDir, "SKILL.md")), true);
});

test("refuses force when an owned install directory contains an untracked extra file", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  install({ projectRoot, home, harnesses: ["claude"] });
  writeFileSync(
    join(
      home,
      ".claude/skills/knights-of-the-round-table/sneaked-in.txt",
    ),
    "not tracked by the manifest\n",
  );

  assert.throws(() =>
    install({ projectRoot, home, harnesses: ["claude"], force: true }),
  );

  assert.equal(
    readFileSync(
      join(
        home,
        ".claude/skills/knights-of-the-round-table/sneaked-in.txt",
      ),
      "utf8",
    ),
    "not tracked by the manifest\n",
  );
});

test("refuses to mutate a destination whose ownership manifest is a symlink", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const externalFile = tempDir("knights-install-external-manifest-");
  writeFileSync(join(externalFile, "fake.json"), "{}\n");

  mkdirSync(
    join(home, ".claude/skills/knights-of-the-round-table"),
    { recursive: true },
  );
  symlinkSync(
    join(externalFile, "fake.json"),
    join(
      home,
      ".claude/skills/knights-of-the-round-table/.knights-install.json",
    ),
  );

  assert.throws(() =>
    install({ projectRoot, home, harnesses: ["claude"], force: true }),
  );

  assert.equal(
    lstatSync(
      join(
        home,
        ".claude/skills/knights-of-the-round-table/.knights-install.json",
      ),
    ).isSymbolicLink(),
    true,
  );
  rmSync(externalFile, { recursive: true, force: true });
});

test("manifest records schema version, source, hashes, and installed files", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  install({ projectRoot, home, harnesses: ["claude"] });

  const skillDir = join(
    home,
    ".claude/skills/knights-of-the-round-table",
  );
  const manifest = readManifest(skillDir);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.skill, "knights-of-the-round-table");
  assert.equal(manifest.skillVersion, "0.1.0");
  assert.equal(manifest.source, projectRoot);
  assert.deepEqual(manifest.harnesses, ["claude"]);
  assert.ok(Array.isArray(manifest.files));
  assert.ok(manifest.files.some((file) => file.path === "SKILL.md"));

  for (const file of manifest.files) {
    const actual = readFileSync(join(skillDir, file.path));
    assert.equal(sha256(actual), file.sha256, file.path);
  }

  const agentsDir = join(home, ".claude/agents");
  const agentsManifest = readManifest(agentsDir);
  assert.equal(agentsManifest.schemaVersion, 1);
  assert.deepEqual(agentsManifest.harnesses, ["claude"]);
  for (const file of agentsManifest.files) {
    const actual = readFileSync(join(agentsDir, file.path));
    assert.equal(sha256(actual), file.sha256, file.path);
  }
});

test("refuses an existing unowned collision without force", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  mkdirSync(
    join(home, ".claude/skills/knights-of-the-round-table"),
    { recursive: true },
  );
  writeFileSync(
    join(home, ".claude/skills/knights-of-the-round-table/unrelated.txt"),
    "not ours\n",
  );

  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"] }),
    /already exists/,
  );

  // Nothing was mutated: the unowned file is untouched and no manifest
  // or SKILL.md was written by the installer.
  assert.equal(
    readFileSync(
      join(home, ".claude/skills/knights-of-the-round-table/unrelated.txt"),
      "utf8",
    ),
    "not ours\n",
  );
  assert.equal(
    existsSync(
      join(home, ".claude/skills/knights-of-the-round-table/SKILL.md"),
    ),
    false,
  );
});

test("refuses an existing unowned collision even with force", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  mkdirSync(
    join(home, ".claude/skills/knights-of-the-round-table"),
    { recursive: true },
  );
  writeFileSync(
    join(home, ".claude/skills/knights-of-the-round-table/unrelated.txt"),
    "not ours\n",
  );

  assert.throws(() =>
    install({ projectRoot, home, harnesses: ["claude"], force: true }),
  );

  assert.equal(
    readFileSync(
      join(home, ".claude/skills/knights-of-the-round-table/unrelated.txt"),
      "utf8",
    ),
    "not ours\n",
  );
});

test("refuses an already-owned install without force", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  install({ projectRoot, home, harnesses: ["claude"] });

  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"] }),
    /already installed|already exists/,
  );
});

test("force updates an existing owned install", (t) => {
  const projectRoot = createFixtureProjectRoot();
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const home = withHome(t);

  install({ projectRoot, home, harnesses: ["claude"] });

  // Change the source skill content, then force-reinstall and confirm the
  // destination picks up the new bytes.
  writeFileSync(
    join(
      projectRoot,
      "skills/knights-of-the-round-table/reviewers/correctness.md",
    ),
    "Updated review guidance.\n",
  );
  const rendered = renderAll({ projectRoot });
  for (const [harness, files] of Object.entries(rendered)) {
    const directory = join(
      projectRoot,
      GENERATED_AGENT_SOURCE_DIRS[harness],
    );
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(directory, filename), content);
    }
  }

  install({ projectRoot, home, harnesses: ["claude"], force: true });

  assert.equal(
    readFileSync(
      join(
        home,
        ".claude/skills/knights-of-the-round-table/reviewers/correctness.md",
      ),
      "utf8",
    ),
    "Updated review guidance.\n",
  );
});

test("fails closed on force when an installed file has drifted", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  install({ projectRoot, home, harnesses: ["claude"] });

  const skillMdPath = join(
    home,
    ".claude/skills/knights-of-the-round-table/SKILL.md",
  );
  writeFileSync(skillMdPath, "tampered content\n");

  assert.throws(() =>
    install({ projectRoot, home, harnesses: ["claude"], force: true }),
  );

  // The tampered file was neither reverted nor further modified: the
  // installer refused to touch anything once drift was detected.
  assert.equal(readFileSync(skillMdPath, "utf8"), "tampered content\n");
});

test("preserves unrelated files in shared agent directories", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  mkdirSync(join(home, ".claude/agents"), { recursive: true });
  writeFileSync(
    join(home, ".claude/agents/unrelated-agent.md"),
    "not managed by knights\n",
  );

  install({ projectRoot, home, harnesses: ["claude"] });

  assert.equal(
    readFileSync(join(home, ".claude/agents/unrelated-agent.md"), "utf8"),
    "not managed by knights\n",
  );
  assert.equal(
    existsSync(join(home, ".claude/agents/security-reviewer.md")),
    true,
  );
});

test("refuses an unmanaged agent file collision even with force", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  mkdirSync(join(home, ".claude/agents"), { recursive: true });
  writeFileSync(
    join(home, ".claude/agents/security-reviewer.md"),
    "not managed by knights\n",
  );

  assert.throws(() =>
    install({ projectRoot, home, harnesses: ["claude"], force: true }),
  );

  assert.equal(
    readFileSync(join(home, ".claude/agents/security-reviewer.md"), "utf8"),
    "not managed by knights\n",
  );
});

// Gap 1: manifest association is not validated. A manifest that is
// shape-valid (right types, right schema version) but was copied or forged
// from another skill or another physical harness group must not be treated
// as proof of ownership over *this* target -- not even with --force. These
// tests hand-craft such a manifest directly (no `install()` call produced
// it) to prove the installer authenticates *context*, not just shape.
test("refuses a skill-install manifest whose skill or harnesses don't match this target, even with force, without mutating anything", (t) => {
  const projectRoot = withFixture(t);
  const fileContent = "forged skill md\n";
  const fileHash = sha256(Buffer.from(fileContent));

  const scenarios = [
    { label: "wrong skill", skill: "some-other-skill", harnesses: ["claude"] },
    {
      label: "harness outside this physical group",
      skill: "knights-of-the-round-table",
      harnesses: ["codex"],
    },
    {
      label: "duplicate harness values",
      skill: "knights-of-the-round-table",
      harnesses: ["claude", "claude"],
    },
    {
      label: "unknown harness value",
      skill: "knights-of-the-round-table",
      harnesses: ["banana"],
    },
  ];

  for (const scenario of scenarios) {
    const home = withHome(t);
    const targetDir = join(
      home,
      ".claude/skills/knights-of-the-round-table",
    );
    const forgedManifest = {
      schemaVersion: 1,
      installer: "knights-install",
      skill: scenario.skill,
      skillVersion: "0.1.0",
      source: "/fake/source",
      harnesses: scenario.harnesses,
      files: [{ path: "SKILL.md", sha256: fileHash }],
    };
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "SKILL.md"), fileContent);
    writeFileSync(
      join(targetDir, ".knights-install.json"),
      `${JSON.stringify(forgedManifest, null, 2)}\n`,
    );

    assert.throws(
      () =>
        install({ projectRoot, home, harnesses: ["claude"], force: true }),
      /ownership manifest/i,
      scenario.label,
    );

    assert.equal(
      readFileSync(join(targetDir, "SKILL.md"), "utf8"),
      fileContent,
      `${scenario.label}: forged file must be untouched`,
    );
    assert.deepEqual(
      readManifest(targetDir),
      forgedManifest,
      `${scenario.label}: forged manifest must be untouched`,
    );
  }
});

test("refuses an agent-directory manifest whose skill or harness don't match this target, even with force, without mutating anything", (t) => {
  const projectRoot = withFixture(t);
  const fileContent = "---\nname: forged\n---\nforged agent body\n";
  const fileHash = sha256(Buffer.from(fileContent));

  const scenarios = [
    { label: "wrong skill", skill: "some-other-skill", harnesses: ["claude"] },
    {
      label: "harness not exactly this agent directory's harness",
      skill: "knights-of-the-round-table",
      harnesses: ["codex"],
    },
    {
      label: "more than the exact single harness",
      skill: "knights-of-the-round-table",
      harnesses: ["claude", "codex"],
    },
  ];

  for (const scenario of scenarios) {
    const home = withHome(t);
    const targetDir = join(home, ".claude/agents");
    const forgedManifest = {
      schemaVersion: 1,
      installer: "knights-install",
      skill: scenario.skill,
      skillVersion: "0.1.0",
      source: "/fake/source",
      harnesses: scenario.harnesses,
      files: [{ path: "security-reviewer.md", sha256: fileHash }],
    };
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "security-reviewer.md"), fileContent);
    writeFileSync(
      join(targetDir, ".knights-install.json"),
      `${JSON.stringify(forgedManifest, null, 2)}\n`,
    );

    assert.throws(
      () =>
        install({ projectRoot, home, harnesses: ["claude"], force: true }),
      /ownership manifest/i,
      scenario.label,
    );

    assert.equal(
      readFileSync(join(targetDir, "security-reviewer.md"), "utf8"),
      fileContent,
      `${scenario.label}: forged file must be untouched`,
    );
    assert.deepEqual(
      readManifest(targetDir),
      forgedManifest,
      `${scenario.label}: forged manifest must be untouched`,
    );
  }
});

test("refuses an agent-directory manifest with duplicate file paths, even with force, without mutating anything", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const targetDir = join(home, ".claude/agents");
  const fileContent = "---\nname: forged\n---\nforged agent body\n";
  const fileHash = sha256(Buffer.from(fileContent));

  const forgedManifest = {
    schemaVersion: 1,
    installer: "knights-install",
    skill: "knights-of-the-round-table",
    skillVersion: "0.1.0",
    source: "/fake/source",
    harnesses: ["claude"],
    files: [
      { path: "security-reviewer.md", sha256: fileHash },
      { path: "security-reviewer.md", sha256: fileHash },
    ],
  };
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "security-reviewer.md"), fileContent);
  writeFileSync(
    join(targetDir, ".knights-install.json"),
    `${JSON.stringify(forgedManifest, null, 2)}\n`,
  );

  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"], force: true }),
    /ownership manifest/i,
  );

  assert.equal(
    readFileSync(join(targetDir, "security-reviewer.md"), "utf8"),
    fileContent,
  );
  assert.deepEqual(readManifest(targetDir), forgedManifest);
});

// Rewrites the checked-in generated/<harness>/agents directory to match the
// project's current reviewer config, removing any file that is no longer
// part of the rendered set. Mirrors what a real repository update (a role
// rename, a config edit) looks like from install.mjs's point of view.
function resyncGeneratedAgentSourceDir(projectRoot, harness) {
  const directory = join(projectRoot, GENERATED_AGENT_SOURCE_DIRS[harness]);
  for (const existingFilename of readdirSync(directory)) {
    rmSync(join(directory, existingFilename), { force: true });
  }
  const rendered = renderAll({ projectRoot });
  for (const [filename, content] of Object.entries(rendered[harness])) {
    writeFileSync(join(directory, filename), content);
  }
}

test("force update removes a stale owned agent file, preserves unrelated files, and allows re-adding the freed name", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({ projectRoot, home, harnesses: ["claude"] });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "unrelated-agent.md"),
    "not managed by knights\n",
  );

  // Rename the security reviewer's claude agent: the old name drops out of
  // the rendered set entirely.
  writeFileSync(
    join(
      projectRoot,
      "skills/knights-of-the-round-table/config/reviewers.yaml",
    ),
    skillYamlWithHarnessName("security", "claude", "security-reviewer-v2"),
  );
  resyncGeneratedAgentSourceDir(projectRoot, "claude");

  install({ projectRoot, home, harnesses: ["claude"], force: true });

  assert.equal(
    existsSync(join(agentsDir, "security-reviewer.md")),
    false,
    "stale owned agent file must be removed",
  );
  assert.equal(
    existsSync(join(agentsDir, "security-reviewer-v2.md")),
    true,
    "renamed agent file must be installed",
  );
  assert.equal(
    existsSync(join(agentsDir, "correctness-reviewer.md")),
    true,
    "unrelated owned agent file must remain",
  );
  assert.equal(
    readFileSync(join(agentsDir, "unrelated-agent.md"), "utf8"),
    "not managed by knights\n",
    "unrelated unmanaged file must remain untouched",
  );

  const manifest = readManifest(agentsDir);
  assert.deepEqual(
    manifest.files.map((file) => file.path).sort(),
    ["correctness-reviewer.md", "security-reviewer-v2.md"],
    "manifest must not still list the stale removed file",
  );

  // Renaming back to the original name must succeed: the stale file was
  // actually deleted rather than merely dropped from the manifest, so it
  // is not an unmanaged collision blocking re-installation.
  writeFileSync(
    join(
      projectRoot,
      "skills/knights-of-the-round-table/config/reviewers.yaml",
    ),
    skillYaml(),
  );
  resyncGeneratedAgentSourceDir(projectRoot, "claude");

  install({ projectRoot, home, harnesses: ["claude"], force: true });

  assert.equal(existsSync(join(agentsDir, "security-reviewer.md")), true);
  assert.equal(
    existsSync(join(agentsDir, "security-reviewer-v2.md")),
    false,
  );
  assert.equal(
    readFileSync(join(agentsDir, "unrelated-agent.md"), "utf8"),
    "not managed by knights\n",
  );
});

// Gap 2: no-force partial-owned agent install. If the skill directory and
// every owned agent payload file are removed by hand but the valid,
// correctly-scoped agent manifest survives, that manifest alone still
// proves a prior install happened here -- so a reinstall without --force
// must refuse exactly as it would if the files were still present, and
// --force recovery must still work.
test("refuses a no-force reinstall when only the owned agent manifest remains after the skill dir and payload files are removed by hand", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  install({ projectRoot, home, harnesses: ["claude"] });

  const skillDir = join(home, ".claude/skills/knights-of-the-round-table");
  const agentsDir = join(home, ".claude/agents");
  const agentManifestBefore = readManifest(agentsDir);

  // Remove the skill install entirely, and every owned agent payload file,
  // but leave the agent directory's ownership manifest untouched.
  rmSync(skillDir, { recursive: true, force: true });
  for (const file of agentManifestBefore.files) {
    rmSync(join(agentsDir, file.path), { force: true });
  }
  assert.equal(existsSync(skillDir), false, "precondition");
  for (const file of agentManifestBefore.files) {
    assert.equal(
      existsSync(join(agentsDir, file.path)),
      false,
      `precondition: ${file.path}`,
    );
  }

  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"] }),
    /already installed/i,
  );

  // Nothing changed: the skill dir is still absent, the agent manifest is
  // exactly as it was, and no payload file was recreated.
  assert.equal(existsSync(skillDir), false);
  assert.deepEqual(readManifest(agentsDir), agentManifestBefore);
  for (const file of agentManifestBefore.files) {
    assert.equal(existsSync(join(agentsDir, file.path)), false, file.path);
  }

  // --force recovery remains possible.
  install({ projectRoot, home, harnesses: ["claude"], force: true });
  assert.equal(existsSync(join(skillDir, "SKILL.md")), true);
  for (const file of agentManifestBefore.files) {
    assert.equal(existsSync(join(agentsDir, file.path)), true, file.path);
  }
});

test("invalid source (missing version metadata) leaves home unmodified", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  writeFileSync(
    join(projectRoot, "skills/knights-of-the-round-table/SKILL.md"),
    "---\nname: knights-of-the-round-table\ndescription: \"No version.\"\nlicense: MIT\n---\n\nBody.\n",
  );

  assert.throws(() =>
    install({ projectRoot, home, harnesses: ["claude"] }),
  );

  assert.deepEqual(listEntries(home), []);
});

test("invalid source (drifted generated agent) leaves home unmodified", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  writeFileSync(
    join(projectRoot, "generated/claude/agents/security-reviewer.md"),
    "tampered generated agent\n",
  );

  assert.throws(() =>
    install({ projectRoot, home, harnesses: ["claude"] }),
  );

  assert.deepEqual(listEntries(home), []);
});

test("invalid source (symlinked skill file) leaves home unmodified", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const externalFile = tempDir("knights-install-external-file-");
  writeFileSync(join(externalFile, "leak.txt"), "leak\n");

  symlinkSync(
    join(externalFile, "leak.txt"),
    join(
      projectRoot,
      "skills/knights-of-the-round-table/reviewers/leak.md",
    ),
  );

  assert.throws(() =>
    install({ projectRoot, home, harnesses: ["claude"] }),
  );

  assert.deepEqual(listEntries(home), []);
  rmSync(externalFile, { recursive: true, force: true });
});

// Gap 3: generated-agent source directory symlink. `validateGeneratedAgents`
// lstat-checks the final generated agent *files* but never checked whether
// the directory that contains them is itself a symlink. If
// `<projectRoot>/generated/claude/agents` is replaced with a directory
// symlink pointing outside the project root, every per-file lstat/hash
// check downstream still passes (the files at the far end are real,
// regular files with valid content) while silently reading from outside
// the project root -- before any destination mutation.
test("rejects a symlinked generated-agent source directory before any destination mutation, without mutating the external directory", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const external = tempDir("knights-install-external-generated-");
  t.after(() => rmSync(external, { recursive: true, force: true }));

  const sourceDir = join(projectRoot, "generated/claude/agents");
  const movedDir = join(external, "agents");
  // Move the *valid* generated agent directory outside the fixture...
  cpSync(sourceDir, movedDir, { recursive: true });
  rmSync(sourceDir, { recursive: true, force: true });
  // ...and replace it with a directory symlink pointing there.
  symlinkSync(movedDir, sourceDir);

  const externalEntriesBefore = readdirSync(movedDir).sort();

  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"] }),
    /symlink/i,
  );

  assert.deepEqual(listEntries(home), []);
  assert.equal(lstatSync(sourceDir).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(movedDir).sort(), externalEntriesBefore);
});

test("rejects a reviewer agent name that escapes its harness directory before any destination mutation", (t) => {
  // Reviewer config only requires harness agent names to be non-empty
  // strings, so a malicious or corrupted config could set one to a
  // traversal sequence. install.mjs must reject every rendered agent
  // filename unless it is a safe single path component with the harness's
  // expected extension, resolving with dirname exactly equal to the
  // intended directory -- mirroring render-agents.mjs's own invariant --
  // and it must do so during source validation, before any destination
  // (home) mutation.
  const cases = [
    // Exact traversal example from the report: escapes all the way past
    // the home directory fixture itself, onto the shared filesystem.
    { harness: "claude", name: "../../../pwned", filename: "../../../pwned.md" },
    // Exact traversal example from the report: escapes the harness's own
    // agent directory but stays inside home.
    { harness: "codex", name: "../config", filename: "../config.toml" },
    // Not a traversal, but still not a single path component.
    { harness: "gemini", name: "nested/escape", filename: "nested/escape.md" },
  ];

  for (const { harness, name, filename } of cases) {
    const projectRoot = createTraversalFixtureProjectRoot({
      role: "correctness",
      harness,
      name,
    });
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
    // Use a dedicated container per case (rather than tempDir()'s home
    // directly under tmpdir()) so that even the worst-case traversal
    // filename ("../../../pwned.md") resolves to a path inside this
    // disposable container instead of a shared location like tmpdir()
    // itself. That lets cleanup remove only the container, never an
    // unconditionally-computed path outside of it.
    const container = tempDir("knights-install-traversal-");
    t.after(() => rmSync(container, { recursive: true, force: true }));
    const home = join(container, "home");
    mkdirSync(home, { recursive: true });
    const escapeTarget = resolve(join(home, AGENT_HARNESS_DIRS[harness]), filename);

    assert.ok(
      escapeTarget === container || escapeTarget.startsWith(container + sep),
      `${harness} ${name}: escape target must stay inside the disposable container`,
    );
    assert.equal(existsSync(escapeTarget), false, `${harness} ${name}: precondition`);

    assert.throws(
      () => install({ projectRoot, home, harnesses: [harness] }),
      /unsafe/i,
      `${harness} ${name}: should refuse to install`,
    );

    assert.equal(
      existsSync(escapeTarget),
      false,
      `${harness} ${name}: no external file was written`,
    );
    assert.deepEqual(
      listEntries(home),
      [],
      `${harness} ${name}: home directory left untouched`,
    );
  }
});

test("symlink escape causes no external write and no selected-destination mutation", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const external = tempDir("knights-install-external-");
  t.after(() => rmSync(external, { recursive: true, force: true }));

  symlinkSync(external, join(home, ".claude"));

  assert.throws(() =>
    install({
      projectRoot,
      home,
      harnesses: ["claude", "copilot"],
    }),
  );

  assert.equal(existsSync(join(external, "skills")), false);
  assert.equal(lstatSync(join(home, ".claude")).isSymbolicLink(), true);
  assert.equal(existsSync(join(home, ".copilot")), false);
});

test("a collision in one selected harness prevents mutation of every harness", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  mkdirSync(
    join(home, ".copilot/skills/knights-of-the-round-table"),
    { recursive: true },
  );
  writeFileSync(
    join(home, ".copilot/skills/knights-of-the-round-table/unrelated.txt"),
    "not ours\n",
  );

  assert.throws(() =>
    install({
      projectRoot,
      home,
      harnesses: ["claude", "copilot"],
    }),
  );

  assert.equal(existsSync(join(home, ".claude")), false);
  assert.deepEqual(
    readdirSync(
      join(home, ".copilot/skills/knights-of-the-round-table"),
    ),
    ["unrelated.txt"],
  );
});

test("rejects a traversal skill name before any destination mutation", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  assert.throws(() =>
    install({
      projectRoot,
      home,
      skill: "../../etc",
      harnesses: ["claude"],
    }),
  );
  assert.throws(() =>
    install({
      projectRoot,
      home,
      skill: "/etc/passwd",
      harnesses: ["claude"],
    }),
  );
  assert.throws(() =>
    install({
      projectRoot,
      home,
      skill: "..",
      harnesses: ["claude"],
    }),
  );

  assert.deepEqual(listEntries(home), []);
});

test("rejects an unknown skill name before any destination mutation", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "not-a-real-skill",
        harnesses: ["claude"],
      }),
    /unknown skill/i,
  );

  assert.deepEqual(listEntries(home), []);
});

test("installs a non-canonical skill without copying reviewer agents", (t) => {
  const projectRoot = withFixture(t);
  createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });

  assert.equal(
    existsSync(join(home, ".claude/skills/other-skill/SKILL.md")),
    true,
  );
  assert.equal(
    existsSync(join(home, ".claude/skills/other-skill/NOTES.md")),
    true,
  );
  assert.equal(existsSync(join(home, ".claude/agents")), false);
});

test("rejects a source skill containing a top-level reserved manifest filename before any destination mutation", (t) => {
  const projectRoot = withFixture(t);
  const skillDir = createGenericSkillFixture(projectRoot, "other-skill");
  writeFileSync(
    join(skillDir, ".knights-install.json"),
    JSON.stringify({ bogus: "payload" }),
  );
  const home = withHome(t);

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
      }),
    /reserved/i,
  );

  assert.deepEqual(listEntries(home), []);
});

test("CLI installs the canonical skill from the repository for a single harness", (t) => {
  const home = withHome(t);

  const outcome = spawnSync(
    process.execPath,
    [
      "scripts/install.mjs",
      "--skill",
      "knights-of-the-round-table",
      "--harness",
      "claude",
      "--home",
      home,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(
    existsSync(
      join(home, ".claude/skills/knights-of-the-round-table/SKILL.md"),
    ),
    true,
  );
  assert.equal(
    existsSync(join(home, ".claude/agents/security-reviewer.md")),
    true,
  );
  assert.ok(outcome.stdout.includes(home));
});

test("CLI fails clearly on an unknown harness without mutating the home directory", (t) => {
  const home = withHome(t);

  const outcome = spawnSync(
    process.execPath,
    [
      "scripts/install.mjs",
      "--harness",
      "bogus",
      "--home",
      home,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /harness/i);
  assert.deepEqual(listEntries(home), []);
});

test("CLI fails clearly on a missing flag value", (t) => {
  const home = withHome(t);

  const outcome = spawnSync(
    process.execPath,
    ["scripts/install.mjs", "--harness", "claude", "--home"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /--home/);
  assert.deepEqual(listEntries(home), []);
});

test("CLI fails clearly on a duplicate flag", (t) => {
  const home = withHome(t);

  const outcome = spawnSync(
    process.execPath,
    [
      "scripts/install.mjs",
      "--harness",
      "claude",
      "--home",
      home,
      "--home",
      home,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /duplicate/i);
});

test("CLI fails clearly on an unknown argument", (t) => {
  const home = withHome(t);

  const outcome = spawnSync(
    process.execPath,
    ["scripts/install.mjs", "--bogus", "--home", home],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /--bogus/);
});

test("CLI requires an explicit --harness selection", (t) => {
  const home = withHome(t);

  const outcome = spawnSync(
    process.execPath,
    ["scripts/install.mjs", "--home", home],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /harness/i);
  assert.deepEqual(listEntries(home), []);
});

test("CLI accepts --harness all and --force", (t) => {
  const home = withHome(t);

  const first = spawnSync(
    process.execPath,
    [
      "scripts/install.mjs",
      "--skill",
      "knights-of-the-round-table",
      "--harness",
      "all",
      "--home",
      home,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(first.status, 0, first.stderr);

  const second = spawnSync(
    process.execPath,
    [
      "scripts/install.mjs",
      "--skill",
      "knights-of-the-round-table",
      "--harness",
      "all",
      "--home",
      home,
      "--force",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(second.status, 0, second.stderr);

  for (const relativeSkillPath of Object.values(SKILL_INSTALL_PATHS)) {
    assert.equal(
      existsSync(
        join(home, relativeSkillPath("knights-of-the-round-table"), "SKILL.md"),
      ),
      true,
    );
  }
});

test("install() rejects an empty home instead of retargeting to the current directory", (t) => {
  const projectRoot = withFixture(t);
  // install() runs in this test process, so an empty home would resolve
  // relative to the runner's own cwd (the repository root) if it were not
  // rejected. Snapshot rather than assume-and-delete: this proves nothing
  // was created without ever assuming ".claude" was absent beforehand, and
  // never mutates or removes preexisting repository content.
  const claudeDirExistedBefore = existsSync(join(repositoryRoot, ".claude"));

  assert.throws(
    () =>
      install({
        projectRoot,
        home: "",
        harnesses: ["claude"],
      }),
    /home/i,
  );

  assert.equal(existsSync(join(repositoryRoot, ".claude")), claudeDirExistedBefore);
});

test("install() rejects a whitespace-only home instead of retargeting to the current directory", (t) => {
  const projectRoot = withFixture(t);
  const claudeDirExistedBefore = existsSync(join(repositoryRoot, ".claude"));

  assert.throws(
    () =>
      install({
        projectRoot,
        home: "   ",
        harnesses: ["claude"],
      }),
    /home/i,
  );

  assert.equal(existsSync(join(repositoryRoot, ".claude")), claudeDirExistedBefore);
});

test("CLI fails clearly on an empty --home value without mutating the current directory", (t) => {
  // Run with cwd set to a disposable sandbox (never the repository root)
  // so the assertion and cleanup only ever touch throwaway paths.
  const sandbox = tempDir("knights-install-cli-empty-home-");
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const outcome = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts/install.mjs"), "--harness", "claude", "--home", ""],
    { cwd: sandbox, encoding: "utf8" },
  );

  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /home/i);
  assert.equal(existsSync(join(sandbox, ".claude")), false);
});

test("CLI fails clearly on a whitespace-only --home value without mutating the current directory", (t) => {
  const sandbox = tempDir("knights-install-cli-whitespace-home-");
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const outcome = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts/install.mjs"), "--harness", "claude", "--home", "   "],
    { cwd: sandbox, encoding: "utf8" },
  );

  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /home/i);
  assert.equal(existsSync(join(sandbox, ".claude")), false);
});
