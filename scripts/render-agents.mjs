import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { isMainModule } from "./is-main-module.mjs";
import { assertValidConfig, isSafeRelativePath } from "./validate.mjs";

const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_RELATIVE_PATH =
  "skills/knights-of-the-round-table/config/reviewers.yaml";
const PROMPT_DIRECTORY = "skills/knights-of-the-round-table";
const MANIFEST_FILENAME = ".generated-agents.json";
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
const REVIEWER_DESCRIPTIONS = {
  architecture:
    "Reviews boundaries, coupling, consistency, maintainability, and migration impact.",
  correctness:
    "Reviews requirements, logic, edge cases, regressions, and error paths.",
  documentation:
    "Reviews impacted setup, examples, API documentation, diagrams, and screenshots.",
  performance:
    "Reviews repeated I/O, algorithmic cost, memory, queries, network use, and caching.",
  security:
    "Reviews exploitable trust-boundary, authorization, injection, secret, and dependency risks.",
  tests:
    "Reviews behavioral coverage, false-positive tests, and untested failure paths.",
};

function quote(value) {
  return JSON.stringify(value);
}

function normalizePrompt(prompt) {
  return prompt.replace(/\r\n/g, "\n").trimEnd();
}

const renderers = {
  claude: ({ name, description, prompt }) =>
    `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n` +
    `tools: Read, Grep, Glob\nmodel: inherit\n---\n\n${prompt}\n`,
  copilot: ({ name, description, prompt }) =>
    `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n` +
    `tools: [read, search]\nuser-invocable: false\n---\n\n${prompt}\n`,
  codex: ({ name, description, prompt }) =>
    `name = ${quote(name)}\ndescription = ${quote(description)}\n` +
    `sandbox_mode = "read-only"\ndeveloper_instructions = ${quote(prompt)}\n`,
  gemini: ({ name, description, prompt }) =>
    `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n` +
    "tools:\n  - read_file\n  - grep_search\n  - glob\n  - list_directory\n" +
    `model: inherit\n---\n\n${prompt}\n`,
};

function toPosixPath(path) {
  return path.split(sep).join("/");
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

function loadConfig(projectRoot) {
  return YAML.parse(
    readFileSync(resolve(projectRoot, CONFIG_RELATIVE_PATH), "utf8"),
  );
}

function resolveContainedPromptPath(projectRoot, prompt) {
  if (!isSafeRelativePath(prompt)) {
    throw new Error(`Unsafe reviewer prompt path: ${prompt}`);
  }

  const promptRoot = resolve(projectRoot, PROMPT_DIRECTORY);
  const promptPath = resolve(promptRoot, prompt);
  const relativePromptPath = toPosixPath(relative(promptRoot, promptPath));
  if (!isSafeRelativePath(relativePromptPath)) {
    throw new Error(`Unsafe reviewer prompt path: ${prompt}`);
  }

  const realPromptRoot = realpathSync(promptRoot);
  const realPromptPath = realpathSync(promptPath);
  const realRelativePromptPath = toPosixPath(
    relative(realPromptRoot, realPromptPath),
  );
  if (!isSafeRelativePath(realRelativePromptPath)) {
    throw new Error(`Reviewer prompt escapes prompt directory: ${prompt}`);
  }
  return realPromptPath;
}

function loadPrompts(config, projectRoot) {
  return Object.fromEntries(
    config.reviewers.map(({ prompt }) => [
      prompt,
      readFileSync(resolveContainedPromptPath(projectRoot, prompt), "utf8"),
    ]),
  );
}

function outputFilename(harness, name) {
  return `${name}${HARNESS_EXTENSIONS[harness]}`;
}

export function renderAgents(config, prompts) {
  const rendered = Object.fromEntries(
    Object.keys(HARNESS_DIRECTORIES).map((harness) => [harness, {}]),
  );

  for (const reviewer of config.reviewers) {
    const prompt = normalizePrompt(prompts[reviewer.prompt]);
    const description =
      REVIEWER_DESCRIPTIONS[reviewer.role] ??
      `Reviews changes from the ${reviewer.role} perspective.`;

    for (const harness of Object.keys(HARNESS_DIRECTORIES)) {
      const name = reviewer.harnesses[harness];
      const filename = outputFilename(harness, name);
      if (Object.hasOwn(rendered[harness], filename)) {
        throw new Error(
          `duplicate output filename for ${harness}: ${filename}`,
        );
      }
      rendered[harness][filename] = renderers[harness]({
        name,
        description,
        prompt,
      });
    }
  }

  return rendered;
}

export function renderAll(options = {}) {
  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const config = options.config ?? loadConfig(projectRoot);
  assertValidConfig(config);
  const prompts = options.prompts ?? loadPrompts(config, projectRoot);
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

function findDrift(projectRoot, rendered, manifest) {
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

export function synchronizeGeneratedAgents(options = {}) {
  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const rendered = renderAll({
    projectRoot,
    config: options.config,
    prompts: options.prompts,
  });
  const { resolvedProjectRoot, realProjectRoot } = assertOutputPathsSafe(
    projectRoot,
    rendered,
  );
  const manifest = loadOwnershipManifest(projectRoot);
  const drift = findDrift(projectRoot, rendered, manifest);
  const fileCount = Object.values(rendered).reduce(
    (count, files) => count + Object.keys(files).length,
    0,
  );

  if (!options.check) {
    assertOwnedDeletionPathsSafe(
      resolvedProjectRoot,
      realProjectRoot,
      rendered,
      manifest,
    );
    synchronizeOwnedOutputs(projectRoot, rendered, manifest);
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
