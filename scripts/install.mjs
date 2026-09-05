import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { isMainModule } from "./is-main-module.mjs";
import { isSafeRelativePath } from "./validate.mjs";
import { renderAll } from "./render-agents.mjs";

const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SKILL = "knights-of-the-round-table";
const MANIFEST_FILENAME = ".knights-install.json";
const MANIFEST_SCHEMA_VERSION = 1;
const INSTALLER_ID = "knights-install";
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Canonical harness order: every list this module produces (installedPaths,
// manifest.harnesses, CLI output) is sorted according to this order so
// results stay deterministic regardless of the order harnesses were passed
// in.
const ALL_HARNESSES = ["claude", "copilot", "codex", "gemini"];

// Physical skill install directories. Codex and Gemini intentionally share
// one physical directory: item 6 requires a single copy/manifest, not one
// per harness.
const SKILL_INSTALL_GROUPS = [
  { id: "claude", harnesses: ["claude"], relativeDir: (skill) => `.claude/skills/${skill}` },
  { id: "copilot", harnesses: ["copilot"], relativeDir: (skill) => `.copilot/skills/${skill}` },
  { id: "agents", harnesses: ["codex", "gemini"], relativeDir: (skill) => `.agents/skills/${skill}` },
];

const AGENT_HARNESS_DIRS = {
  claude: ".claude/agents",
  copilot: ".copilot/agents",
  codex: ".codex/agents",
  gemini: ".gemini/agents",
};

// Where the checked-in generated reviewer agents live in the source
// repository, mirroring render-agents.mjs's HARNESS_DIRECTORIES.
const GENERATED_AGENT_SOURCE_DIRS = {
  claude: "generated/claude/agents",
  copilot: "agents",
  codex: "generated/codex/agents",
  gemini: "generated/gemini/agents",
};

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isContainedPath(root, path) {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function buildManifest({ skill, skillVersion, source, harnesses, files }) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    installer: INSTALLER_ID,
    skill,
    skillVersion,
    source,
    harnesses: [...harnesses],
    files: [...files]
      .map(({ path, sha256: hash }) => ({ path, sha256: hash }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function assertValidManifestShape(manifest, manifestPath) {
  const valid =
    manifest !== null &&
    typeof manifest === "object" &&
    !Array.isArray(manifest) &&
    manifest.schemaVersion === MANIFEST_SCHEMA_VERSION &&
    manifest.installer === INSTALLER_ID &&
    typeof manifest.skill === "string" &&
    typeof manifest.skillVersion === "string" &&
    typeof manifest.source === "string" &&
    Array.isArray(manifest.harnesses) &&
    manifest.harnesses.every((harness) => typeof harness === "string") &&
    Array.isArray(manifest.files) &&
    manifest.files.every(
      (file) =>
        file !== null &&
        typeof file === "object" &&
        typeof file.path === "string" &&
        typeof file.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(file.sha256),
    );

  if (!valid) {
    throw new Error(`Invalid ownership manifest: ${manifestPath}`);
  }
}

function readManifestIfExists(directory) {
  const manifestPath = join(directory, MANIFEST_FILENAME);
  const stat = lstatIfExists(manifestPath);
  if (stat === null) {
    return { exists: false };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `Refusing to install: ownership manifest must be a regular file: ${manifestPath}`,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Refusing to install: unable to parse ownership manifest: ${manifestPath}`,
    );
  }
  assertValidManifestShape(manifest, manifestPath);
  return { exists: true, manifest, manifestPath };
}

// Walks an *existing destination* directory tree, rejecting symlinks and any
// non-regular entries before mutation (item 12). The top-level manifest file
// is metadata, not tracked payload, and is excluded from the result.
function walkExistingDestinationFiles(rootDir) {
  const files = [];

  function walk(currentDir, relativeDir) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = join(currentDir, entry.name);
      const relativePath =
        relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;

      if (relativeDir === "" && entry.name === MANIFEST_FILENAME) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Refusing to install: existing destination contains a symlink: ${entryPath}`,
        );
      }
      if (entry.isDirectory()) {
        walk(entryPath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `Refusing to install: existing destination contains an unsupported entry: ${entryPath}`,
        );
      }
      files.push(toPosixPath(relativePath));
    }
  }

  walk(rootDir, "");
  return files.sort();
}

function assertManifestFilesUncorrupted(directory, files) {
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      throw new Error(
        `Refusing to install: ownership manifest references an unsafe path: ${file.path}`,
      );
    }
    const filePath = resolve(directory, file.path);
    if (!isContainedPath(resolve(directory), filePath)) {
      throw new Error(
        `Refusing to install: ownership manifest references a path outside the target: ${file.path}`,
      );
    }
    const stat = lstatIfExists(filePath);
    if (stat === null) {
      throw new Error(
        `Refusing to install: ownership manifest file is missing: ${filePath}`,
      );
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `Refusing to install: ownership manifest file must be a regular file: ${filePath}`,
      );
    }
    const actualHash = sha256(readFileSync(filePath));
    if (actualHash !== file.sha256) {
      throw new Error(
        `Refusing to install: file has drifted from the installer manifest, refusing to modify it: ${filePath}`,
      );
    }
  }
}

// No ancestor path component between `home` and `targetDir` (exclusive of
// the final target) may be a symlink or a non-directory. This is what makes
// `<home>/.claude -> external` fail before any mutation (item 12/13).
function assertSafeAncestors(resolvedHome, targetDir, description) {
  const relativePath = relative(resolvedHome, targetDir);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${description} escapes the home directory: ${targetDir}`);
  }

  const homeStat = lstatIfExists(resolvedHome);
  if (homeStat === null || !homeStat.isDirectory()) {
    throw new Error(`Home directory does not exist: ${resolvedHome}`);
  }

  const segments = relativePath.split(sep);
  let current = resolvedHome;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index]);
    const stat = lstatIfExists(current);
    if (stat === null) {
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `${description} path component must not be a symlink: ${current}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `${description} path component is not a directory: ${current}`,
      );
    }
  }
}

function assertSafeSkillName(skill) {
  if (typeof skill !== "string" || skill.length === 0) {
    throw new Error("Skill name must be a non-empty string");
  }
  if (
    skill.includes("/") ||
    !isSafeRelativePath(skill) ||
    !SKILL_NAME_PATTERN.test(skill)
  ) {
    throw new Error(`Unsafe skill name: ${skill}`);
  }
}

function normalizeHarnesses(rawHarnesses) {
  if (!Array.isArray(rawHarnesses) || rawHarnesses.length === 0) {
    throw new Error("At least one harness must be selected");
  }

  const expanded = rawHarnesses.flatMap((harness) =>
    harness === "all" ? ALL_HARNESSES : [harness],
  );
  for (const harness of expanded) {
    if (!ALL_HARNESSES.includes(harness)) {
      throw new Error(
        `Unknown harness: ${harness} (expected one of ${ALL_HARNESSES.join(", ")}, all)`,
      );
    }
  }

  const selected = new Set(expanded);
  return ALL_HARNESSES.filter((harness) => selected.has(harness));
}

function parseFrontmatter(text, sourceLabel) {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) {
    throw new Error(`${sourceLabel}: missing YAML frontmatter`);
  }
  const value = YAML.parse(match[1]);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceLabel}: frontmatter must be a mapping`);
  }
  return value;
}

// Recursively reads the source skill directory, rejecting symlinks and any
// non-regular entries, and returns the sorted file list with content and
// hashes (item 11).
function readSourceSkillTree(skillDir, realSkillDir) {
  const files = [];

  function walk(currentDir, relativeDir) {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name);
      const relativePath =
        relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        throw new Error(
          `Skill source contains a symlink: ${relativePath}`,
        );
      }
      if (entry.isDirectory()) {
        walk(entryPath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `Skill source contains an unsupported entry: ${relativePath}`,
        );
      }

      const realEntryPath = realpathSync(entryPath);
      if (!isContainedPath(realSkillDir, realEntryPath)) {
        throw new Error(
          `Skill source escapes the skill directory: ${relativePath}`,
        );
      }

      const content = readFileSync(entryPath);
      files.push({
        relativePath: toPosixPath(relativePath),
        content,
        sha256: sha256(content),
      });
    }
  }

  walk(skillDir, "");
  return files;
}

// Validates every source input (project root, skill tree, version metadata,
// and, for the canonical skill, the renderer config/prompts and every
// generated reviewer agent) before any destination mutation (item 11).
function validateSource({ projectRoot, skill, harnesses }) {
  const resolvedProjectRoot = resolve(projectRoot);
  let realProjectRoot;
  try {
    realProjectRoot = realpathSync(resolvedProjectRoot);
  } catch {
    throw new Error(
      `Source project root does not exist: ${resolvedProjectRoot}`,
    );
  }
  const projectRootStat = lstatSync(realProjectRoot);
  if (!projectRootStat.isDirectory()) {
    throw new Error(
      `Source project root must be a directory: ${resolvedProjectRoot}`,
    );
  }

  const skillsRoot = resolve(resolvedProjectRoot, "skills");
  const skillDir = resolve(skillsRoot, skill);
  if (dirname(skillDir) !== skillsRoot) {
    throw new Error(`Unsafe skill name: ${skill}`);
  }

  const skillStat = lstatIfExists(skillDir);
  if (skillStat === null || skillStat.isSymbolicLink() || !skillStat.isDirectory()) {
    throw new Error(`Unknown skill: ${skill}`);
  }

  const realSkillDir = realpathSync(skillDir);
  if (!isContainedPath(realProjectRoot, realSkillDir)) {
    throw new Error(`Skill source escapes the project root: ${skill}`);
  }

  const files = readSourceSkillTree(skillDir, realSkillDir);

  const skillMdFile = files.find((file) => file.relativePath === "SKILL.md");
  if (!skillMdFile) {
    throw new Error(`Skill source is missing SKILL.md: ${skill}`);
  }
  const frontmatter = parseFrontmatter(
    skillMdFile.content.toString("utf8"),
    `${skill}/SKILL.md`,
  );
  if (frontmatter.name !== skill) {
    throw new Error(
      `Skill source SKILL.md name must match the skill directory: ${skill}`,
    );
  }
  const skillVersion = frontmatter.metadata?.version;
  if (typeof skillVersion !== "string" || skillVersion.length === 0) {
    throw new Error(
      `Skill source SKILL.md is missing metadata.version: ${skill}`,
    );
  }

  const isKnightsSkill = skill === DEFAULT_SKILL;
  const generatedAgents = isKnightsSkill
    ? validateGeneratedAgents({ projectRoot: resolvedProjectRoot, harnesses })
    : {};

  return {
    resolvedProjectRoot,
    skillDir,
    skillVersion,
    files,
    isKnightsSkill,
    generatedAgents,
  };
}

// Renders the canonical reviewer agents from source (validating the
// reviewer config and prompts as a side effect) and confirms that every
// checked-in generated agent for each selected harness is a regular,
// non-symlink file whose contents match that render output (item 11).
function validateGeneratedAgents({ projectRoot, harnesses }) {
  const rendered = renderAll({ projectRoot });
  const result = {};

  for (const harness of harnesses) {
    const directory = resolve(
      projectRoot,
      GENERATED_AGENT_SOURCE_DIRS[harness],
    );
    const files = [];
    for (const [filename, expectedContent] of Object.entries(
      rendered[harness],
    )) {
      const filePath = join(directory, filename);
      const stat = lstatIfExists(filePath);
      if (stat === null) {
        throw new Error(
          `Missing generated reviewer agent for ${harness}: ${filename}`,
        );
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
          `Generated reviewer agent must be a regular file for ${harness}: ${filename}`,
        );
      }
      const actualContent = readFileSync(filePath, "utf8");
      if (actualContent !== expectedContent) {
        throw new Error(
          `Generated reviewer agent is out of date for ${harness}: ${filename}`,
        );
      }
      const buffer = Buffer.from(actualContent, "utf8");
      files.push({ filename, content: buffer, sha256: sha256(buffer) });
    }
    result[harness] = files;
  }

  return result;
}

function mergedHarnesses(existingHarnesses, selectedHarnesses, allowedHarnesses) {
  const merged = new Set();
  for (const harness of existingHarnesses ?? []) {
    if (allowedHarnesses.includes(harness)) {
      merged.add(harness);
    }
  }
  for (const harness of selectedHarnesses) {
    if (allowedHarnesses.includes(harness)) {
      merged.add(harness);
    }
  }
  return allowedHarnesses.filter((harness) => merged.has(harness));
}

// Determines whether an existing skill install directory may be replaced.
// Throws (refusing to mutate anything) unless the directory is missing, or
// it is fully owned by a valid prior manifest, every listed file's hash
// still matches, and `force` was passed (items 8, 9, 10).
function preflightSkillGroup({ targetDir, force }) {
  const stat = lstatIfExists(targetDir);
  if (stat === null) {
    return { existed: false, priorHarnesses: [] };
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to install: destination must not be a symlink: ${targetDir}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Refusing to install: destination is not a directory: ${targetDir}`,
    );
  }

  const manifestResult = readManifestIfExists(targetDir);
  if (!manifestResult.exists) {
    throw new Error(
      `Refusing to install: an unmanaged path already exists: ${targetDir}`,
    );
  }

  const actualFiles = walkExistingDestinationFiles(targetDir);
  const manifestFiles = manifestResult.manifest.files
    .map((file) => file.path)
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(manifestFiles)) {
    throw new Error(
      `Refusing to install: existing files do not match the installer manifest: ${targetDir}`,
    );
  }
  assertManifestFilesUncorrupted(targetDir, manifestResult.manifest.files);

  if (!force) {
    throw new Error(
      `Refusing to install: already installed at ${targetDir} (pass --force to update)`,
    );
  }

  return { existed: true, priorHarnesses: manifestResult.manifest.harnesses };
}

// Per-file ownership check for a shared agent directory (item 8, 9, 10):
// unrelated files are always preserved, unowned collisions always refuse
// (even with force), and owned collisions require --force and a matching
// hash.
function preflightAgentGroup({ targetDir, requiredFilenames, force }) {
  const stat = lstatIfExists(targetDir);
  if (stat !== null) {
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to install: agent directory must not be a symlink: ${targetDir}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `Refusing to install: agent path is not a directory: ${targetDir}`,
      );
    }
  }

  const manifestResult = readManifestIfExists(targetDir);
  const ownedHashes = new Map();
  if (manifestResult.exists) {
    for (const file of manifestResult.manifest.files) {
      ownedHashes.set(file.path, file.sha256);
    }
  }

  let hasOwnedCollision = false;
  for (const filename of requiredFilenames) {
    const filePath = join(targetDir, filename);
    const fileStat = lstatIfExists(filePath);
    if (fileStat === null) {
      continue;
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(
        `Refusing to install: existing agent file must be a regular file: ${filePath}`,
      );
    }
    if (!ownedHashes.has(filename)) {
      throw new Error(
        `Refusing to install: an unmanaged agent file already exists: ${filePath}`,
      );
    }
    const actualHash = sha256(readFileSync(filePath));
    if (actualHash !== ownedHashes.get(filename)) {
      throw new Error(
        `Refusing to install: file has drifted from the installer manifest, refusing to modify it: ${filePath}`,
      );
    }
    hasOwnedCollision = true;
  }

  if (hasOwnedCollision && !force) {
    throw new Error(
      `Refusing to install: agent files already installed at ${targetDir} (pass --force to update)`,
    );
  }
}

function installSkillGroup({
  group,
  targetDir,
  existed,
  finalHarnesses,
  skill,
  skillVersion,
  sourceSkillDir,
  sourceFiles,
  resolvedProjectRoot,
}) {
  if (existed) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceSkillDir, targetDir, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
  });

  const manifest = buildManifest({
    skill,
    skillVersion,
    source: resolvedProjectRoot,
    harnesses: finalHarnesses,
    files: sourceFiles.map((file) => ({
      path: file.relativePath,
      sha256: file.sha256,
    })),
  });
  writeFileSync(join(targetDir, MANIFEST_FILENAME), serializeManifest(manifest));

  return [
    targetDir,
    ...sourceFiles.map((file) => join(targetDir, file.relativePath)),
    join(targetDir, MANIFEST_FILENAME),
  ];
}

function installAgentGroup({
  targetDir,
  harness,
  files,
  skill,
  skillVersion,
  resolvedProjectRoot,
}) {
  mkdirSync(targetDir, { recursive: true });
  const installedPaths = [];
  for (const file of files) {
    const filePath = join(targetDir, file.filename);
    writeFileSync(filePath, file.content);
    installedPaths.push(filePath);
  }

  const manifest = buildManifest({
    skill,
    skillVersion,
    source: resolvedProjectRoot,
    harnesses: [harness],
    files: files.map((file) => ({ path: file.filename, sha256: file.sha256 })),
  });
  const manifestPath = join(targetDir, MANIFEST_FILENAME);
  writeFileSync(manifestPath, serializeManifest(manifest));
  installedPaths.push(manifestPath);

  return installedPaths;
}

export function install(options = {}) {
  const skill = options.skill ?? DEFAULT_SKILL;
  assertSafeSkillName(skill);

  const harnesses = normalizeHarnesses(options.harnesses ?? ["all"]);
  const force = options.force === true;
  const resolvedHome = resolve(options.home ?? homedir());
  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;

  // Phase 1: validate every source input. Nothing under `home` is touched
  // yet, so any failure here leaves the home directory byte-for-byte
  // unmodified (item 11).
  const source = validateSource({ projectRoot, skill, harnesses });

  // Phase 2: build the destination plan (pure data, no filesystem access).
  const skillGroups = SKILL_INSTALL_GROUPS.filter((group) =>
    group.harnesses.some((harness) => harnesses.includes(harness)),
  ).map((group) => ({
    ...group,
    selectedHarnesses: group.harnesses.filter((harness) =>
      harnesses.includes(harness),
    ),
    targetDir: resolve(resolvedHome, group.relativeDir(skill)),
  }));

  const agentGroups = source.isKnightsSkill
    ? harnesses.map((harness) => ({
        harness,
        targetDir: resolve(resolvedHome, AGENT_HARNESS_DIRS[harness]),
        files: source.generatedAgents[harness],
      }))
    : [];

  // Phase 3: preflight every selected harness's destination before any
  // mutation, so a collision or safety failure in one harness causes zero
  // changes to every harness (item 13).
  const skillPreflight = skillGroups.map((group) => {
    assertSafeAncestors(resolvedHome, group.targetDir, "Skill destination");
    const { existed, priorHarnesses } = preflightSkillGroup({
      targetDir: group.targetDir,
      force,
    });
    return {
      group,
      existed,
      finalHarnesses: mergedHarnesses(
        priorHarnesses,
        group.selectedHarnesses,
        group.harnesses,
      ),
    };
  });

  for (const agentGroup of agentGroups) {
    assertSafeAncestors(
      resolvedHome,
      agentGroup.targetDir,
      "Agent destination",
    );
    preflightAgentGroup({
      targetDir: agentGroup.targetDir,
      requiredFilenames: agentGroup.files.map((file) => file.filename),
      force,
    });
  }

  // Phase 4: every check above passed, so it is now safe to mutate.
  const installedPaths = [];

  for (const { group, existed, finalHarnesses } of skillPreflight) {
    installedPaths.push(
      ...installSkillGroup({
        group,
        targetDir: group.targetDir,
        existed,
        finalHarnesses,
        skill,
        skillVersion: source.skillVersion,
        sourceSkillDir: source.skillDir,
        sourceFiles: source.files,
        resolvedProjectRoot: source.resolvedProjectRoot,
      }),
    );
  }

  for (const agentGroup of agentGroups) {
    installedPaths.push(
      ...installAgentGroup({
        targetDir: agentGroup.targetDir,
        harness: agentGroup.harness,
        files: agentGroup.files,
        skill,
        skillVersion: source.skillVersion,
        resolvedProjectRoot: source.resolvedProjectRoot,
      }),
    );
  }

  return {
    skill,
    skillVersion: source.skillVersion,
    harnesses,
    force,
    home: resolvedHome,
    installedPaths: [...new Set(installedPaths)].sort(),
  };
}

function parseCliArgs(argv) {
  const options = { skill: undefined, harnesses: [], home: undefined, force: false };
  const seenSingular = new Set();
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];

    if (arg === "--force") {
      if (options.force) {
        throw new Error("Duplicate flag: --force");
      }
      options.force = true;
      index += 1;
      continue;
    }

    if (arg === "--skill" || arg === "--home") {
      const key = arg.slice(2);
      if (seenSingular.has(key)) {
        throw new Error(`Duplicate flag: ${arg}`);
      }
      seenSingular.add(key);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      options[key] = value;
      index += 2;
      continue;
    }

    if (arg === "--harness") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("Missing value for --harness");
      }
      options.harnesses.push(value);
      index += 2;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.harnesses.length === 0) {
    throw new Error(
      `Missing required flag: --harness (expected one of ${ALL_HARNESSES.join(", ")}, all)`,
    );
  }

  return options;
}

function runCli() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  try {
    const result = install({
      skill: options.skill,
      harnesses: options.harnesses,
      home: options.home,
      force: options.force,
    });
    for (const path of result.installedPaths) {
      console.log(path);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  runCli();
}
