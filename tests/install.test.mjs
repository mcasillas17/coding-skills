import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { install } from "../scripts/install.mjs";
import { renderAll } from "../scripts/render-agents.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const TRANSACTION_FILENAME = ".knights-install.transaction.json";

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

function readTransactionManifest(directory) {
  return JSON.parse(
    readFileSync(join(directory, TRANSACTION_FILENAME), "utf8"),
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

function skillStageNames(directory, skill) {
  const escapedSkill = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stagePattern = new RegExp(
    `^\\.${escapedSkill}\\.knights-stage-[1-9]\\d*-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$`,
  );
  return listEntries(directory).filter((entry) => stagePattern.test(entry));
}

function skillJournalNames(directory, skill) {
  const fixedName = `.${skill}.knights-swap.json`;
  const recoveryPrefix = `.${skill}.knights-swap.recovering-`;
  return listEntries(directory).filter(
    (entry) => entry === fixedName || entry.startsWith(recoveryPrefix),
  );
}

function runHardExitSkillInstall({
  projectRoot,
  home,
  phase,
  force = false,
  exitCode,
}) {
  const options = {
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  };
  if (force) {
    options.force = true;
  }
  const script = [
    `import { install } from ${JSON.stringify(
      pathToFileURL(join(repositoryRoot, "scripts/install.mjs")).href,
    )};`,
    `const options = ${JSON.stringify(options)};`,
    "install({",
    "  ...options,",
    "  onInstallEvent({ phase }) {",
    `    if (phase === ${JSON.stringify(phase)}) process.exit(${exitCode});`,
    "  },",
    "});",
    "",
  ].join("\n");
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

function runHardExitAfterSkillStageCreation({
  projectRoot,
  home,
  exitCode,
}) {
  const options = {
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  };
  const script = [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'import { basename } from "node:path";',
    "const originalMkdirSync = fs.mkdirSync;",
    "fs.mkdirSync = function patchedMkdirSync(path, ...args) {",
    "  const result = originalMkdirSync.call(this, path, ...args);",
    '  if (basename(String(path)).startsWith(".other-skill.knights-stage-")) {',
    `    process.exit(${exitCode});`,
    "  }",
    "  return result;",
    "};",
    "syncBuiltinESMExports();",
    `const { install } = await import(${JSON.stringify(
      pathToFileURL(join(repositoryRoot, "scripts/install.mjs")).href,
    )});`,
    `install(${JSON.stringify(options)});`,
    "",
  ].join("\n");
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
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

for (const [selected, sibling] of [["codex", "gemini"], ["gemini", "codex"]]) {
  test(`updating ${selected} also updates its installed shared ${sibling} agents`, (t) => {
    const projectRoot = withFixture(t);
    const home = withHome(t);
    install({ projectRoot, home, harnesses: ["claude", "codex", "gemini"] });
    const untouchedSkillDir = join(home, ".claude/skills/knights-of-the-round-table");
    const untouchedManifest = readFileSync(join(untouchedSkillDir, ".knights-install.json"));
    const untouchedAgentsManifest = readFileSync(join(home, ".claude/agents/.knights-install.json"));
    const siblingDir = join(home, AGENT_HARNESS_DIRS[sibling]);
    writeFileSync(join(siblingDir, "unrelated.txt"), "leave this alone\n");
    writeFileSync(
      join(projectRoot, "skills/knights-of-the-round-table/config/reviewers.yaml"),
      skillYamlWithHarnessName("security", sibling, "security-reviewer-v2"),
    );
    resyncGeneratedAgentSourceDir(projectRoot, sibling);
    const expectedAgents = renderAll({ projectRoot })[sibling];
    const expectedConfig = readFileSync(
      join(projectRoot, "skills/knights-of-the-round-table/config/reviewers.yaml"),
    );

    const result = install({
      projectRoot, home, harnesses: [selected], force: true,
      onInstallEvent({ phase }) {
        if (phase === "source-validated") {
          writeFileSync(
            join(projectRoot, "skills/knights-of-the-round-table/config/reviewers.yaml"),
            skillYamlWithHarnessName("security", sibling, "security-reviewer-v3"),
          );
        }
      },
    });

    for (const [filename, content] of Object.entries(expectedAgents)) {
      assert.equal(readFileSync(join(siblingDir, filename), "utf8"), content);
    }
    assert.deepEqual(result.harnesses, ["codex", "gemini"]);
    assert.deepEqual(
      readFileSync(join(home, ".agents/skills/knights-of-the-round-table/config/reviewers.yaml")),
      expectedConfig,
    );
    const staleFilename = sibling === "codex" ? "security-reviewer.toml" : "security-reviewer.md";
    assert.equal(existsSync(join(siblingDir, staleFilename)), false);
    assert.deepEqual(
      readManifest(siblingDir).files.map((file) => file.path).sort(),
      Object.keys(expectedAgents).sort(),
    );
    assert.equal(readFileSync(join(siblingDir, "unrelated.txt"), "utf8"), "leave this alone\n");
    assert.deepEqual(readFileSync(join(untouchedSkillDir, ".knights-install.json")), untouchedManifest);
    assert.deepEqual(readFileSync(join(home, ".claude/agents/.knights-install.json")), untouchedAgentsManifest);
    for (const directory of [untouchedSkillDir, join(home, ".claude/agents")]) {
      for (const file of readManifest(directory).files) {
        assert.equal(sha256(readFileSync(join(directory, file.path))), file.sha256);
      }
    }
    assert.equal(existsSync(join(home, ".copilot")), false);
  });
}

for (const problem of ["invalid source", "unmanaged collision", "owned drift"]) {
  test(`shared sibling ${problem} blocks all selected destinations before mutation`, (t) => {
    const projectRoot = withFixture(t);
    const home = withHome(t);
    install({ projectRoot, home, harnesses: ["codex", "gemini"] });
    const sharedDir = join(home, ".agents/skills/knights-of-the-round-table");
    const priorConfig = readFileSync(join(sharedDir, "config/reviewers.yaml"));
    const priorManifest = readFileSync(join(sharedDir, ".knights-install.json"));
    const codexManifest = readFileSync(join(home, ".codex/agents/.knights-install.json"));
    const geminiDir = join(home, ".gemini/agents");
    writeFileSync(
      join(projectRoot, "skills/knights-of-the-round-table/config/reviewers.yaml"),
      skillYamlWithHarnessName("security", "gemini", "security-reviewer-v2"),
    );
    resyncGeneratedAgentSourceDir(projectRoot, "gemini");
    const changedPath = problem === "invalid source"
      ? join(projectRoot, "generated/gemini/agents/security-reviewer-v2.md")
      : join(geminiDir, problem === "unmanaged collision" ? "security-reviewer-v2.md" : "security-reviewer.md");
    writeFileSync(changedPath, "not installer-owned content\n");

    assert.throws(
      () => install({ projectRoot, home, harnesses: ["claude", "codex"], force: true }),
      /out of date|unmanaged|drift/i,
    );
    assert.equal(existsSync(join(home, ".claude")), false);
    assert.deepEqual(readFileSync(join(sharedDir, "config/reviewers.yaml")), priorConfig);
    assert.deepEqual(readFileSync(join(sharedDir, ".knights-install.json")), priorManifest);
    assert.deepEqual(readFileSync(join(home, ".codex/agents/.knights-install.json")), codexManifest);
    assert.equal(readFileSync(changedPath, "utf8"), "not installer-owned content\n");
    assert.deepEqual(listEntries(dirname(sharedDir)), ["knights-of-the-round-table"]);
  });
}

test("updating a sole shared harness does not install an absent sibling", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  install({ projectRoot, home, harnesses: ["codex"] });
  const result = install({ projectRoot, home, harnesses: ["codex"], force: true });
  assert.deepEqual(result.harnesses, ["codex"]);
  assert.equal(existsSync(join(home, ".gemini")), false);
});

test("generic skill scripts retain safe execute bits on install and force updates", (t) => {
  const projectRoot = withFixture(t);
  const sourceDir = createGenericSkillFixture(projectRoot, "other-skill");
  mkdirSync(join(sourceDir, "scripts"));
  const sourceScript = join(sourceDir, "scripts/run.sh");
  const home = withHome(t);
  const installedDir = join(home, ".claude/skills/other-skill");
  const installedScript = join(installedDir, "scripts/run.sh");
  const options = { projectRoot, home, skill: "other-skill", harnesses: ["claude"] };

  for (const [index, mode] of [0o755, 0o6751, 0o644, 0o700].entries()) {
    const content = `#!/bin/sh\nprintf 'version ${index}\\n'\n`;
    writeFileSync(sourceScript, content);
    chmodSync(sourceScript, mode);
    install({
      ...options,
      force: index > 0,
      onInstallEvent({ phase }) {
        if (phase === "source-validated") {
          // Both bytes and permissions must come from the validated snapshot.
          chmodSync(sourceScript, 0o600);
        }
      },
    });
    const installedMode = lstatSync(installedScript).mode;
    assert.equal(installedMode & 0o111, mode & 0o111);
    assert.equal(installedMode & 0o7000, 0, "never copy special permission bits");
    assert.equal(installedMode & 0o666, 0o666 & ~process.umask());
    assert.equal(readFileSync(installedScript, "utf8"), content);
    if (mode & 0o100) {
      const execution = spawnSync(installedScript, [], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(execution.stdout, `version ${index}\n`);
    }
    assert.equal(
      readManifest(installedDir).files.find((file) => file.path === "scripts/run.sh").executeBits,
      mode & 0o111,
    );
  }
});

test("execute-bit drift in an installed skill blocks force updates", (t) => {
  const projectRoot = withFixture(t);
  createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const options = { projectRoot, home, skill: "other-skill", harnesses: ["claude"] };
  install(options);
  const installedDir = join(home, ".claude/skills/other-skill");
  const manifest = readFileSync(join(installedDir, ".knights-install.json"));
  const notes = join(installedDir, "NOTES.md");
  chmodSync(notes, 0o755);
  assert.throws(() => install({ ...options, force: true }), /drift/i);
  assert.equal(lstatSync(notes).mode & 0o111, 0o111);
  assert.deepEqual(readFileSync(join(installedDir, ".knights-install.json")), manifest);
  assert.deepEqual(listEntries(dirname(installedDir)), ["other-skill"]);
});

test("execute-bit drift in a staged skill is rejected before publication", (t) => {
  const projectRoot = withFixture(t);
  const sourceDir = createGenericSkillFixture(projectRoot, "other-skill");
  chmodSync(join(sourceDir, "NOTES.md"), 0o755);
  const home = withHome(t);
  const parentDir = join(home, ".claude/skills");
  assert.throws(
    () => install({
      projectRoot, home, skill: "other-skill", harnesses: ["claude"],
      onInstallEvent({ phase }) {
        if (phase === "before-skill-manifest") {
          const [stage] = skillStageNames(parentDir, "other-skill");
          chmodSync(join(parentDir, stage, "NOTES.md"), 0o644);
        }
      },
    }),
    /drift/i,
  );
  assert.deepEqual(listEntries(parentDir), []);
});

test("executable skill rollback and hard-exit recovery retain the prior permissions", (t) => {
  const projectRoot = withFixture(t);
  const sourceDir = createGenericSkillFixture(projectRoot, "other-skill");
  const sourceNotes = join(sourceDir, "NOTES.md");
  chmodSync(sourceNotes, 0o755);
  const home = withHome(t);
  const options = { projectRoot, home, skill: "other-skill", harnesses: ["claude"] };
  const installedDir = join(home, ".claude/skills/other-skill");
  const installedNotes = join(installedDir, "NOTES.md");
  install(options);
  const priorContent = readFileSync(installedNotes);
  const priorManifest = readFileSync(join(installedDir, ".knights-install.json"));
  writeFileSync(sourceNotes, "next version\n");
  chmodSync(sourceNotes, 0o700);
  assert.throws(
    () => install({
      ...options, force: true,
      onInstallEvent({ phase }) {
        if (phase === "after-skill-backup") throw new Error("injected rollback");
      },
    }),
    /injected rollback/,
  );
  assert.equal(lstatSync(installedNotes).mode & 0o111, 0o111);
  assert.deepEqual(readFileSync(installedNotes), priorContent);
  assert.deepEqual(readFileSync(join(installedDir, ".knights-install.json")), priorManifest);

  const interrupted = runHardExitSkillInstall({
    projectRoot, home, phase: "after-skill-backup", force: true, exitCode: 94,
  });
  assert.equal(interrupted.status, 94, interrupted.stderr);
  // No force: recovery restores the old install, then ordinary preflight refuses.
  assert.throws(() => install(options), /already installed/i);
  assert.equal(lstatSync(installedNotes).mode & 0o111, 0o111);
  assert.deepEqual(readFileSync(installedNotes), priorContent);
  install({ ...options, force: true });
  assert.equal(lstatSync(installedNotes).mode & 0o111, 0o100);
  assert.equal(readFileSync(installedNotes, "utf8"), "next version\n");
  assert.deepEqual(listEntries(dirname(installedDir)), ["other-skill"]);
});

test("force updates accept older skill manifests without execute-bit metadata", (t) => {
  const projectRoot = withFixture(t);
  const sourceDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const options = { projectRoot, home, skill: "other-skill", harnesses: ["claude"] };
  install(options);
  const installedDir = join(home, ".claude/skills/other-skill");
  const manifest = readManifest(installedDir);
  for (const file of manifest.files) delete file.executeBits;
  writeFileSync(join(installedDir, ".knights-install.json"), JSON.stringify(manifest));
  chmodSync(join(sourceDir, "NOTES.md"), 0o755);
  install({ ...options, force: true });
  assert.equal(lstatSync(join(installedDir, "NOTES.md")).mode & 0o111, 0o111);
});

test("invalid execute-bit metadata fails closed before a force update", (t) => {
  const projectRoot = withFixture(t);
  createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const options = { projectRoot, home, skill: "other-skill", harnesses: ["claude"] };
  install(options);
  const installedDir = join(home, ".claude/skills/other-skill");
  const manifest = readManifest(installedDir);
  for (const executeBits of [null, "73", 0o4755, 0o644, -1, 1.5]) {
    manifest.files[0].executeBits = executeBits;
    const content = JSON.stringify(manifest);
    writeFileSync(join(installedDir, ".knights-install.json"), content);
    assert.throws(() => install({ ...options, force: true }), /invalid ownership manifest/i);
    assert.equal(readFileSync(join(installedDir, ".knights-install.json"), "utf8"), content);
  }
  assert.deepEqual(listEntries(dirname(installedDir)), ["other-skill"]);
});

test("recovery preserves a skill backup with execute-bit drift until restored", (t) => {
  const projectRoot = withFixture(t);
  const sourceDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const options = { projectRoot, home, skill: "other-skill", harnesses: ["claude"] };
  install(options);
  writeFileSync(join(sourceDir, "NOTES.md"), "next version\n");
  const interrupted = runHardExitSkillInstall({
    projectRoot, home, phase: "before-skill-backup-cleanup", force: true, exitCode: 95,
  });
  assert.equal(interrupted.status, 95, interrupted.stderr);
  const parentDir = join(home, ".claude/skills");
  const backup = listEntries(parentDir).find((name) => name.startsWith(".other-skill.knights-backup-"));
  const backupNotes = join(parentDir, backup, "NOTES.md");
  const priorContent = readFileSync(backupNotes);
  chmodSync(backupNotes, 0o755);
  assert.throws(() => install({ ...options, force: true }), /changed|drift/i);
  assert.equal(lstatSync(backupNotes).mode & 0o111, 0o111);
  assert.deepEqual(readFileSync(backupNotes), priorContent);
  chmodSync(backupNotes, 0o644);
  install({ ...options, force: true });
  assert.deepEqual(listEntries(parentDir), ["other-skill"]);
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

test("refuses force when an owned install directory contains an untracked empty directory", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const installedSkillDir = join(
    home,
    ".claude/skills/knights-of-the-round-table",
  );

  install({ projectRoot, home, harnesses: ["claude"] });
  const untrackedDirectory = join(installedSkillDir, "user-empty-directory");
  mkdirSync(untrackedDirectory);

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        force: true,
      }),
    /files do not match|untracked/i,
  );

  assert.equal(existsSync(untrackedDirectory), true);
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

test("refuses a null ownership manifest with a controlled error", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const installedSkillDir = join(
    home,
    ".claude/skills/knights-of-the-round-table",
  );

  install({ projectRoot, home, harnesses: ["claude"] });
  const installedSkill = readFileSync(join(installedSkillDir, "SKILL.md"));
  const manifestPath = join(installedSkillDir, ".knights-install.json");
  writeFileSync(manifestPath, "null\n");

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        force: true,
      }),
    /invalid ownership manifest: .*\.knights-install\.json/i,
  );

  assert.deepEqual(
    readFileSync(join(installedSkillDir, "SKILL.md")),
    installedSkill,
  );
  assert.equal(readFileSync(manifestPath, "utf8"), "null\n");
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
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.transactionVersion, 1);
  assert.equal(manifest.state, "complete");
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
  assert.equal(agentsManifest.schemaVersion, 2);
  assert.equal(agentsManifest.transactionVersion, 1);
  assert.equal(agentsManifest.state, "complete");
  assert.deepEqual(agentsManifest.harnesses, ["claude"]);
  for (const file of agentsManifest.files) {
    const actual = readFileSync(join(agentsDir, file.path));
    assert.equal(sha256(actual), file.sha256, file.path);
  }
});

test("installs the validated skill snapshot when the source changes after validation", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const external = tempDir("knights-install-snapshot-external-");
  t.after(() => rmSync(external, { recursive: true, force: true }));

  const originalSkill = readFileSync(join(sourceSkillDir, "SKILL.md"));
  const originalNotes = readFileSync(join(sourceSkillDir, "NOTES.md"));
  const externalNotes = join(external, "NOTES.md");
  writeFileSync(externalNotes, "unvalidated external bytes\n");

  let sourceWasMutated = false;
  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
    onInstallEvent({ phase }) {
      if (phase !== "source-validated") {
        return;
      }
      sourceWasMutated = true;
      writeFileSync(
        join(sourceSkillDir, "SKILL.md"),
        skillMarkdown({ name: "other-skill", version: "9.9.9" }),
      );
      rmSync(join(sourceSkillDir, "NOTES.md"));
      symlinkSync(externalNotes, join(sourceSkillDir, "NOTES.md"));
      writeFileSync(
        join(sourceSkillDir, "PLANTED.md"),
        "created after validation\n",
      );
    },
  });

  assert.equal(sourceWasMutated, true, "the mutation must cross the validation boundary");

  const installedSkillDir = join(home, ".claude/skills/other-skill");
  assert.deepEqual(
    readFileSync(join(installedSkillDir, "SKILL.md")),
    originalSkill,
  );
  assert.deepEqual(
    readFileSync(join(installedSkillDir, "NOTES.md")),
    originalNotes,
  );
  assert.equal(lstatSync(join(installedSkillDir, "NOTES.md")).isFile(), true);
  assert.equal(existsSync(join(installedSkillDir, "PLANTED.md")), false);

  const manifest = readManifest(installedSkillDir);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["NOTES.md", "SKILL.md"],
  );
  for (const file of manifest.files) {
    const installedBytes = readFileSync(join(installedSkillDir, file.path));
    assert.equal(file.sha256, sha256(installedBytes), file.path);
  }
});

test("interruption before the staged skill manifest preserves the prior install", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const installedSkillDir = join(home, ".claude/skills/other-skill");

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  const priorNotes = readFileSync(join(installedSkillDir, "NOTES.md"));
  const priorManifest = readFileSync(
    join(installedSkillDir, ".knights-install.json"),
  );
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase === "before-skill-manifest") {
            throw new Error("injected before skill manifest");
          }
        },
      }),
    /injected before skill manifest/,
  );

  assert.deepEqual(readFileSync(join(installedSkillDir, "NOTES.md")), priorNotes);
  assert.deepEqual(
    readFileSync(join(installedSkillDir, ".knights-install.json")),
    priorManifest,
  );
  assert.deepEqual(listEntries(dirname(installedSkillDir)), ["other-skill"]);

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
    force: true,
  });
  assert.equal(
    readFileSync(join(installedSkillDir, "NOTES.md"), "utf8"),
    "updated fixture bytes\n",
  );
});

test("rechecks the skill stage after the pre-manifest hook before writing metadata", (t) => {
  const projectRoot = withFixture(t);
  createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const skillsDir = join(home, ".claude/skills");
  const external = tempDir("knights-install-stage-race-external-");
  t.after(() => rmSync(external, { recursive: true, force: true }));

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        onInstallEvent({ phase }) {
          if (phase !== "before-skill-manifest") {
            return;
          }
          const stageName = listEntries(skillsDir).find((entry) =>
            entry.startsWith(".other-skill.knights-stage-"),
          );
          assert.equal(typeof stageName, "string");
          const stageDir = join(skillsDir, stageName);
          rmSync(stageDir, { recursive: true, force: true });
          symlinkSync(external, stageDir);
        },
      }),
    /changed|symlink/i,
  );

  assert.deepEqual(listEntries(external), []);
});

test("interruption before the staged skill swap preserves the prior install", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const installedSkillDir = join(home, ".claude/skills/other-skill");

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  const priorNotes = readFileSync(join(installedSkillDir, "NOTES.md"));
  const priorManifest = readFileSync(
    join(installedSkillDir, ".knights-install.json"),
  );
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase === "before-skill-swap") {
            throw new Error("injected before skill swap");
          }
        },
      }),
    /injected before skill swap/,
  );

  assert.deepEqual(readFileSync(join(installedSkillDir, "NOTES.md")), priorNotes);
  assert.deepEqual(
    readFileSync(join(installedSkillDir, ".knights-install.json")),
    priorManifest,
  );
  assert.deepEqual(listEntries(dirname(installedSkillDir)), ["other-skill"]);

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
    force: true,
  });
  assert.equal(
    readFileSync(join(installedSkillDir, "NOTES.md"), "utf8"),
    "updated fixture bytes\n",
  );
});

for (const [phase, exitCode] of [
  ["before-skill-manifest", 81],
  ["before-skill-swap", 82],
]) {
  test(`recovers a hard exit at ${phase} during first install`, (t) => {
    const projectRoot = withFixture(t);
    createGenericSkillFixture(projectRoot, "other-skill");
    const home = withHome(t);
    const skillsDir = join(home, ".claude/skills");
    const installedSkillDir = join(skillsDir, "other-skill");
    const similarlyNamedDir = join(
      skillsDir,
      ".other-skill.knights-stage-unrelated",
    );
    mkdirSync(similarlyNamedDir, { recursive: true });
    writeFileSync(join(similarlyNamedDir, "keep.txt"), "unrelated\n");

    const interrupted = runHardExitSkillInstall({
      projectRoot,
      home,
      phase,
      exitCode,
    });

    assert.equal(interrupted.status, exitCode, interrupted.stderr);
    assert.equal(existsSync(installedSkillDir), false);
    assert.equal(skillStageNames(skillsDir, "other-skill").length, 1);

    install({
      projectRoot,
      home,
      skill: "other-skill",
      harnesses: ["claude"],
    });

    assert.equal(
      readFileSync(join(installedSkillDir, "NOTES.md"), "utf8"),
      "Additional fixture file.\n",
    );
    assert.deepEqual(skillStageNames(skillsDir, "other-skill"), []);
    assert.deepEqual(skillJournalNames(skillsDir, "other-skill"), []);
    assert.equal(
      readFileSync(join(similarlyNamedDir, "keep.txt"), "utf8"),
      "unrelated\n",
    );
  });
}

for (const [phase, exitCode] of [
  ["before-skill-manifest", 83],
  ["before-skill-swap", 84],
]) {
  test(`recovers a hard exit at ${phase} during a force update`, (t) => {
    const projectRoot = withFixture(t);
    const sourceSkillDir = createGenericSkillFixture(
      projectRoot,
      "other-skill",
    );
    const home = withHome(t);
    const skillsDir = join(home, ".claude/skills");
    const installedSkillDir = join(skillsDir, "other-skill");
    const unrelatedPath = join(skillsDir, "unrelated.txt");

    install({
      projectRoot,
      home,
      skill: "other-skill",
      harnesses: ["claude"],
    });
    const priorNotes = readFileSync(join(installedSkillDir, "NOTES.md"));
    writeFileSync(unrelatedPath, "unrelated\n");
    writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

    const interrupted = runHardExitSkillInstall({
      projectRoot,
      home,
      phase,
      force: true,
      exitCode,
    });

    assert.equal(interrupted.status, exitCode, interrupted.stderr);
    assert.deepEqual(readFileSync(join(installedSkillDir, "NOTES.md")), priorNotes);
    assert.equal(skillStageNames(skillsDir, "other-skill").length, 1);

    install({
      projectRoot,
      home,
      skill: "other-skill",
      harnesses: ["claude"],
      force: true,
    });

    assert.equal(
      readFileSync(join(installedSkillDir, "NOTES.md"), "utf8"),
      "updated fixture bytes\n",
    );
    assert.equal(readFileSync(unrelatedPath, "utf8"), "unrelated\n");
    assert.deepEqual(skillStageNames(skillsDir, "other-skill"), []);
    assert.deepEqual(skillJournalNames(skillsDir, "other-skill"), []);
  });
}

test("recovers after repeated hard exits without leaving accumulated skill stages", (t) => {
  const projectRoot = withFixture(t);
  createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const skillsDir = join(home, ".claude/skills");
  const installedSkillDir = join(skillsDir, "other-skill");
  const similarlyNamedDir = join(
    skillsDir,
    ".other-skill.knights-stage-user-data",
  );
  mkdirSync(similarlyNamedDir, { recursive: true });
  writeFileSync(join(similarlyNamedDir, "keep.txt"), "keep me\n");

  for (const [phase, exitCode] of [
    ["before-skill-manifest", 85],
    ["before-skill-swap", 86],
    ["before-skill-manifest", 87],
  ]) {
    const interrupted = runHardExitSkillInstall({
      projectRoot,
      home,
      phase,
      exitCode,
    });
    assert.equal(interrupted.status, exitCode, interrupted.stderr);
    assert.equal(existsSync(installedSkillDir), false);
    assert.ok(skillStageNames(skillsDir, "other-skill").length >= 1);
  }

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });

  assert.equal(
    readFileSync(join(installedSkillDir, "NOTES.md"), "utf8"),
    "Additional fixture file.\n",
  );
  assert.deepEqual(skillStageNames(skillsDir, "other-skill"), []);
  assert.deepEqual(skillJournalNames(skillsDir, "other-skill"), []);
  assert.equal(
    readFileSync(join(similarlyNamedDir, "keep.txt"), "utf8"),
    "keep me\n",
  );
});

test("recovers a hard exit immediately after creating a first-install skill stage", (t) => {
  const projectRoot = withFixture(t);
  createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const skillsDir = join(home, ".claude/skills");
  const installedSkillDir = join(skillsDir, "other-skill");
  const similarlyNamedDir = join(
    skillsDir,
    ".other-skill.knights-stage-user-owned",
  );
  mkdirSync(similarlyNamedDir, { recursive: true });
  writeFileSync(join(similarlyNamedDir, "keep.txt"), "keep me\n");

  const interrupted = runHardExitAfterSkillStageCreation({
    projectRoot,
    home,
    exitCode: 90,
  });

  assert.equal(interrupted.status, 90, interrupted.stderr);
  assert.equal(existsSync(installedSkillDir), false);
  assert.equal(skillStageNames(skillsDir, "other-skill").length, 1);
  assert.equal(skillJournalNames(skillsDir, "other-skill").length, 1);

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });

  assert.equal(
    readFileSync(join(installedSkillDir, "NOTES.md"), "utf8"),
    "Additional fixture file.\n",
  );
  assert.deepEqual(skillStageNames(skillsDir, "other-skill"), []);
  assert.deepEqual(skillJournalNames(skillsDir, "other-skill"), []);
  assert.equal(
    readFileSync(join(similarlyNamedDir, "keep.txt"), "utf8"),
    "keep me\n",
  );
});

for (const { phase, exitCode, corrupt } of [
  {
    phase: "before-skill-manifest",
    exitCode: 91,
    corrupt(stageDir) {
      writeFileSync(join(stageDir, "NOTES.md"), "partial payload");
    },
  },
  {
    phase: "before-skill-swap",
    exitCode: 92,
    corrupt(stageDir) {
      writeFileSync(join(stageDir, ".knights-install.json"), '{"partial":');
    },
  },
]) {
  test(`recovers owned partial writes after a hard exit at ${phase}`, (t) => {
    const projectRoot = withFixture(t);
    createGenericSkillFixture(projectRoot, "other-skill");
    const home = withHome(t);
    const skillsDir = join(home, ".claude/skills");
    const installedSkillDir = join(skillsDir, "other-skill");

    const interrupted = runHardExitSkillInstall({
      projectRoot,
      home,
      phase,
      exitCode,
    });
    assert.equal(interrupted.status, exitCode, interrupted.stderr);

    const [stageName] = skillStageNames(skillsDir, "other-skill");
    assert.equal(typeof stageName, "string");
    corrupt(join(skillsDir, stageName));

    install({
      projectRoot,
      home,
      skill: "other-skill",
      harnesses: ["claude"],
    });

    assert.equal(
      readFileSync(join(installedSkillDir, "NOTES.md"), "utf8"),
      "Additional fixture file.\n",
    );
    assert.deepEqual(skillStageNames(skillsDir, "other-skill"), []);
    assert.deepEqual(skillJournalNames(skillsDir, "other-skill"), []);
  });
}

test("refuses to recover a skill stage while its owner is active", (t) => {
  const projectRoot = withFixture(t);
  createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  let concurrentInstallWasRefused = false;

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
    onInstallEvent({ phase }) {
      if (phase !== "before-skill-manifest") {
        return;
      }
      assert.throws(
        () =>
          install({
            projectRoot,
            home,
            skill: "other-skill",
            harnesses: ["claude"],
          }),
        /in progress/i,
      );
      concurrentInstallWasRefused = true;
    },
  });

  assert.equal(concurrentInstallWasRefused, true);
});

test("refuses to delete a replacement at a journaled skill stage path", (t) => {
  const projectRoot = withFixture(t);
  createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const skillsDir = join(home, ".claude/skills");
  const journalPath = join(
    skillsDir,
    ".other-skill.knights-swap.json",
  );

  const interrupted = runHardExitSkillInstall({
    projectRoot,
    home,
    phase: "before-skill-manifest",
    exitCode: 88,
  });
  assert.equal(interrupted.status, 88, interrupted.stderr);

  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const stageDir = join(skillsDir, journal.stageName);
  const displacedStageDir = join(skillsDir, "preserved-owned-stage");
  renameSync(stageDir, displacedStageDir);
  mkdirSync(stageDir);
  writeFileSync(join(stageDir, "unrelated.txt"), "do not delete\n");

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
      }),
    /changed|identity|interrupted/i,
  );
  assert.equal(
    readFileSync(join(stageDir, "unrelated.txt"), "utf8"),
    "do not delete\n",
  );

  rmSync(stageDir, { recursive: true });
  renameSync(displacedStageDir, stageDir);
  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  assert.deepEqual(skillStageNames(skillsDir, "other-skill"), []);
  assert.deepEqual(skillJournalNames(skillsDir, "other-skill"), []);
});

test("refuses a journaled skill stage path outside its target parent", (t) => {
  const projectRoot = withFixture(t);
  createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const skillsDir = join(home, ".claude/skills");
  const journalPath = join(
    skillsDir,
    ".other-skill.knights-swap.json",
  );
  const outsideDir = join(home, "outside-stage");
  mkdirSync(outsideDir);
  writeFileSync(join(outsideDir, "keep.txt"), "outside\n");

  const interrupted = runHardExitSkillInstall({
    projectRoot,
    home,
    phase: "before-skill-manifest",
    exitCode: 89,
  });
  assert.equal(interrupted.status, 89, interrupted.stderr);

  const originalJournal = readFileSync(journalPath);
  const forgedJournal = JSON.parse(originalJournal.toString("utf8"));
  forgedJournal.stageName = "../../outside-stage";
  writeFileSync(journalPath, `${JSON.stringify(forgedJournal, null, 2)}\n`);

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
      }),
    /invalid skill swap journal/i,
  );
  assert.equal(readFileSync(join(outsideDir, "keep.txt"), "utf8"), "outside\n");

  writeFileSync(journalPath, originalJournal);
  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  assert.deepEqual(skillStageNames(skillsDir, "other-skill"), []);
  assert.deepEqual(skillJournalNames(skillsDir, "other-skill"), []);
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

test("force replaces a hash-consistent installed skill whose old config is no longer valid", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const skillDir = join(
    home,
    ".claude/skills/knights-of-the-round-table",
  );
  const configPath = join(skillDir, "config/reviewers.yaml");
  const manifestPath = join(skillDir, ".knights-install.json");

  install({ projectRoot, home, harnesses: ["claude"] });
  const oldConfig = readFileSync(configPath, "utf8").replace(
    "maxReviewRounds: 10",
    "maxReviewRounds: 12",
  );
  writeFileSync(configPath, oldConfig);
  const manifest = readManifest(skillDir);
  manifest.files.find(
    (file) => file.path === "config/reviewers.yaml",
  ).sha256 = sha256(Buffer.from(oldConfig, "utf8"));
  writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  install({ projectRoot, home, harnesses: ["claude"], force: true });

  assert.match(readFileSync(configPath, "utf8"), /maxReviewRounds: 10/);
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

// A manifest that is shape-valid (right types, right schema version) but was
// copied or forged from another skill or another physical harness group must
// not be treated as proof of ownership over *this* target -- not even with
// --force. These tests hand-craft such a manifest directly (no `install()`
// call produced it) to prove the installer authenticates *context*, not just
// shape.
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

function updateFixtureReviewerSources(
  projectRoot,
  {
    correctness = "Updated correctness review guidance.\n",
    security = "Updated security review guidance.\n",
  } = {},
) {
  writeFileSync(
    join(
      projectRoot,
      "skills/knights-of-the-round-table/reviewers/correctness.md",
    ),
    correctness,
  );
  writeFileSync(
    join(
      projectRoot,
      "skills/knights-of-the-round-table/reviewers/security.md",
    ),
    security,
  );
  resyncGeneratedAgentSourceDir(projectRoot, "claude");
}

function readAgentPayloads(agentsDir, filenames) {
  return Object.fromEntries(
    filenames.map((filename) => [
      filename,
      readFileSync(join(agentsDir, filename)),
    ]),
  );
}

test("interruption before the agent transaction manifest preserves the prior agent install", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({ projectRoot, home, harnesses: ["claude"] });
  writeFileSync(
    join(agentsDir, "unrelated-agent.md"),
    "not managed by knights\n",
  );
  const priorManifest = readFileSync(
    join(agentsDir, ".knights-install.json"),
  );
  const priorPayloads = readAgentPayloads(
    agentsDir,
    readManifest(agentsDir).files.map((file) => file.path),
  );
  updateFixtureReviewerSources(projectRoot);

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase === "before-agent-transaction-manifest") {
            throw new Error("injected before agent transaction manifest");
          }
        },
      }),
    /injected before agent transaction manifest/,
  );

  assert.deepEqual(
    readFileSync(join(agentsDir, ".knights-install.json")),
    priorManifest,
  );
  for (const [filename, priorBytes] of Object.entries(priorPayloads)) {
    assert.deepEqual(readFileSync(join(agentsDir, filename)), priorBytes);
  }
  assert.equal(
    readFileSync(join(agentsDir, "unrelated-agent.md"), "utf8"),
    "not managed by knights\n",
  );

  install({ projectRoot, home, harnesses: ["claude"], force: true });
  const rendered = renderAll({ projectRoot }).claude;
  for (const [filename, content] of Object.entries(rendered)) {
    assert.equal(readFileSync(join(agentsDir, filename), "utf8"), content);
  }
});

test("force recovers an interruption after the agent transaction manifest", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({ projectRoot, home, harnesses: ["claude"] });
  const priorManifest = readManifest(agentsDir);
  const priorPayloads = readAgentPayloads(
    agentsDir,
    priorManifest.files.map((file) => file.path),
  );
  updateFixtureReviewerSources(projectRoot);
  const desiredPayloads = renderAll({ projectRoot }).claude;

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase === "after-agent-transaction-manifest") {
            throw new Error("injected after agent transaction manifest");
          }
        },
      }),
    /injected after agent transaction manifest/,
  );

  assert.deepEqual(readManifest(agentsDir), priorManifest);
  const interruptedManifest = readTransactionManifest(agentsDir);
  assert.equal(interruptedManifest.schemaVersion, 2);
  assert.equal(interruptedManifest.transactionVersion, 1);
  assert.equal(interruptedManifest.state, "installing");
  for (const [filename, priorBytes] of Object.entries(priorPayloads)) {
    assert.deepEqual(readFileSync(join(agentsDir, filename)), priorBytes);
  }

  const missingFilename = interruptedManifest.files.at(-1).path;
  rmSync(join(agentsDir, missingFilename));
  writeFileSync(
    join(agentsDir, "unrelated-agent.md"),
    "not managed by knights\n",
  );

  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"] }),
    /force/i,
  );

  install({ projectRoot, home, harnesses: ["claude"], force: true });
  for (const [filename, content] of Object.entries(desiredPayloads)) {
    assert.equal(readFileSync(join(agentsDir, filename), "utf8"), content);
  }
  const recoveredManifest = readManifest(agentsDir);
  assert.equal(recoveredManifest.state, "complete");
  assert.equal(existsSync(join(agentsDir, TRANSACTION_FILENAME)), false);
  assert.equal(
    readFileSync(join(agentsDir, "unrelated-agent.md"), "utf8"),
    "not managed by knights\n",
  );
});

test("force recovers an interrupted agent transaction after the source changes again", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({ projectRoot, home, harnesses: ["claude"] });
  updateFixtureReviewerSources(projectRoot);

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase === "after-agent-transaction-manifest") {
            throw new Error("injected after agent transaction manifest");
          }
        },
      }),
    /injected after agent transaction manifest/,
  );

  updateFixtureReviewerSources(projectRoot, {
    correctness: "Third correctness review guidance.\n",
    security: "Third security review guidance.\n",
  });
  const newestPayloads = renderAll({ projectRoot }).claude;

  install({ projectRoot, home, harnesses: ["claude"], force: true });

  for (const [filename, content] of Object.entries(newestPayloads)) {
    assert.equal(readFileSync(join(agentsDir, filename), "utf8"), content);
  }
  assert.equal(existsSync(join(agentsDir, TRANSACTION_FILENAME)), false);
});

test("force recovers a first agent install after the source changes", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        onInstallEvent({ phase }) {
          if (phase === "after-agent-file") {
            throw new Error("injected during first agent install");
          }
        },
      }),
    /injected during first agent install/,
  );
  assert.equal(
    existsSync(join(agentsDir, ".knights-install.json")),
    false,
  );
  assert.equal(existsSync(join(agentsDir, TRANSACTION_FILENAME)), true);

  updateFixtureReviewerSources(projectRoot);
  const newestPayloads = renderAll({ projectRoot }).claude;
  install({ projectRoot, home, harnesses: ["claude"], force: true });

  for (const [filename, content] of Object.entries(newestPayloads)) {
    assert.equal(readFileSync(join(agentsDir, filename), "utf8"), content);
  }
  assert.equal(existsSync(join(agentsDir, TRANSACTION_FILENAME)), false);
});

test("retains intermediate agent ownership when recovery is interrupted again", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({ projectRoot, home, harnesses: ["claude"] });
  writeFileSync(
    join(
      projectRoot,
      "skills/knights-of-the-round-table/config/reviewers.yaml",
    ),
    skillYamlWithHarnessName(
      "security",
      "claude",
      "security-reviewer-v2",
    ),
  );
  resyncGeneratedAgentSourceDir(projectRoot, "claude");
  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase, filename }) {
          if (
            phase === "after-agent-file" &&
            filename === "security-reviewer-v2.md"
          ) {
            throw new Error("injected after intermediate agent write");
          }
        },
      }),
    /injected after intermediate agent write/,
  );

  writeFileSync(
    join(
      projectRoot,
      "skills/knights-of-the-round-table/config/reviewers.yaml",
    ),
    skillYamlWithHarnessName(
      "security",
      "claude",
      "security-reviewer-v3",
    ),
  );
  resyncGeneratedAgentSourceDir(projectRoot, "claude");
  let transactionManifestCount = 0;
  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (
            phase === "after-agent-transaction-manifest" &&
            ++transactionManifestCount === 2
          ) {
            throw new Error("injected during second recovery");
          }
        },
      }),
    /injected during second recovery/,
  );

  const newestPayloads = renderAll({ projectRoot }).claude;
  install({ projectRoot, home, harnesses: ["claude"], force: true });

  for (const [filename, content] of Object.entries(newestPayloads)) {
    assert.equal(readFileSync(join(agentsDir, filename), "utf8"), content);
  }
  assert.equal(
    existsSync(join(agentsDir, "security-reviewer-v2.md")),
    false,
  );
  assert.equal(existsSync(join(agentsDir, TRANSACTION_FILENAME)), false);
});

test("force recovers an agent transaction after a later skill update is also interrupted", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({
    projectRoot,
    home,
    harnesses: ["claude", "copilot"],
  });
  updateFixtureReviewerSources(projectRoot);
  resyncGeneratedAgentSourceDir(projectRoot, "copilot");
  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude", "copilot"],
        force: true,
        onInstallEvent({ phase, harness }) {
          if (
            phase === "after-agent-transaction-manifest" &&
            harness === "claude"
          ) {
            throw new Error("injected after claude transaction manifest");
          }
        },
      }),
    /injected after claude transaction manifest/,
  );

  updateFixtureReviewerSources(projectRoot, {
    correctness: "Third correctness review guidance.\n",
    security: "Third security review guidance.\n",
  });
  resyncGeneratedAgentSourceDir(projectRoot, "copilot");
  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude", "copilot"],
        force: true,
        onInstallEvent({ phase, targetDir }) {
          if (
            phase === "before-skill-manifest" &&
            targetDir.includes("/.copilot/skills/")
          ) {
            throw new Error("injected during later skill update");
          }
        },
      }),
    /injected during later skill update/,
  );

  const newestPayloads = renderAll({ projectRoot }).claude;
  install({
    projectRoot,
    home,
    harnesses: ["claude", "copilot"],
    force: true,
  });

  for (const [filename, content] of Object.entries(newestPayloads)) {
    assert.equal(readFileSync(join(agentsDir, filename), "utf8"), content);
  }
  assert.equal(existsSync(join(agentsDir, TRANSACTION_FILENAME)), false);
});

test("updating a shared skill recovers an interrupted unselected sibling first", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const codexAgentsDir = join(home, ".codex/agents");
  const unrelatedPath = join(codexAgentsDir, "unrelated.toml");

  install({
    projectRoot,
    home,
    harnesses: ["codex", "gemini"],
  });
  writeFileSync(unrelatedPath, "unrelated = true\n");
  writeFileSync(
    join(
      projectRoot,
      "skills/knights-of-the-round-table/config/reviewers.yaml",
    ),
    skillYamlWithHarnessName(
      "security",
      "codex",
      "security-reviewer-v2",
    ),
  );
  resyncGeneratedAgentSourceDir(projectRoot, "codex");
  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["codex"],
        force: true,
        onInstallEvent({ phase, filename }) {
          if (
            phase === "after-agent-file" &&
            filename === "security-reviewer-v2.toml"
          ) {
            throw new Error("injected during codex agent update");
          }
        },
      }),
    /injected during codex agent update/,
  );
  assert.equal(
    existsSync(join(codexAgentsDir, "security-reviewer-v2.toml")),
    true,
  );

  writeFileSync(
    join(
      projectRoot,
      "skills/knights-of-the-round-table/config/reviewers.yaml",
    ),
    skillYamlWithHarnessName(
      "security",
      "codex",
      "security-reviewer-v3",
    ),
  );
  resyncGeneratedAgentSourceDir(projectRoot, "codex");

  install({
    projectRoot,
    home,
    harnesses: ["gemini"],
    force: true,
  });
  install({
    projectRoot,
    home,
    harnesses: ["codex"],
    force: true,
  });

  assert.equal(
    existsSync(join(codexAgentsDir, "security-reviewer-v2.toml")),
    false,
  );
  assert.equal(
    existsSync(join(codexAgentsDir, "security-reviewer-v3.toml")),
    true,
  );
  assert.equal(
    existsSync(join(codexAgentsDir, TRANSACTION_FILENAME)),
    false,
  );
  assert.equal(readFileSync(unrelatedPath, "utf8"), "unrelated = true\n");
});

test("an active agent transaction cannot be taken over by a concurrent install", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);

  install({ projectRoot, home, harnesses: ["claude"] });
  updateFixtureReviewerSources(projectRoot);
  let concurrentInstallWasRefused = false;

  install({
    projectRoot,
    home,
    harnesses: ["claude"],
    force: true,
    onInstallEvent({ phase }) {
      if (phase !== "after-agent-transaction-manifest") {
        return;
      }
      assert.throws(
        () =>
          install({
            projectRoot,
            home,
            harnesses: ["claude"],
            force: true,
          }),
        /in progress/i,
      );
      concurrentInstallWasRefused = true;
    },
  });

  assert.equal(concurrentInstallWasRefused, true);
});

test("force recovers an interruption between atomic agent file writes", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({ projectRoot, home, harnesses: ["claude"] });
  const priorManifest = readManifest(agentsDir);
  const filenames = priorManifest.files.map((file) => file.path);
  const priorPayloads = readAgentPayloads(agentsDir, filenames);
  updateFixtureReviewerSources(projectRoot);
  const desiredPayloads = renderAll({ projectRoot }).claude;
  let writtenFilename;

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase, filename }) {
          if (phase === "after-agent-file") {
            writtenFilename = filename;
            throw new Error("injected between agent writes");
          }
        },
      }),
    /injected between agent writes/,
  );

  assert.equal(typeof writtenFilename, "string");
  assert.equal(readManifest(agentsDir).state, "complete");
  assert.equal(readTransactionManifest(agentsDir).state, "installing");
  assert.equal(
    readFileSync(join(agentsDir, writtenFilename), "utf8"),
    desiredPayloads[writtenFilename],
  );
  for (const filename of filenames.filter(
    (candidate) => candidate !== writtenFilename,
  )) {
    assert.deepEqual(
      readFileSync(join(agentsDir, filename)),
      priorPayloads[filename],
    );
  }
  assert.equal(
    listEntries(agentsDir).some((entry) => entry.includes(".knights-tmp-")),
    false,
  );

  install({ projectRoot, home, harnesses: ["claude"], force: true });
  for (const [filename, content] of Object.entries(desiredPayloads)) {
    assert.equal(readFileSync(join(agentsDir, filename), "utf8"), content);
  }
  assert.equal(readManifest(agentsDir).state, "complete");
  assert.equal(existsSync(join(agentsDir, TRANSACTION_FILENAME)), false);
});

test("a completed agent transaction does not block a later source update", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({ projectRoot, home, harnesses: ["claude"] });
  updateFixtureReviewerSources(projectRoot);

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase === "before-agent-transaction-cleanup") {
            throw new Error("injected before agent transaction cleanup");
          }
        },
      }),
    /injected before agent transaction cleanup/,
  );
  assert.equal(readManifest(agentsDir).state, "complete");
  assert.equal(readTransactionManifest(agentsDir).state, "installing");

  updateFixtureReviewerSources(projectRoot, {
    correctness: "Third correctness review guidance.\n",
    security: "Third security review guidance.\n",
  });
  const newestPayloads = renderAll({ projectRoot }).claude;

  install({ projectRoot, home, harnesses: ["claude"], force: true });

  for (const [filename, content] of Object.entries(newestPayloads)) {
    assert.equal(readFileSync(join(agentsDir, filename), "utf8"), content);
  }
  assert.equal(existsSync(join(agentsDir, TRANSACTION_FILENAME)), false);
});

test("interrupted agent ownership refuses external drift and destination symlinks", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");
  const external = tempDir("knights-install-agent-recovery-external-");
  t.after(() => rmSync(external, { recursive: true, force: true }));

  install({ projectRoot, home, harnesses: ["claude"] });
  updateFixtureReviewerSources(projectRoot);
  assert.throws(() =>
    install({
      projectRoot,
      home,
      harnesses: ["claude"],
      force: true,
      onInstallEvent({ phase }) {
        if (phase === "after-agent-transaction-manifest") {
          throw new Error("injected after agent transaction manifest");
        }
      },
    }),
  );

  const filename = readTransactionManifest(agentsDir).files[0].path;
  const filePath = join(agentsDir, filename);
  writeFileSync(filePath, "external drift\n");
  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"], force: true }),
    /drifted|unmanaged/i,
  );
  assert.equal(readFileSync(filePath, "utf8"), "external drift\n");

  rmSync(filePath);
  const externalFile = join(external, filename);
  writeFileSync(externalFile, "external bytes\n");
  symlinkSync(externalFile, filePath);
  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"], force: true }),
    /regular file|symlink/i,
  );
  assert.equal(lstatSync(filePath).isSymbolicLink(), true);
  assert.equal(readFileSync(externalFile, "utf8"), "external bytes\n");
});

test("interrupted agent ownership refuses an unowned collision at a newly tracked path", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({ projectRoot, home, harnesses: ["claude"] });
  writeFileSync(
    join(
      projectRoot,
      "skills/knights-of-the-round-table/config/reviewers.yaml",
    ),
    skillYamlWithHarnessName("security", "claude", "security-reviewer-v2"),
  );
  resyncGeneratedAgentSourceDir(projectRoot, "claude");

  assert.throws(() =>
    install({
      projectRoot,
      home,
      harnesses: ["claude"],
      force: true,
      onInstallEvent({ phase }) {
        if (phase === "after-agent-transaction-manifest") {
          throw new Error("injected after agent transaction manifest");
        }
      },
    }),
  );

  const unownedPath = join(agentsDir, "security-reviewer-v2.md");
  writeFileSync(unownedPath, "unowned collision\n");
  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"], force: true }),
    /drifted|unmanaged/i,
  );
  assert.equal(readFileSync(unownedPath, "utf8"), "unowned collision\n");
  assert.equal(
    existsSync(join(agentsDir, "security-reviewer.md")),
    true,
    "the prior owned file must survive the refused recovery",
  );
});

test("refuses a forged transaction state without mutating owned agent files", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({ projectRoot, home, harnesses: ["claude"] });
  const manifest = readManifest(agentsDir);
  const payloads = readAgentPayloads(
    agentsDir,
    manifest.files.map((file) => file.path),
  );
  manifest.state = "installing";
  manifest.transactionVersion = 999;
  manifest.previousFiles = manifest.files;
  writeFileSync(
    join(agentsDir, ".knights-install.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"], force: true }),
    /invalid ownership manifest/i,
  );
  for (const [filename, priorBytes] of Object.entries(payloads)) {
    assert.deepEqual(readFileSync(join(agentsDir, filename)), priorBytes);
  }
});

test("refuses a forged transaction journal that claims an unrelated agent file", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");
  const unrelatedFilename = "unrelated-agent.md";
  const unrelatedContent = "not managed by knights\n";
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, unrelatedFilename), unrelatedContent);

  const desiredFiles = Object.entries(renderAll({ projectRoot }).claude).map(
    ([path, content]) => ({
      path,
      sha256: sha256(Buffer.from(content, "utf8")),
    }),
  );
  const forgedTransaction = {
    schemaVersion: 2,
    transactionVersion: 1,
    state: "installing",
    installer: "knights-install",
    skill: "knights-of-the-round-table",
    skillVersion: "0.1.0",
    source: projectRoot,
    harnesses: ["claude"],
    previousManifestSha256: null,
    ownerProcessId: process.pid,
    files: [
      ...desiredFiles,
      {
        path: unrelatedFilename,
        sha256: sha256(Buffer.from(unrelatedContent)),
      },
    ],
  };
  writeFileSync(
    join(agentsDir, TRANSACTION_FILENAME),
    `${JSON.stringify(forgedTransaction, null, 2)}\n`,
  );

  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"], force: true }),
    /invalid ownership manifest|transaction/i,
  );
  assert.equal(
    readFileSync(join(agentsDir, unrelatedFilename), "utf8"),
    unrelatedContent,
  );
  assert.deepEqual(readTransactionManifest(agentsDir), forgedTransaction);
});

test("a forged skill snapshot cannot authorize an unrelated agent transaction claim", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");
  const skillDir = join(
    home,
    ".claude/skills/knights-of-the-round-table",
  );
  const unrelatedFilename = "unrelated-agent.md";
  const unrelatedContent = Buffer.from("not managed by knights\n");

  install({ projectRoot, home, harnesses: ["claude"] });
  writeFileSync(join(agentsDir, unrelatedFilename), unrelatedContent);

  const desiredFiles = Object.entries(renderAll({ projectRoot }).claude).map(
    ([path, content]) => ({
      path,
      sha256: sha256(Buffer.from(content, "utf8")),
    }),
  );
  const forgedFiles = [
    ...desiredFiles,
    {
      path: unrelatedFilename,
      sha256: sha256(unrelatedContent),
    },
  ];
  const skillManifest = readManifest(skillDir);
  skillManifest.generatedAgentFiles = { claude: forgedFiles };
  writeFileSync(
    join(skillDir, ".knights-install.json"),
    `${JSON.stringify(skillManifest, null, 2)}\n`,
  );

  const agentManifestBytes = readFileSync(
    join(agentsDir, ".knights-install.json"),
  );
  const forgedTransaction = {
    schemaVersion: 2,
    transactionVersion: 1,
    state: "installing",
    installer: "knights-install",
    skill: "knights-of-the-round-table",
    skillVersion: "0.1.0",
    source: projectRoot,
    harnesses: ["claude"],
    previousManifestSha256: sha256(agentManifestBytes),
    ownerProcessId: process.pid,
    files: forgedFiles,
  };
  writeFileSync(
    join(agentsDir, TRANSACTION_FILENAME),
    `${JSON.stringify(forgedTransaction, null, 2)}\n`,
  );

  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"], force: true }),
    /transaction.*installed or validated agent source|forged|unmanaged|unowned/i,
  );
  assert.deepEqual(
    readFileSync(join(agentsDir, unrelatedFilename)),
    unrelatedContent,
  );
});

test("refuses an agent transaction journal that is not linked to the completed manifest", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({ projectRoot, home, harnesses: ["claude"] });
  const priorManifest = readFileSync(
    join(agentsDir, ".knights-install.json"),
  );
  const priorPayloads = readAgentPayloads(
    agentsDir,
    readManifest(agentsDir).files.map((file) => file.path),
  );
  updateFixtureReviewerSources(projectRoot);
  const desiredFiles = Object.entries(renderAll({ projectRoot }).claude).map(
    ([path, content]) => ({
      path,
      sha256: sha256(Buffer.from(content, "utf8")),
    }),
  );
  const forgedTransaction = {
    schemaVersion: 2,
    transactionVersion: 1,
    state: "installing",
    installer: "knights-install",
    skill: "knights-of-the-round-table",
    skillVersion: "0.1.0",
    source: projectRoot,
    harnesses: ["claude"],
    ownerProcessId: process.pid,
    files: desiredFiles,
    previousManifestSha256: "0".repeat(64),
  };
  writeFileSync(
    join(agentsDir, TRANSACTION_FILENAME),
    `${JSON.stringify(forgedTransaction, null, 2)}\n`,
  );

  assert.throws(
    () => install({ projectRoot, home, harnesses: ["claude"], force: true }),
    /not linked/i,
  );
  assert.deepEqual(
    readFileSync(join(agentsDir, ".knights-install.json")),
    priorManifest,
  );
  for (const [filename, priorBytes] of Object.entries(priorPayloads)) {
    assert.deepEqual(readFileSync(join(agentsDir, filename)), priorBytes);
  }
});

test("rechecks the agent directory after the transaction hook before writing payload", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");
  const displacedAgentsDir = join(home, ".claude/agents-prior");
  const external = tempDir("knights-install-agent-race-external-");
  t.after(() => rmSync(external, { recursive: true, force: true }));

  install({ projectRoot, home, harnesses: ["claude"] });
  const priorManifest = readManifest(agentsDir);
  const priorPayloads = readAgentPayloads(
    agentsDir,
    priorManifest.files.map((file) => file.path),
  );
  updateFixtureReviewerSources(projectRoot);

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase === "after-agent-transaction-manifest") {
            renameSync(agentsDir, displacedAgentsDir);
            symlinkSync(external, agentsDir);
          }
        },
      }),
    /changed|symlink/i,
  );

  assert.equal(lstatSync(agentsDir).isSymbolicLink(), true);
  assert.deepEqual(listEntries(external), []);
  for (const [filename, priorBytes] of Object.entries(priorPayloads)) {
    assert.deepEqual(
      readFileSync(join(displacedAgentsDir, filename)),
      priorBytes,
    );
  }
});

test("rechecks an owned agent file after the transaction hook before replacing it", (t) => {
  const projectRoot = withFixture(t);
  const home = withHome(t);
  const agentsDir = join(home, ".claude/agents");

  install({ projectRoot, home, harnesses: ["claude"] });
  updateFixtureReviewerSources(projectRoot);
  const racedFilename = "correctness-reviewer.md";

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase === "after-agent-transaction-manifest") {
            writeFileSync(
              join(agentsDir, racedFilename),
              "changed after preflight\n",
            );
          }
        },
      }),
    /changed|drifted/i,
  );

  assert.equal(
    readFileSync(join(agentsDir, racedFilename), "utf8"),
    "changed after preflight\n",
  );
  assert.equal(readTransactionManifest(agentsDir).state, "installing");
});

test("rechecks the skill destination after staging before swapping it", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const installedSkillDir = join(home, ".claude/skills/other-skill");
  const displacedSkillDir = join(home, ".claude/skills/other-skill-prior");
  const external = tempDir("knights-install-skill-race-external-");
  t.after(() => rmSync(external, { recursive: true, force: true }));

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  const priorNotes = readFileSync(join(installedSkillDir, "NOTES.md"));
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase === "before-skill-swap") {
            renameSync(installedSkillDir, displacedSkillDir);
            symlinkSync(external, installedSkillDir);
          }
        },
      }),
    /changed|symlink/i,
  );

  assert.equal(lstatSync(installedSkillDir).isSymbolicLink(), true);
  assert.deepEqual(listEntries(external), []);
  assert.deepEqual(
    readFileSync(join(displacedSkillDir, "NOTES.md")),
    priorNotes,
  );
});

test("rechecks skill ancestors after moving the prior install to its backup", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const claudeDir = join(home, ".claude");
  const installedSkillDir = join(claudeDir, "skills/other-skill");
  const external = tempDir("knights-install-skill-ancestor-race-");
  const movedClaudeDir = join(external, "claude");
  t.after(() => rmSync(external, { recursive: true, force: true }));

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  const priorNotes = readFileSync(join(installedSkillDir, "NOTES.md"));
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase === "after-skill-backup") {
            renameSync(claudeDir, movedClaudeDir);
            symlinkSync(movedClaudeDir, claudeDir);
          }
        },
      }),
    /symlink|changed|restore prior install/i,
  );

  assert.equal(lstatSync(claudeDir).isSymbolicLink(), true);
  assert.equal(existsSync(join(movedClaudeDir, "skills/other-skill")), false);
  const backupName = listEntries(join(movedClaudeDir, "skills")).find((entry) =>
    entry.startsWith(".other-skill.knights-backup-"),
  );
  assert.equal(typeof backupName, "string");
  assert.deepEqual(
    readFileSync(
      join(movedClaudeDir, "skills", backupName, "NOTES.md"),
    ),
    priorNotes,
  );
});

test("an active skill swap journal cannot be taken over by a concurrent install", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");
  let concurrentInstallWasRefused = false;

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
    force: true,
    onInstallEvent({ phase }) {
      if (phase !== "after-skill-swap-journal") {
        return;
      }
      assert.throws(
        () =>
          install({
            projectRoot,
            home,
            skill: "other-skill",
            harnesses: ["claude"],
            force: true,
          }),
        /in progress/i,
      );
      concurrentInstallWasRefused = true;
    },
  });

  assert.equal(concurrentInstallWasRefused, true);
});

test("the skill swap journal does not expose an unreserved backup path", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");
  let journalWasOpaque = false;

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
    force: true,
    onInstallEvent({ phase }) {
      if (phase === "after-skill-swap-journal") {
        const journal = JSON.parse(
          readFileSync(
            join(
              home,
              ".claude/skills/.other-skill.knights-swap.json",
            ),
            "utf8",
          ),
        );
        assert.equal("backupName" in journal, false);
        journalWasOpaque = true;
      }
    },
  });

  assert.equal(journalWasOpaque, true);
});

test("recovers a hard interruption after moving the prior skill to its backup", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const installedSkillDir = join(home, ".claude/skills/other-skill");
  const runnerDir = tempDir("knights-install-swap-runner-");
  t.after(() => rmSync(runnerDir, { recursive: true, force: true }));

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  const runnerPath = join(runnerDir, "interrupt-swap.mjs");
  writeFileSync(
    runnerPath,
    [
      `import { install } from ${JSON.stringify(
        pathToFileURL(join(repositoryRoot, "scripts/install.mjs")).href,
      )};`,
      `install(${JSON.stringify({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
      }).replace(/}$/, "")},`,
      "  onInstallEvent({ phase }) {",
      '    if (phase === "after-skill-backup") process.exit(86);',
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  const interrupted = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
  });
  assert.equal(interrupted.status, 86, interrupted.stderr);
  assert.equal(existsSync(installedSkillDir), false);

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
    force: true,
  });

  assert.equal(
    readFileSync(join(installedSkillDir, "NOTES.md"), "utf8"),
    "updated fixture bytes\n",
  );
  assert.deepEqual(listEntries(dirname(installedSkillDir)), ["other-skill"]);
});

test("rollback restores the validated backup even if the swap journal is removed", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const installedSkillDir = join(home, ".claude/skills/other-skill");
  const journalPath = join(
    home,
    ".claude/skills/.other-skill.knights-swap.json",
  );

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  const priorNotes = readFileSync(join(installedSkillDir, "NOTES.md"));
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase === "after-skill-backup") {
            rmSync(journalPath);
            throw new Error("injected after removing swap journal");
          }
        },
      }),
    /injected after removing swap journal/,
  );

  assert.deepEqual(
    readFileSync(join(installedSkillDir, "NOTES.md")),
    priorNotes,
  );
  assert.equal(existsSync(journalPath), false);
  assert.deepEqual(listEntries(dirname(installedSkillDir)), ["other-skill"]);
});

test("an interrupted skill swap recovery cannot be taken over concurrently", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const runnerDir = tempDir("knights-install-recovery-lock-runner-");
  t.after(() => rmSync(runnerDir, { recursive: true, force: true }));

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  const runnerPath = join(runnerDir, "interrupt-swap.mjs");
  writeFileSync(
    runnerPath,
    [
      `import { install } from ${JSON.stringify(
        pathToFileURL(join(repositoryRoot, "scripts/install.mjs")).href,
      )};`,
      `install(${JSON.stringify({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
      }).replace(/}$/, "")},`,
      "  onInstallEvent({ phase }) {",
      '    if (phase === "after-skill-backup") process.exit(89);',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  const interrupted = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
  });
  assert.equal(interrupted.status, 89, interrupted.stderr);

  let concurrentRecoveryWasRefused = false;
  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
    force: true,
    onInstallEvent({ phase }) {
      if (phase !== "after-skill-recovery-claim") {
        return;
      }
      assert.throws(
        () =>
          install({
            projectRoot,
            home,
            skill: "other-skill",
            harnesses: ["claude"],
            force: true,
          }),
        /in progress/i,
      );
      concurrentRecoveryWasRefused = true;
    },
  });

  assert.equal(concurrentRecoveryWasRefused, true);
});

test("does not roll back to a backup that changed after it was moved", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const installedSkillDir = join(home, ".claude/skills/other-skill");
  const skillsDir = dirname(installedSkillDir);

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
        onInstallEvent({ phase }) {
          if (phase !== "after-skill-backup") {
            return;
          }
          const backupName = listEntries(skillsDir).find((entry) =>
            entry.startsWith(".other-skill.knights-backup-"),
          );
          assert.equal(typeof backupName, "string");
          writeFileSync(
            join(skillsDir, backupName, "NOTES.md"),
            "changed after backup rename\n",
          );
          throw new Error("injected after corrupting skill backup");
        },
      }),
    /injected|restore prior install|manifest|drifted/i,
  );

  assert.equal(
    existsSync(installedSkillDir),
    false,
    "an invalid backup must not be republished",
  );
  assert.equal(
    listEntries(skillsDir).some((entry) =>
      entry.startsWith(".other-skill.knights-backup-"),
    ),
    true,
  );
  assert.equal(
    listEntries(skillsDir).includes(".other-skill.knights-swap.json"),
    true,
  );
});

test("recovers when interruption leaves a partially removed skill backup", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const installedSkillDir = join(home, ".claude/skills/other-skill");
  const skillsDir = dirname(installedSkillDir);
  const runnerDir = tempDir("knights-install-cleanup-runner-");
  t.after(() => rmSync(runnerDir, { recursive: true, force: true }));

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  const runnerPath = join(runnerDir, "interrupt-cleanup.mjs");
  writeFileSync(
    runnerPath,
    [
      `import { install } from ${JSON.stringify(
        pathToFileURL(join(repositoryRoot, "scripts/install.mjs")).href,
      )};`,
      `install(${JSON.stringify({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
      }).replace(/}$/, "")},`,
      "  onInstallEvent({ phase }) {",
      '    if (phase === "before-skill-backup-cleanup") process.exit(87);',
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  const interrupted = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
  });
  assert.equal(interrupted.status, 87, interrupted.stderr);
  assert.equal(
    readFileSync(join(installedSkillDir, "NOTES.md"), "utf8"),
    "updated fixture bytes\n",
  );

  const backupName = listEntries(skillsDir).find((entry) =>
    entry.startsWith(".other-skill.knights-backup-"),
  );
  assert.equal(typeof backupName, "string");
  rmSync(join(skillsDir, backupName, "NOTES.md"));

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
    force: true,
  });

  assert.equal(
    readFileSync(join(installedSkillDir, "NOTES.md"), "utf8"),
    "updated fixture bytes\n",
  );
  assert.deepEqual(listEntries(skillsDir), ["other-skill"]);
});

test("refuses to delete changed or untracked files from a partially cleaned skill backup", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const installedSkillDir = join(home, ".claude/skills/other-skill");
  const skillsDir = dirname(installedSkillDir);
  const runnerDir = tempDir("knights-install-cleanup-safety-runner-");
  t.after(() => rmSync(runnerDir, { recursive: true, force: true }));

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  const priorNotes = readFileSync(join(installedSkillDir, "NOTES.md"));
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  const runnerPath = join(runnerDir, "interrupt-cleanup.mjs");
  writeFileSync(
    runnerPath,
    [
      `import { install } from ${JSON.stringify(
        pathToFileURL(join(repositoryRoot, "scripts/install.mjs")).href,
      )};`,
      `install(${JSON.stringify({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
      }).replace(/}$/, "")},`,
      "  onInstallEvent({ phase }) {",
      '    if (phase === "before-skill-backup-cleanup") process.exit(88);',
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  const interrupted = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
  });
  assert.equal(interrupted.status, 88, interrupted.stderr);
  const backupName = listEntries(skillsDir).find((entry) =>
    entry.startsWith(".other-skill.knights-backup-"),
  );
  assert.equal(typeof backupName, "string");
  const backupDir = join(skillsDir, backupName);

  writeFileSync(join(backupDir, "NOTES.md"), "changed during cleanup\n");
  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
      }),
    /changed|drifted|manifest/i,
  );
  assert.equal(
    readFileSync(join(backupDir, "NOTES.md"), "utf8"),
    "changed during cleanup\n",
  );

  writeFileSync(join(backupDir, "NOTES.md"), priorNotes);
  writeFileSync(join(backupDir, "untracked.txt"), "do not delete\n");
  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
      }),
    /files do not match|untracked|changed/i,
  );
  assert.equal(
    readFileSync(join(backupDir, "untracked.txt"), "utf8"),
    "do not delete\n",
  );
});

test("a forged swap journal cannot authorize deletion of an untracked backup file", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const installedSkillDir = join(home, ".claude/skills/other-skill");
  const skillsDir = dirname(installedSkillDir);
  const journalPath = join(
    skillsDir,
    ".other-skill.knights-swap.json",
  );
  const runnerDir = tempDir("knights-install-forged-swap-runner-");
  t.after(() => rmSync(runnerDir, { recursive: true, force: true }));

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  const runnerPath = join(runnerDir, "interrupt-cleanup.mjs");
  writeFileSync(
    runnerPath,
    [
      `import { install } from ${JSON.stringify(
        pathToFileURL(join(repositoryRoot, "scripts/install.mjs")).href,
      )};`,
      `install(${JSON.stringify({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
      }).replace(/}$/, "")},`,
      "  onInstallEvent({ phase }) {",
      '    if (phase === "before-skill-backup-cleanup") process.exit(91);',
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  const interrupted = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
  });
  assert.equal(interrupted.status, 91, interrupted.stderr);

  const backupName = listEntries(skillsDir).find((entry) =>
    entry.startsWith(".other-skill.knights-backup-"),
  );
  assert.equal(typeof backupName, "string");
  const backupDir = join(skillsDir, backupName);
  const untrackedContent = Buffer.from("do not delete\n");
  writeFileSync(join(backupDir, "untracked.txt"), untrackedContent);

  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.priorFiles.push({
    path: "untracked.txt",
    sha256: sha256(untrackedContent),
  });
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
      }),
    /manifest|untracked|forged|files do not match/i,
  );
  assert.equal(
    readFileSync(join(backupDir, "untracked.txt"), "utf8"),
    "do not delete\n",
  );
});

test("recovery refuses a nonempty skill backup whose ownership manifest is missing", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const installedSkillDir = join(home, ".claude/skills/other-skill");
  const skillsDir = dirname(installedSkillDir);
  const runnerDir = tempDir("knights-install-missing-backup-manifest-");
  t.after(() => rmSync(runnerDir, { recursive: true, force: true }));

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  const runnerPath = join(runnerDir, "interrupt-cleanup.mjs");
  writeFileSync(
    runnerPath,
    [
      `import { install } from ${JSON.stringify(
        pathToFileURL(join(repositoryRoot, "scripts/install.mjs")).href,
      )};`,
      `install(${JSON.stringify({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
      }).replace(/}$/, "")},`,
      "  onInstallEvent({ phase }) {",
      '    if (phase === "before-skill-backup-cleanup") process.exit(92);',
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  const interrupted = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
  });
  assert.equal(interrupted.status, 92, interrupted.stderr);

  const backupName = listEntries(skillsDir).find((entry) =>
    entry.startsWith(".other-skill.knights-backup-"),
  );
  assert.equal(typeof backupName, "string");
  const backupDir = join(skillsDir, backupName);
  rmSync(join(backupDir, ".knights-install.json"));

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
      }),
    /ownership manifest.*missing|manifest.*required/i,
  );
  assert.equal(
    readFileSync(join(backupDir, "NOTES.md"), "utf8"),
    "Additional fixture file.\n",
  );
});

test("keeps backup ownership metadata until payload cleanup completes", (t) => {
  const projectRoot = withFixture(t);
  const sourceSkillDir = createGenericSkillFixture(projectRoot, "other-skill");
  const home = withHome(t);
  const installedSkillDir = join(home, ".claude/skills/other-skill");
  const skillsDir = dirname(installedSkillDir);
  const runnerDir = tempDir("knights-install-manifest-last-runner-");
  t.after(() => rmSync(runnerDir, { recursive: true, force: true }));

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
  });
  writeFileSync(join(sourceSkillDir, "NOTES.md"), "updated fixture bytes\n");

  const runnerPath = join(runnerDir, "interrupt-manifest-cleanup.mjs");
  writeFileSync(
    runnerPath,
    [
      `import { install } from ${JSON.stringify(
        pathToFileURL(join(repositoryRoot, "scripts/install.mjs")).href,
      )};`,
      `install(${JSON.stringify({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
        force: true,
      }).replace(/}$/, "")},`,
      "  onInstallEvent({ phase }) {",
      '    if (phase === "before-skill-backup-manifest-cleanup") process.exit(93);',
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  const interrupted = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
  });
  assert.equal(interrupted.status, 93, interrupted.stderr);
  assert.equal(
    readFileSync(join(installedSkillDir, "NOTES.md"), "utf8"),
    "updated fixture bytes\n",
  );

  const backupName = listEntries(skillsDir).find((entry) =>
    entry.startsWith(".other-skill.knights-backup-"),
  );
  assert.equal(typeof backupName, "string");
  assert.deepEqual(listEntries(join(skillsDir, backupName)), [
    ".knights-install.json",
  ]);

  install({
    projectRoot,
    home,
    skill: "other-skill",
    harnesses: ["claude"],
    force: true,
  });

  assert.deepEqual(listEntries(skillsDir), ["other-skill"]);
});

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

// If the skill directory and every owned agent payload file are removed by
// hand but the valid,
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

// `validateGeneratedAgents` lstat-checks the final generated agent *files*
// and must also check whether
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

test("rejects unsafe source skill paths before any destination mutation", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows cannot create a filename containing a colon");
    return;
  }

  const projectRoot = withFixture(t);
  const skillDir = createGenericSkillFixture(projectRoot, "other-skill");
  writeFileSync(join(skillDir, "notes:v1.md"), "unsafe path fixture\n");
  const home = withHome(t);

  assert.throws(
    () =>
      install({
        projectRoot,
        home,
        skill: "other-skill",
        harnesses: ["claude"],
      }),
    /skill source contains an unsafe path: notes:v1\.md/i,
  );

  assert.deepEqual(listEntries(home), []);
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
