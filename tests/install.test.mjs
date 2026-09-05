import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
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
import { join } from "node:path";
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
function createFixtureProjectRoot({ skillVersion = "0.1.0" } = {}) {
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
  writeFileSync(join(skillDir, "config/reviewers.yaml"), skillYaml());
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
      writeFileSync(join(directory, filename), content);
    }
  }

  return projectRoot;
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
