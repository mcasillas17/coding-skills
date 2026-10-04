import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";
import { parseYamlDocument } from "../skills/knights-of-the-round-table/scripts/parse-yaml.mjs";
import {
  assertValidConfig,
  isSafeRelativePath,
} from "../skills/knights-of-the-round-table/scripts/validate-config.mjs";

const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_RELATIVE_PATH = "config/reviewers.yaml";
const DEFAULT_SKILL_DIRECTORY = "skills/knights-of-the-round-table";
const MANIFEST_FILENAME = ".generated-agents.json";
const CLAUDE_MANIFEST_PATH = ".claude-plugin/plugin.json";
const HARNESS_DIRECTORIES = {
  claude: "generated/claude/agents",
  copilot: "agents",
  codex: "generated/codex/agents",
  gemini: "generated/gemini/agents",
};
const HARNESS_EXTENSIONS = {
  claude: ".md",
  copilot: ".agent.md",
  codex: ".toml",
  gemini: ".md",
};
const REVIEWER_DESCRIPTION =
  "Reviews correctness, tests, security, documentation, architecture, and performance without editing files.";

function quote(value) {
  return JSON.stringify(value);
}

function normalizePrompt(prompt) {
  return prompt.replace(/\r\n/g, "\n").trimEnd();
}

const renderers = {
  claude: ({ name, model, effort, description, prompt }) =>
    `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n` +
    `tools: Read, Grep, Glob\nmodel: ${quote(model)}\neffort: ${effort}\n---\n\n${prompt}\n`,
  copilot: ({ name, model, description, prompt }) =>
    `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n` +
    `tools: [read, search]\nmodel: ${quote(model)}\nuser-invocable: false\n---\n\n${prompt}\n`,
  codex: ({ name, model, effort, description, prompt }) =>
    `name = ${quote(name)}\ndescription = ${quote(description)}\n` +
    `model = ${quote(model)}\nmodel_reasoning_effort = ${quote(effort)}\nsandbox_mode = "read-only"\ndeveloper_instructions = ${quote(prompt)}\n`,
  gemini: ({ name, model, description, prompt }) =>
    `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n` +
    "tools:\n  - read_file\n  - grep_search\n  - glob\n  - list_directory\n" +
    `model: ${quote(model)}\n---\n\n${prompt}\n`,
};

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

function assertRealPathContained(realProjectRoot, path, description) {
  const realPath = realpathSync(path);
  if (!isContainedPath(realProjectRoot, realPath)) {
    throw new Error(`${description} resolves outside repository`);
  }
  return realPath;
}

function nearestExistingPath(path) {
  let currentPath = path;
  while (lstatIfExists(currentPath) === null) {
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`Unable to find existing parent for ${path}`);
    }
    currentPath = parentPath;
  }
  return currentPath;
}

// Check each component before reading, including optional config paths. Never
// follow a skill/config/prompt symlink, even when its target is inside the repo.
function reviewerInputPath(root, path, kind = "file", optional = false) {
  if (!isSafeRelativePath(path)) {
    throw new Error(`Unsafe reviewer input path: ${path}`);
  }
  let current = resolve(root);
  for (const part of path.split("/")) {
    current = resolve(current, part);
    const stats = optional ? lstatIfExists(current) : lstatSync(current);
    if (stats === null) return null;
    if (stats.isSymbolicLink()) {
      throw new Error(`Reviewer input must not be a symlink: ${current}`);
    }
  }
  const stats = lstatSync(current);
  if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(`${path} must be a ${kind === "directory" ? "directory" : "regular file"}`);
  }
  return assertRealPathContained(realpathSync(root), current, `Reviewer input ${path}`);
}

function loadConfig(skillRoot) {
  return parseYamlDocument(
    readFileSync(reviewerInputPath(skillRoot, CONFIG_RELATIVE_PATH), "utf8"),
    `reviewer configuration in ${skillRoot}`,
  );
}

function loadPrompts(config, skillRoot) {
  try {
    return { [config.prompt]: readFileSync(reviewerInputPath(skillRoot, config.prompt), "utf8") };
  } catch (error) {
    throw new Error(`whole-panel reviewer prompt: ${error.message}`, { cause: error });
  }
}

function outputFilename(harness, name) {
  return `${name}${HARNESS_EXTENSIONS[harness]}`;
}

export function renderAgents(config, prompts) {
  const rendered = Object.fromEntries(
    Object.keys(HARNESS_DIRECTORIES).map((harness) => [harness, {}]),
  );

  const prompt = normalizePrompt(prompts[config.prompt]);
  for (const harness of Object.keys(HARNESS_DIRECTORIES)) {
    const modelsById = new Map();
    for (const primary of config.panels[harness]) {
      for (const reviewer of [primary, primary.fallback].filter(Boolean)) {
        const { id: name, model } = reviewer;
        if (modelsById.has(name)) {
          if (modelsById.get(name) !== model) {
            throw new Error(`Conflicting reviewer ID for ${harness}: ${name}`);
          }
          continue;
        }
        modelsById.set(name, model);
        const filename = outputFilename(harness, name);
        rendered[harness][filename] = renderers[harness]({
          name,
          model,
          effort: config.reasoningEffort,
          description: REVIEWER_DESCRIPTION,
          prompt,
        });
      }
    }
  }

  return rendered;
}

// Shared by the repository renderer and validator so discovery, parsing, prompt
// resolution, and cross-skill filename ownership always use the same inputs.
export function renderRepositoryAgents({ projectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  const skillsRoot = reviewerInputPath(projectRoot, "skills", "directory");
  const entries = readdirSync(skillsRoot, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const rendered = Object.fromEntries(
    Object.keys(HARNESS_DIRECTORIES).map((harness) => [harness, {}]),
  );
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillRoot = reviewerInputPath(skillsRoot, entry.name, "directory");
    if (reviewerInputPath(skillRoot, CONFIG_RELATIVE_PATH, "file", true) === null) continue;
    const config = loadConfig(skillRoot);
    assertValidConfig(config);
    const skillAgents = renderAgents(config, loadPrompts(config, skillRoot));
    for (const [harness, files] of Object.entries(skillAgents)) {
      for (const [filename, content] of Object.entries(files)) {
        if (Object.hasOwn(rendered[harness], filename)) {
          throw new Error(`duplicate output filename for ${harness}: ${filename}`);
        }
        rendered[harness][filename] = content;
      }
    }
    skills.push({ name: entry.name, skillRoot, config });
  }
  if (skills.length === 0 || expectedOwnedPaths(rendered).length === 0) {
    throw new Error(`No reviewer agents discovered from skills/*/${CONFIG_RELATIVE_PATH}; refusing to synchronize generated outputs`);
  }
  return { rendered, skills };
}

export function renderAll(options = {}) {
  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
  // Keep this public API single-config, defaulting to the canonical skill.
  // Repository-wide callers must use renderRepositoryAgents explicitly.
  const skillRoot = resolve(projectRoot, DEFAULT_SKILL_DIRECTORY);
  const config = options.config ?? loadConfig(
    reviewerInputPath(projectRoot, DEFAULT_SKILL_DIRECTORY, "directory"),
  );
  assertValidConfig(config);
  const prompts = options.prompts ?? loadPrompts(config, skillRoot);
  return renderAgents(config, prompts);
}

function generatedPath(projectRoot, harness, relativePath) {
  const directory = resolve(projectRoot, HARNESS_DIRECTORIES[harness]);
  if (!isSafeRelativePath(relativePath) || relativePath.includes("/")) {
    throw new Error(`Unsafe generated agent path: ${relativePath}`);
  }
  const path = resolve(directory, relativePath);
  if (dirname(path) !== directory) {
    throw new Error(`Unsafe generated agent path: ${relativePath}`);
  }
  return path;
}

function expectedOwnedPaths(rendered) {
  return Object.entries(rendered)
    .flatMap(([harness, files]) =>
      Object.keys(files).map(
        (relativePath) =>
          `${HARNESS_DIRECTORIES[harness]}/${relativePath}`,
      ),
    )
    .sort();
}

function ownedOutputPath(projectRoot, ownedPath) {
  if (!isSafeRelativePath(ownedPath)) {
    throw new Error(`Unsafe generated ownership path: ${ownedPath}`);
  }

  for (const [harness, directory] of Object.entries(HARNESS_DIRECTORIES)) {
    const prefix = `${directory}/`;
    if (!ownedPath.startsWith(prefix)) {
      continue;
    }
    const relativePath = ownedPath.slice(prefix.length);
    if (
      relativePath.includes("/") ||
      !relativePath.endsWith(HARNESS_EXTENSIONS[harness])
    ) {
      break;
    }
    return generatedPath(projectRoot, harness, relativePath);
  }

  throw new Error(`Unsafe generated ownership path: ${ownedPath}`);
}

function ownershipManifestPath(projectRoot) {
  return resolve(projectRoot, MANIFEST_FILENAME);
}

function serializeManifest(files) {
  return `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
}

function assertDirectoryParentContained(
  projectRoot,
  realProjectRoot,
  directory,
  description,
) {
  if (!isContainedPath(projectRoot, directory)) {
    throw new Error(`${description} escapes repository`);
  }

  const existingPath = nearestExistingPath(directory);
  const realExistingPath = assertRealPathContained(
    realProjectRoot,
    existingPath,
    description,
  );
  if (!lstatSync(realExistingPath).isDirectory()) {
    throw new Error(`${description} parent must be a directory`);
  }
}

function assertHarnessDirectorySafe(
  projectRoot,
  realProjectRoot,
  harness,
) {
  const relativeDirectory = HARNESS_DIRECTORIES[harness];
  const directory = resolve(projectRoot, relativeDirectory);
  const stats = lstatIfExists(directory);

  if (stats?.isSymbolicLink()) {
    throw new Error(
      `Harness output directory must not be a symlink: ${relativeDirectory}`,
    );
  }
  if (stats !== null && !stats.isDirectory()) {
    throw new Error(
      `Harness output directory must be a directory: ${relativeDirectory}`,
    );
  }

  assertDirectoryParentContained(
    projectRoot,
    realProjectRoot,
    directory,
    `Harness output directory ${relativeDirectory}`,
  );
}

function assertWritableFileTarget(
  projectRoot,
  realProjectRoot,
  path,
  description,
  relativePath,
) {
  if (!isContainedPath(projectRoot, path)) {
    throw new Error(`${description} escapes repository: ${relativePath}`);
  }

  assertDirectoryParentContained(
    projectRoot,
    realProjectRoot,
    dirname(path),
    `${description} ${relativePath}`,
  );

  const stats = lstatIfExists(path);
  if (stats?.isSymbolicLink()) {
    throw new Error(`${description} must not be a symlink: ${relativePath}`);
  }
  if (stats !== null && !stats.isFile()) {
    throw new Error(`${description} must be a regular file: ${relativePath}`);
  }
  if (stats !== null) {
    assertRealPathContained(
      realProjectRoot,
      path,
      `${description} ${relativePath}`,
    );
  }
}

function assertDeletableOwnedTarget(
  projectRoot,
  realProjectRoot,
  path,
  description,
) {
  if (!isContainedPath(projectRoot, path)) {
    throw new Error(`${description} escapes repository`);
  }

  assertDirectoryParentContained(
    projectRoot,
    realProjectRoot,
    dirname(path),
    description,
  );

  const stats = lstatIfExists(path);
  if (
    stats !== null &&
    !stats.isFile() &&
    !stats.isSymbolicLink()
  ) {
    throw new Error(`${description} must be a regular file or symlink`);
  }
  if (stats?.isFile()) {
    assertRealPathContained(realProjectRoot, path, description);
  }
}

function loadOwnershipManifest(projectRoot) {
  let contents;
  try {
    contents = readFileSync(ownershipManifestPath(projectRoot), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, files: [], contents: null };
    }
    throw error;
  }

  let manifest;
  try {
    manifest = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Unable to parse ${MANIFEST_FILENAME}: ${error.message}`);
  }

  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(`${MANIFEST_FILENAME} must contain version 1 and files`);
  }

  const files = [];
  const seenFiles = new Set();
  for (const ownedPath of manifest.files) {
    if (typeof ownedPath !== "string") {
      throw new Error(`${MANIFEST_FILENAME} files must be strings`);
    }
    ownedOutputPath(projectRoot, ownedPath);
    if (seenFiles.has(ownedPath)) {
      throw new Error(`${MANIFEST_FILENAME} contains duplicate paths`);
    }
    seenFiles.add(ownedPath);
    files.push(ownedPath);
  }

  return { exists: true, files, contents };
}

function loadClaudeManifest(projectRoot, rendered) {
  const root = resolve(projectRoot);
  const path = resolve(root, CLAUDE_MANIFEST_PATH);
  if (lstatIfExists(dirname(path))?.isSymbolicLink()) {
    throw new Error("Claude plugin manifest directory must not be a symlink");
  }
  assertWritableFileTarget(root, realpathSync(root), path,
    "Claude plugin manifest target", CLAUDE_MANIFEST_PATH);
  // The renderer owns only agents, never the plugin's other metadata.
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${CLAUDE_MANIFEST_PATH} must contain a JSON object`);
  }
  const agents = Object.keys(rendered.claude).sort()
    .map((filename) => `./${HARNESS_DIRECTORIES.claude}/${filename}`);
  return {
    path,
    drifted: JSON.stringify(manifest.agents) !== JSON.stringify(agents),
    contents: `${JSON.stringify({ ...manifest, agents }, null, 2)}\n`,
  };
}

function findDrift(projectRoot, rendered, manifest, claudeManifest) {
  const drift = [];
  const expectedFiles = expectedOwnedPaths(rendered);
  const expectedFileSet = new Set(expectedFiles);

  for (const [harness, files] of Object.entries(rendered)) {
    for (const [relativePath, expected] of Object.entries(files)) {
      const path = generatedPath(projectRoot, harness, relativePath);
      let actual;
      try {
        actual = readFileSync(path, "utf8");
      } catch {
        drift.push(`${HARNESS_DIRECTORIES[harness]}/${relativePath}`);
        continue;
      }
      if (actual !== expected) {
        drift.push(`${HARNESS_DIRECTORIES[harness]}/${relativePath}`);
      }
    }
  }

  if (
    !manifest.exists ||
    manifest.contents !== serializeManifest(expectedFiles)
  ) {
    drift.push(MANIFEST_FILENAME);
  }
  if (claudeManifest.drifted) {
    drift.push(CLAUDE_MANIFEST_PATH);
  }

  for (const ownedPath of manifest.files) {
    if (!expectedFileSet.has(ownedPath)) {
      drift.push(ownedPath);
    }
  }

  return [...new Set(drift)].sort();
}

function assertOutputPathsSafe(projectRoot, rendered) {
  const resolvedProjectRoot = resolve(projectRoot);
  const realProjectRoot = realpathSync(resolvedProjectRoot);
  if (!lstatSync(realProjectRoot).isDirectory()) {
    throw new Error("Project root must be a directory");
  }

  for (const [harness, files] of Object.entries(rendered)) {
    assertHarnessDirectorySafe(
      resolvedProjectRoot,
      realProjectRoot,
      harness,
    );
    for (const relativePath of Object.keys(files)) {
      assertWritableFileTarget(
        resolvedProjectRoot,
        realProjectRoot,
        generatedPath(resolvedProjectRoot, harness, relativePath),
        "Generated output target",
        `${HARNESS_DIRECTORIES[harness]}/${relativePath}`,
      );
    }
  }

  assertWritableFileTarget(
    resolvedProjectRoot,
    realProjectRoot,
    ownershipManifestPath(resolvedProjectRoot),
    "Ownership manifest target",
    MANIFEST_FILENAME,
  );

  return { resolvedProjectRoot, realProjectRoot };
}

function assertOwnedDeletionPathsSafe(
  resolvedProjectRoot,
  realProjectRoot,
  rendered,
  manifest,
) {
  const expectedFileSet = new Set(expectedOwnedPaths(rendered));
  for (const ownedPath of manifest.files) {
    if (!expectedFileSet.has(ownedPath)) {
      assertDeletableOwnedTarget(
        resolvedProjectRoot,
        realProjectRoot,
        ownedOutputPath(resolvedProjectRoot, ownedPath),
        `Owned generated output ${ownedPath}`,
      );
    }
  }
}

function synchronizeOwnedOutputs(projectRoot, rendered, manifest) {
  const expectedFiles = expectedOwnedPaths(rendered);
  const expectedFileSet = new Set(expectedFiles);

  for (const [harness, files] of Object.entries(rendered)) {
    const directory = resolve(projectRoot, HARNESS_DIRECTORIES[harness]);
    mkdirSync(directory, { recursive: true });
    for (const [relativePath, content] of Object.entries(files)) {
      writeFileSync(
        generatedPath(projectRoot, harness, relativePath),
        content,
      );
    }
  }

  for (const ownedPath of manifest.files) {
    if (!expectedFileSet.has(ownedPath)) {
      rmSync(ownedOutputPath(projectRoot, ownedPath), { force: true });
    }
  }

  writeFileSync(
    ownershipManifestPath(projectRoot),
    serializeManifest(expectedFiles),
  );
}

function assertNoUnownedOutputCollisions(projectRoot, rendered, manifest) {
  const ownedPaths = new Set(manifest.files);
  for (const path of expectedOwnedPaths(rendered)) {
    if (!ownedPaths.has(path) && lstatIfExists(ownedOutputPath(projectRoot, path)) !== null) {
      throw new Error(`Refusing to overwrite unowned generated output: ${path}`);
    }
  }
}

// Read-only verification also accepts rendered agents collected from multiple skills.
export function checkGeneratedAgents(rendered, { projectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  assertOutputPathsSafe(projectRoot, rendered);
  const manifest = loadOwnershipManifest(projectRoot);
  const claudeManifest = loadClaudeManifest(projectRoot, rendered);
  return {
    drift: findDrift(projectRoot, rendered, manifest, claudeManifest),
    fileCount: Object.values(rendered).reduce(
      (count, files) => count + Object.keys(files).length,
      0,
    ),
  };
}

export function synchronizeGeneratedAgents(options = {}) {
  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const rendered = options.config == null && options.prompts == null
    ? renderRepositoryAgents({ projectRoot }).rendered
    : renderAll({
      projectRoot,
      config: options.config,
      prompts: options.prompts,
    });
  if (options.check) {
    return checkGeneratedAgents(rendered, { projectRoot });
  }
  const { resolvedProjectRoot, realProjectRoot } = assertOutputPathsSafe(
    projectRoot,
    rendered,
  );
  const manifest = loadOwnershipManifest(projectRoot);
  const claudeManifest = loadClaudeManifest(projectRoot, rendered);
  const drift = findDrift(projectRoot, rendered, manifest, claudeManifest);
  const fileCount = Object.values(rendered).reduce(
    (count, files) => count + Object.keys(files).length,
    0,
  );

  assertOwnedDeletionPathsSafe(
    resolvedProjectRoot,
    realProjectRoot,
    rendered,
    manifest,
  );
  assertNoUnownedOutputCollisions(projectRoot, rendered, manifest);
  synchronizeOwnedOutputs(projectRoot, rendered, manifest);
  if (claudeManifest.drifted) {
    writeFileSync(claudeManifest.path, claudeManifest.contents);
  }

  return { drift, fileCount };
}

function runCli() {
  const unknownArguments = process.argv
    .slice(2)
    .filter((arg) => arg !== "--check");
  if (unknownArguments.length > 0) {
    console.error(`Unknown argument: ${unknownArguments[0]}`);
    process.exitCode = 1;
    return;
  }

  const check = process.argv.includes("--check");
  let result;
  try {
    result = synchronizeGeneratedAgents({ check });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (check) {
    if (result.drift.length > 0) {
      console.error("Generated reviewer agents are out of date:");
      for (const path of result.drift) {
        console.error(`- ${path}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log("Generated reviewer agents are current.");
    return;
  }

  console.log(`Rendered ${result.fileCount} reviewer agents.`);
}

if (isMainModule(import.meta.url)) {
  runCli();
}
