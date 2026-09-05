import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { isMainModule } from "./is-main-module.mjs";
import { assertValidConfig, isSafeRelativePath } from "./validate.mjs";
import { renderAgents, renderAll } from "./render-agents.mjs";
import { assertLegacyV1Config, renderLegacyV1Agents } from "./legacy-v1-agents.mjs";

const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SKILL = "knights-of-the-round-table";
const MANIFEST_FILENAME = ".knights-install.json";
const TRANSACTION_FILENAME = ".knights-install.transaction.json";
const LEGACY_MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 2;
const TRANSACTION_VERSION = 1;
const MANIFEST_STATE_COMPLETE = "complete";
const MANIFEST_STATE_INSTALLING = "installing";
const SKILL_SWAP_JOURNAL_SCHEMA_VERSION = 1;
const SKILL_SWAP_JOURNAL_STATE_ALLOCATING = "allocating";
const SKILL_SWAP_JOURNAL_STATE_PREPARED = "prepared";
const INSTALLER_ID = "knights-install";
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIVE_OWNERSHIP_JOURNALS = new Set();

// Canonical harness order: every list this module produces (installedPaths,
// manifest.harnesses, CLI output) is sorted according to this order so
// results stay deterministic regardless of the order harnesses were passed
// in.
const ALL_HARNESSES = ["claude", "copilot", "codex", "gemini"];

// Physical skill install directories. Codex and Gemini intentionally share
// one physical directory: item 6 requires a single copy/manifest, not one
// per harness.
const SKILL_INSTALL_GROUPS = [
  {
    harnesses: ["claude"],
    relativeDir: (skill) => `.claude/skills/${skill}`,
  },
  {
    harnesses: ["copilot"],
    relativeDir: (skill) => `.copilot/skills/${skill}`,
  },
  {
    harnesses: ["codex", "gemini"],
    relativeDir: (skill) => `.agents/skills/${skill}`,
  },
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

// Expected filename extension per harness, mirroring render-agents.mjs's
// HARNESS_EXTENSIONS. Independently of reviewer config validation, every
// filename derived from that config must be
// re-checked here before it is ever joined into a source or destination
// directory.
const AGENT_HARNESS_EXTENSIONS = {
  claude: ".md",
  copilot: ".agent.md",
  codex: ".toml",
  gemini: ".md",
};

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function uniqueSiblingPath(targetPath, label) {
  return join(
    dirname(targetPath),
    `.${basename(targetPath)}.${label}-${process.pid}-${randomUUID()}`,
  );
}

function writeDurableNewFile(filePath, content, executeBits) {
  let fileDescriptor;
  try {
    fileDescriptor = openSync(filePath, "wx");
    writeFileSync(fileDescriptor, content);
    if (executeBits !== undefined) {
      // Keep umask-controlled read/write permissions, preserve only source
      // execute bits, and never propagate setuid, setgid, or sticky bits.
      fchmodSync(
        fileDescriptor,
        (fstatSync(fileDescriptor).mode & 0o666) | executeBits,
      );
    }
    fsyncSync(fileDescriptor);
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
  }
}

function writeAtomicFile(filePath, content) {
  const temporaryPath = uniqueSiblingPath(filePath, "knights-tmp");
  try {
    writeDurableNewFile(temporaryPath, content);
    renameSync(temporaryPath, filePath);
    syncDirectory(dirname(filePath));
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function writeExclusiveAtomicFile(filePath, content) {
  const temporaryPath = uniqueSiblingPath(filePath, "knights-tmp");
  try {
    writeDurableNewFile(temporaryPath, content);
    try {
      linkSync(temporaryPath, filePath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(
          `Refusing to install: another installation is in progress: ${filePath}`,
          { cause: error },
        );
      }
      throw error;
    }
    syncDirectory(dirname(filePath));
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function syncDirectory(directory) {
  let fileDescriptor;
  try {
    fileDescriptor = openSync(directory, "r");
    fsyncSync(fileDescriptor);
  } catch (error) {
    if (
      !["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(
        error.code,
      )
    ) {
      throw error;
    }
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
  }
}

function directoryChain(rootDirectory, leafDirectory) {
  const root = resolve(rootDirectory);
  const leaf = resolve(leafDirectory);
  const relativePath = relative(root, leaf);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Directory chain escapes its root: ${leaf}`);
  }

  const directories = [root];
  let current = root;
  if (relativePath !== "") {
    for (const segment of relativePath.split(sep)) {
      current = join(current, segment);
      directories.push(current);
    }
  }
  return directories;
}

function addDirectoryChain(directorySet, rootDirectory, leafDirectory) {
  for (const directory of directoryChain(rootDirectory, leafDirectory)) {
    directorySet.add(directory);
  }
}

function syncDirectoryChain(rootDirectory, leafDirectory) {
  for (const directory of directoryChain(
    rootDirectory,
    leafDirectory,
  ).reverse()) {
    syncDirectory(directory);
  }
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

function isProcessAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    return false;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") {
      return true;
    }
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function assertJournalIsNotActive(journalPath, ownerProcessId) {
  if (
    ACTIVE_OWNERSHIP_JOURNALS.has(journalPath) ||
    (ownerProcessId !== process.pid && isProcessAlive(ownerProcessId))
  ) {
    throw new Error(
      `Refusing to install: another installation is in progress: ${journalPath}`,
    );
  }
}

function directoryIdentity(stat) {
  return { device: stat.dev, inode: stat.ino };
}

function serializedDirectoryIdentity(identity) {
  return {
    device: String(identity.device),
    inode: String(identity.inode),
  };
}

function assertDirectoryIdentity(directory, expectedIdentity, description) {
  const stat = lstatIfExists(directory);
  if (
    stat === null ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== expectedIdentity.device ||
    stat.ino !== expectedIdentity.inode
  ) {
    throw new Error(
      `Refusing to install: ${description} changed after preflight: ${directory}`,
    );
  }
}

function assertSerializedDirectoryIdentity(
  directory,
  expectedIdentity,
  description,
) {
  const stat = lstatIfExists(directory);
  if (
    stat === null ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    String(stat.dev) !== expectedIdentity.device ||
    String(stat.ino) !== expectedIdentity.inode
  ) {
    throw new Error(
      `Refusing to install: ${description} changed during an interrupted swap: ${directory}`,
    );
  }
}

function assertPathStillMissing(path, description) {
  if (lstatIfExists(path) !== null) {
    throw new Error(
      `Refusing to install: ${description} changed after preflight: ${path}`,
    );
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

// Central safety gate for every reviewer agent filename, whether it comes
// from the source (checked-in generated agents) or the destination
// (installed home agent directories) side. Mirrors render-agents.mjs's own
// `generatedPath` invariant: the filename must be a single safe path
// component (no separators, no `..`), must carry the harness's expected
// extension, and the resulting path's dirname must be exactly the intended
// directory. Every call site that turns a config-derived name into a
// filesystem path must go through this function before the path is read,
// written, or deleted.
function resolveSafeAgentFilePath(directory, harness, filename, description) {
  if (
    !isSafeRelativePath(filename) ||
    filename.includes("/") ||
    !filename.endsWith(AGENT_HARNESS_EXTENSIONS[harness])
  ) {
    throw new Error(
      `Refusing to install: unsafe ${description} filename for ${harness}: ${filename}`,
    );
  }
  const filePath = resolve(directory, filename);
  if (dirname(filePath) !== directory) {
    throw new Error(
      `Refusing to install: unsafe ${description} filename for ${harness}: ${filename}`,
    );
  }
  return filePath;
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function normalizedManifestFiles(files) {
  return [...files]
    .map(({ path, sha256: hash, executeBits }) => ({
      path,
      sha256: hash,
      ...(executeBits === undefined ? {} : { executeBits }),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function buildManifest({
  skill,
  skillVersion,
  source,
  harnesses,
  files,
  state = MANIFEST_STATE_COMPLETE,
  previousManifestSha256,
}) {
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    transactionVersion: TRANSACTION_VERSION,
    state,
    installer: INSTALLER_ID,
    skill,
    skillVersion,
    source,
    harnesses: [...harnesses],
    files: normalizedManifestFiles(files),
  };
  if (state === MANIFEST_STATE_INSTALLING) {
    manifest.previousManifestSha256 = previousManifestSha256 ?? null;
    manifest.ownerProcessId = process.pid;
  }
  return manifest;
}

function isValidManifestFileList(files) {
  return (
    Array.isArray(files) &&
    files.every(
      (file) =>
        file !== null &&
        typeof file === "object" &&
        typeof file.path === "string" &&
        typeof file.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(file.sha256) &&
        (file.executeBits === undefined ||
          (Number.isInteger(file.executeBits) &&
            (file.executeBits & 0o111) === file.executeBits)),
    )
  );
}

function manifestState(manifest) {
  return manifest.schemaVersion === LEGACY_MANIFEST_SCHEMA_VERSION
    ? MANIFEST_STATE_COMPLETE
    : manifest.state;
}

function assertValidManifestShape(manifest, manifestPath) {
  const baseValid =
    manifest !== null &&
    typeof manifest === "object" &&
    !Array.isArray(manifest) &&
    manifest.installer === INSTALLER_ID &&
    typeof manifest.skill === "string" &&
    typeof manifest.skillVersion === "string" &&
    typeof manifest.source === "string" &&
    Array.isArray(manifest.harnesses) &&
    manifest.harnesses.every((harness) => typeof harness === "string") &&
    isValidManifestFileList(manifest.files);

  if (!baseValid) {
    throw new Error(`Invalid ownership manifest: ${manifestPath}`);
  }

  const validLegacyManifest =
    manifest.schemaVersion === LEGACY_MANIFEST_SCHEMA_VERSION &&
    manifest.transactionVersion === undefined &&
    manifest.state === undefined &&
    manifest.previousManifestSha256 === undefined &&
    manifest.ownerProcessId === undefined &&
    manifest.previousFiles === undefined;

  const validCurrentManifest =
    manifest.schemaVersion === MANIFEST_SCHEMA_VERSION &&
    manifest.transactionVersion === TRANSACTION_VERSION &&
    (manifest.state === MANIFEST_STATE_COMPLETE ||
      manifest.state === MANIFEST_STATE_INSTALLING) &&
    (manifest.state === MANIFEST_STATE_INSTALLING
      ? (manifest.previousManifestSha256 === null ||
          (typeof manifest.previousManifestSha256 === "string" &&
            /^[0-9a-f]{64}$/.test(manifest.previousManifestSha256))) &&
        Number.isSafeInteger(manifest.ownerProcessId) &&
        manifest.ownerProcessId > 0 &&
        manifest.previousFiles === undefined
      : manifest.previousManifestSha256 === undefined &&
        manifest.ownerProcessId === undefined &&
        manifest.previousFiles === undefined);

  if (!validLegacyManifest && !validCurrentManifest) {
    throw new Error(`Invalid ownership manifest: ${manifestPath}`);
  }
}

// Proves a manifest actually belongs to the target it was found in, rather
// than merely being *some* shape-valid manifest. `assertValidManifestShape`
// only checks field types, so a manifest copied or forged from another skill
// or another physical harness group is otherwise indistinguishable from a
// genuine prior install once shape validation passes -- letting it be treated
// as proof of ownership, including merging its harnesses or authorizing a
// forced update. This check runs unconditionally, before the `--force` gate,
// so a mismatched manifest is refused exactly like any other unowned
// collision, even with force.
//
// - For a skill-install manifest (`exactHarness` omitted), `harnesses` must
//   be a nonempty, duplicate-free subset of `allowedHarnesses` (that
//   physical group's allowed harnesses: Claude only, Copilot only, or the
//   shared Codex/Gemini group). A shared group may legitimately be owned by
//   either or both harnesses; this only rejects harnesses outside the
//   group and duplicate/unknown values, so a force install of the sibling
//   harness still merges correctly.
// - For an agent-directory manifest (`exactHarness` given), `harnesses`
//   must be exactly that one harness, nothing more or less.
// - Either way, `manifest.skill` must equal the skill being installed, and
//   every file path in `manifest.files` must be unique: a duplicate path
//   would otherwise silently collapse to a single (attacker-chosen) hash
//   wherever callers index owned files by path.
function assertManifestOwnership(
  manifest,
  manifestPath,
  { skill, allowedHarnesses, exactHarness },
) {
  if (manifest.skill !== skill) {
    throw new Error(
      `Refusing to install: ownership manifest belongs to a different skill: ${manifestPath}`,
    );
  }

  const harnesses = manifest.harnesses;
  if (harnesses.length === 0 || new Set(harnesses).size !== harnesses.length) {
    throw new Error(
      `Refusing to install: ownership manifest has invalid harnesses: ${manifestPath}`,
    );
  }

  if (exactHarness !== undefined) {
    if (harnesses.length !== 1 || harnesses[0] !== exactHarness) {
      throw new Error(
        `Refusing to install: ownership manifest harness does not match this agent directory: ${manifestPath}`,
      );
    }
  } else if (!harnesses.every((harness) => allowedHarnesses.includes(harness))) {
    throw new Error(
      `Refusing to install: ownership manifest references a harness outside this group: ${manifestPath}`,
    );
  }

  const filePaths = manifest.files.map((file) => file.path);
  if (new Set(filePaths).size !== filePaths.length) {
    throw new Error(
      `Refusing to install: ownership manifest has duplicate file paths: ${manifestPath}`,
    );
  }

}

function readManifestFileIfExists(directory, filename) {
  const manifestPath = join(directory, filename);
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
  let content;
  try {
    content = readFileSync(manifestPath);
    manifest = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Refusing to install: unable to parse ownership manifest: ${manifestPath}`,
    );
  }
  assertValidManifestShape(manifest, manifestPath);
  return {
    exists: true,
    manifest,
    manifestPath,
    contentHash: sha256(content),
  };
}

function readManifestIfExists(directory) {
  return readManifestFileIfExists(directory, MANIFEST_FILENAME);
}

function readTransactionIfExists(directory) {
  return readManifestFileIfExists(directory, TRANSACTION_FILENAME);
}

function assertManifestHash(directory, filename, expectedHash) {
  const result = readManifestFileIfExists(directory, filename);
  const actualHash = result.exists ? result.contentHash : null;
  if (actualHash !== expectedHash) {
    throw new Error(
      `Refusing to install: ownership metadata changed after preflight: ${join(directory, filename)}`,
    );
  }
}

function assertAgentFileState(targetDir, harness, filename, expectedHash) {
  const filePath = resolveSafeAgentFilePath(
    targetDir,
    harness,
    filename,
    "agent destination",
  );
  const stat = lstatIfExists(filePath);
  if (expectedHash === null) {
    if (stat !== null) {
      throw new Error(
        `Refusing to install: agent destination changed after preflight: ${filePath}`,
      );
    }
    return;
  }
  if (stat === null || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `Refusing to install: agent destination changed after preflight: ${filePath}`,
    );
  }
  if (sha256(readFileSync(filePath)) !== expectedHash) {
    throw new Error(
      `Refusing to install: agent file drifted after preflight: ${filePath}`,
    );
  }
}

function assertAgentFileStates(targetDir, harness, expectedFileStates) {
  for (const [filename, expectedHash] of expectedFileStates) {
    assertAgentFileState(targetDir, harness, filename, expectedHash);
  }
}

function expectedDestinationDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    const segments = file.path.split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      directories.add(current);
    }
  }
  return directories;
}

// Walks an *existing destination* directory tree, rejecting symlinks,
// non-regular entries, and directories that are not required ancestors of a
// manifest-owned file. The top-level manifest file is metadata, not tracked
// payload, and is excluded from the result.
function walkExistingDestinationFiles(rootDir, expectedFiles) {
  const files = [];
  const expectedDirectories =
    expectedFiles === undefined
      ? null
      : expectedDestinationDirectories(expectedFiles);

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
        const posixRelativePath = toPosixPath(relativePath);
        if (
          expectedDirectories !== null &&
          !expectedDirectories.has(posixRelativePath)
        ) {
          throw new Error(
            `Refusing to install: existing destination contains an untracked directory: ${entryPath}`,
          );
        }
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
    if (
      actualHash !== file.sha256 ||
      (file.executeBits !== undefined &&
        (stat.mode & 0o111) !== file.executeBits)
    ) {
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

// Source-side counterpart to assertSafeAncestors above, used to guard
// checked-in generated-agent source directories. `validateGeneratedAgents`
// used to lstat-check only the final
// generated agent *files*; it never confirmed that the directory
// containing them -- e.g. `<projectRoot>/generated/claude/agents` -- was
// itself a real, non-symlink directory contained within the project root.
// A symlinked source directory (`generated/claude/agents -> /outside`)
// would let every per-file lstat/hash check downstream pass, because the
// files at the far end of the symlink are themselves real, regular files
// with valid content -- while silently reading (and later installing) them
// from outside the project root. This checks every path component from the
// (already-resolved) project root down through the directory itself --
// unlike assertSafeAncestors, inclusive of the final component, since here
// the directory being validated is the source of truth, not a destination
// whose own symlink-ness the caller checks separately -- and confirms the
// directory's own resolved realpath does not escape the project root
// either.
function assertSafeSourceDirectory(realProjectRoot, directory, description) {
  const relativePath = relative(realProjectRoot, directory);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${description} escapes the project root: ${directory}`);
  }

  const segments = relativePath.split(sep);
  let current = realProjectRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = lstatIfExists(current);
    if (stat === null) {
      throw new Error(`${description} does not exist: ${directory}`);
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

  const realDirectory = realpathSync(directory);
  if (!isContainedPath(realProjectRoot, realDirectory)) {
    throw new Error(`${description} escapes the project root: ${directory}`);
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

// Boundary check for `home` before it ever reaches `resolve`. `resolve("")`
// (or an all-whitespace string) silently resolves to `process.cwd()`,
// retargeting the entire install away from the caller's intended directory
// instead of failing. Reject that here, fail closed, and never echo the
// (potentially empty/whitespace) value itself in the error.
function assertSafeHome(home) {
  if (typeof home !== "string" || home.trim().length === 0) {
    throw new Error("Home directory must be a non-empty path");
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
// hashes and execute bits (item 11). The top-level manifest filename is
// reserved for installer-owned metadata (written by installSkillGroup) and must not
// exist as payload in the source tree, or a first install would silently
// overwrite it and a later force update would be permanently unable to
// reconcile it against `walkExistingDestinationFiles`, which excludes that
// same top-level filename as metadata, not tracked payload.
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

      if (!isSafeRelativePath(relativePath)) {
        throw new Error(
          `Skill source contains an unsafe path: ${relativePath}`,
        );
      }
      if (relativeDir === "" && entry.name === MANIFEST_FILENAME) {
        throw new Error(
          `Skill source contains a reserved filename: ${relativePath}`,
        );
      }
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
        executeBits: lstatSync(entryPath).mode & 0o111,
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
  const renderedAgents = isKnightsSkill
    ? renderAll({ projectRoot: realProjectRoot })
    : null;
  const generatedAgents = isKnightsSkill
    ? validateGeneratedAgents({
        projectRoot: realProjectRoot,
        harnesses,
        rendered: renderedAgents,
      })
    : {};

  return {
    resolvedProjectRoot,
    realProjectRoot,
    skillDir,
    skillVersion,
    files,
    isKnightsSkill,
    generatedAgents,
    renderedAgents,
  };
}

// Confirms that every checked-in generated agent for each selected harness
// is a regular, non-symlink file whose contents match the previously
// validated render snapshot (item 11).
// `projectRoot` here must already be a fully resolved realpath (see
// validateSource), since assertSafeSourceDirectory below measures
// containment against it directly.
function validateGeneratedAgents({ projectRoot, harnesses, rendered }) {
  const result = {};

  for (const harness of harnesses) {
    const directory = resolve(
      projectRoot,
      GENERATED_AGENT_SOURCE_DIRS[harness],
    );
    assertSafeSourceDirectory(
      projectRoot,
      directory,
      `Generated reviewer agent source directory for ${harness}`,
    );
    const files = [];
    for (const [filename, expectedContent] of Object.entries(
      rendered[harness],
    )) {
      const filePath = resolveSafeAgentFilePath(
        directory,
        harness,
        filename,
        "generated reviewer agent source",
      );
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

function agentManifestFiles(files) {
  return normalizedManifestFiles(
    files.map((file) => ({
      path: file.filename,
      sha256: sha256(file.content),
    })),
  );
}

function readVerifiedInstalledSkillFile(
  directory,
  manifestFiles,
  relativePath,
) {
  const expectedFile = manifestFiles.find(
    (file) => file.path === relativePath,
  );
  if (expectedFile === undefined || !isSafeRelativePath(relativePath)) {
    throw new Error(
      `Refusing to install: installed skill is missing required source: ${relativePath}`,
    );
  }
  const filePath = resolve(directory, relativePath);
  if (!isContainedPath(directory, filePath)) {
    throw new Error(
      `Refusing to install: installed skill source escapes its directory: ${relativePath}`,
    );
  }
  const stat = lstatIfExists(filePath);
  if (stat === null || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `Refusing to install: installed skill source must be a regular file: ${filePath}`,
    );
  }
  const content = readFileSync(filePath);
  if (sha256(content) !== expectedFile.sha256) {
    throw new Error(
      `Refusing to install: installed skill source changed during preflight: ${filePath}`,
    );
  }
  return content;
}

function deriveInstalledSkillAgentPayloads({
  directory,
  manifest,
  harnesses,
}) {
  if (manifest.skill !== DEFAULT_SKILL) {
    return {};
  }

  const configPath = "config/reviewers.yaml";
  let config;
  try {
    config = YAML.parse(
      readVerifiedInstalledSkillFile(
        directory,
        manifest.files,
        configPath,
      ).toString("utf8"),
    );
    if (config?.version === 1) assertLegacyV1Config(config);
    else assertValidConfig(config);
  } catch (error) {
    throw new Error(
      `Refusing to install: installed skill reviewer configuration is invalid: ${join(directory, configPath)}`,
      { cause: error },
    );
  }

  const readPrompt = path => readVerifiedInstalledSkillFile(directory, manifest.files, path).toString("utf8");
  const rendered = config.version === 1
    ? renderLegacyV1Agents(config, readPrompt)
    : renderAgents(config, { [config.prompt]: readPrompt(config.prompt) });
  return Object.fromEntries(
    harnesses.map((harness) => {
      const files = Object.entries(rendered[harness]).map(
        ([filename, content]) => {
          resolveSafeAgentFilePath(
            directory,
            harness,
            filename,
            "installed skill generated agent",
          );
          return {
            filename,
            content: Buffer.from(content, "utf8"),
          };
        },
      );
      return [harness, files];
    }),
  );
}

function deriveInstalledSkillAgentFiles(options) {
  const payloads = deriveInstalledSkillAgentPayloads(options);
  return Object.fromEntries(
    Object.entries(payloads).map(([harness, files]) => [
      harness,
      agentManifestFiles(files),
    ]),
  );
}

function sameManifestFiles(left, right) {
  return (
    JSON.stringify(normalizedManifestFiles(left)) ===
    JSON.stringify(normalizedManifestFiles(right))
  );
}

function skillSwapJournalPath(targetDir) {
  return join(
    dirname(targetDir),
    `.${basename(targetDir)}.knights-swap.json`,
  );
}

function isValidSkillStageName(stageName, targetName, ownerProcessId) {
  const prefix = `.${targetName}.knights-stage-${ownerProcessId}-`;
  return (
    stageName.startsWith(prefix) &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(
      stageName.slice(prefix.length),
    )
  );
}

function readSkillSwapJournalIfExists(
  targetDir,
  journalPath = skillSwapJournalPath(targetDir),
) {
  const stat = lstatIfExists(journalPath);
  if (stat === null) {
    return { exists: false, journalPath };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `Refusing to install: skill swap journal must be a regular file: ${journalPath}`,
    );
  }

  let journal;
  let content;
  try {
    content = readFileSync(journalPath);
    journal = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(
      `Refusing to install: unable to parse skill swap journal: ${journalPath}`,
    );
  }
  const targetName = basename(targetDir);
  const validIdentity = (identity) =>
    identity !== null &&
    typeof identity === "object" &&
    !Array.isArray(identity) &&
    typeof identity.device === "string" &&
    /^\d+$/.test(identity.device) &&
    typeof identity.inode === "string" &&
    /^\d+$/.test(identity.inode);
  const validFiles = (files) =>
    isValidManifestFileList(files) &&
    new Set(files.map((file) => file.path)).size === files.length &&
    files.every(
      (file) =>
        file.path !== MANIFEST_FILENAME &&
        isSafeRelativePath(file.path),
    );
  const journalIsObject =
    journal !== null &&
    typeof journal === "object" &&
    !Array.isArray(journal);
  const validPrior =
    journalIsObject &&
    ((journal.priorIdentity === null &&
      Array.isArray(journal.priorFiles) &&
      journal.priorFiles.length === 0 &&
      journal.priorManifestSha256 === null) ||
    (validIdentity(journal.priorIdentity) &&
      validFiles(journal.priorFiles) &&
      typeof journal.priorManifestSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(journal.priorManifestSha256)));
  const validStageState =
    journalIsObject &&
    ((journal.state === SKILL_SWAP_JOURNAL_STATE_ALLOCATING &&
      journal.stageIdentity === null) ||
      (journal.state === SKILL_SWAP_JOURNAL_STATE_PREPARED &&
        validIdentity(journal.stageIdentity)));
  const valid =
    journalIsObject &&
    journal.schemaVersion === SKILL_SWAP_JOURNAL_SCHEMA_VERSION &&
    journal.installer === INSTALLER_ID &&
    validStageState &&
    Number.isSafeInteger(journal.ownerProcessId) &&
    journal.ownerProcessId > 0 &&
    journal.targetName === targetName &&
    typeof journal.stageName === "string" &&
    isValidSkillStageName(
      journal.stageName,
      targetName,
      journal.ownerProcessId,
    ) &&
    validFiles(journal.stagedFiles) &&
    validPrior &&
    typeof journal.stagedManifestSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(journal.stagedManifestSha256);
  if (!valid) {
    throw new Error(`Invalid skill swap journal: ${journalPath}`);
  }
  const parentDir = dirname(targetDir);
  const stageDir = resolve(parentDir, journal.stageName);
  if (dirname(stageDir) !== parentDir) {
    throw new Error(`Invalid skill swap journal: ${journalPath}`);
  }

  return {
    exists: true,
    journal,
    journalPath,
    stageDir,
    contentHash: sha256(content),
    identity: directoryIdentity(stat),
  };
}

function replaceSkillSwapJournal({
  targetDir,
  journalPath,
  expectedHash,
  expectedIdentity,
  content,
}) {
  const currentJournal = readSkillSwapJournalIfExists(
    targetDir,
    journalPath,
  );
  if (
    !currentJournal.exists ||
    currentJournal.contentHash !== expectedHash ||
    currentJournal.identity.device !== expectedIdentity.device ||
    currentJournal.identity.inode !== expectedIdentity.inode
  ) {
    throw new Error(
      `Refusing to install: skill swap journal changed before stage population: ${journalPath}`,
    );
  }

  writeAtomicFile(journalPath, content);
  const contentHash = sha256(Buffer.from(content, "utf8"));
  const updatedJournal = readSkillSwapJournalIfExists(
    targetDir,
    journalPath,
  );
  if (
    !updatedJournal.exists ||
    updatedJournal.contentHash !== contentHash
  ) {
    throw new Error(
      `Refusing to install: skill swap journal changed during stage preparation: ${journalPath}`,
    );
  }
  return {
    contentHash,
    identity: updatedJournal.identity,
  };
}

function skillSwapRecoveryPrefix(targetDir) {
  return `.${basename(targetDir)}.knights-swap.recovering-`;
}

function recoveryOwnerProcessId(filename, prefix) {
  if (!filename.startsWith(prefix) || !filename.endsWith(".json")) {
    return null;
  }
  const suffix = filename.slice(prefix.length, -".json".length);
  const separatorIndex = suffix.indexOf("-");
  const processIdText =
    separatorIndex === -1 ? suffix : suffix.slice(0, separatorIndex);
  const processId = Number(processIdText);
  return Number.isSafeInteger(processId) && processId > 0
    ? processId
    : null;
}

function claimSkillSwapJournalForRecovery(targetDir) {
  const parentDir = dirname(targetDir);
  const fixedJournalPath = skillSwapJournalPath(targetDir);
  const parentStat = lstatIfExists(parentDir);
  if (parentStat === null) {
    return { exists: false, journalPath: fixedJournalPath };
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(
      `Refusing to install: skill swap parent is unsafe: ${parentDir}`,
    );
  }
  const recoveryPrefix = skillSwapRecoveryPrefix(targetDir);
  const recoveryNames = readdirSync(parentDir)
    .filter((name) => name.startsWith(recoveryPrefix))
    .sort();

  if (lstatIfExists(fixedJournalPath) !== null && recoveryNames.length > 0) {
    throw new Error(
      `Refusing to install: multiple skill swap journals exist for ${targetDir}`,
    );
  }
  if (recoveryNames.length > 1) {
    throw new Error(
      `Refusing to install: multiple skill swap recovery claims exist for ${targetDir}`,
    );
  }

  let sourceJournalPath = fixedJournalPath;
  let recoveryOwner = null;
  if (recoveryNames.length === 1) {
    sourceJournalPath = join(parentDir, recoveryNames[0]);
    recoveryOwner = recoveryOwnerProcessId(
      recoveryNames[0],
      recoveryPrefix,
    );
    if (recoveryOwner === null) {
      throw new Error(
        `Invalid skill swap recovery claim: ${sourceJournalPath}`,
      );
    }
  }

  const journalResult = readSkillSwapJournalIfExists(
    targetDir,
    sourceJournalPath,
  );
  if (!journalResult.exists) {
    return journalResult;
  }
  if (recoveryOwner !== null) {
    assertJournalIsNotActive(sourceJournalPath, recoveryOwner);
  } else {
    assertJournalIsNotActive(
      sourceJournalPath,
      journalResult.journal.ownerProcessId,
    );
  }

  const claimedPath = join(
    parentDir,
    `${recoveryPrefix}${process.pid}-${randomUUID()}.json`,
  );
  renameSync(sourceJournalPath, claimedPath);
  syncDirectory(parentDir);
  const claimedResult = readSkillSwapJournalIfExists(
    targetDir,
    claimedPath,
  );
  if (
    !claimedResult.exists ||
    claimedResult.contentHash !== journalResult.contentHash ||
    claimedResult.identity.device !== journalResult.identity.device ||
    claimedResult.identity.inode !== journalResult.identity.inode
  ) {
    throw new Error(
      `Refusing to install: skill swap recovery claim changed while acquiring it: ${claimedPath}`,
    );
  }
  ACTIVE_OWNERSHIP_JOURNALS.add(claimedPath);
  return claimedResult;
}

function findSkillSwapBackupDirectory(targetDir, priorIdentity) {
  const parentDir = dirname(targetDir);
  const prefix = `.${basename(targetDir)}.knights-backup-`;
  const matches = [];
  for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) {
      continue;
    }
    const entryPath = join(parentDir, entry.name);
    const stat = lstatIfExists(entryPath);
    if (
      stat !== null &&
      !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      String(stat.dev) === priorIdentity.device &&
      String(stat.ino) === priorIdentity.inode
    ) {
      matches.push(entryPath);
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `Refusing to install: multiple skill swap backups match ${targetDir}`,
    );
  }
  return matches[0] ?? null;
}

function assertCompleteSkillDirectory({
  directory,
  expectedManifestHash,
  skill,
  allowedHarnesses,
  description,
}) {
  const stat = lstatIfExists(directory);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Refusing to install: ${description} is not a safe directory: ${directory}`,
    );
  }
  const manifestResult = readManifestIfExists(directory);
  if (
    !manifestResult.exists ||
    manifestResult.contentHash !== expectedManifestHash
  ) {
    throw new Error(
      `Refusing to install: ${description} manifest does not match the swap journal: ${directory}`,
    );
  }
  assertManifestOwnership(manifestResult.manifest, manifestResult.manifestPath, {
    skill,
    allowedHarnesses,
  });
  if (manifestState(manifestResult.manifest) !== MANIFEST_STATE_COMPLETE) {
    throw new Error(
      `Refusing to install: ${description} manifest is not complete: ${directory}`,
    );
  }
  const actualFiles = walkExistingDestinationFiles(
    directory,
    manifestResult.manifest.files,
  );
  const expectedFiles = manifestResult.manifest.files
    .map((file) => file.path)
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `Refusing to install: ${description} files do not match its manifest: ${directory}`,
    );
  }
  assertManifestFilesUncorrupted(directory, manifestResult.manifest.files);
}

function assertSkillPayloadSnapshot({
  directory,
  expectedIdentity,
  expectedFiles,
  description,
}) {
  assertDirectoryIdentity(directory, expectedIdentity, description);
  assertPathStillMissing(
    join(directory, MANIFEST_FILENAME),
    `${description} manifest`,
  );
  const actualFiles = walkExistingDestinationFiles(directory, expectedFiles);
  const expectedPaths = expectedFiles.map((file) => file.path).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Refusing to install: ${description} files changed before manifest creation: ${directory}`,
    );
  }
  assertManifestFilesUncorrupted(directory, expectedFiles);
}

function validateInterruptedSkillStage({
  directory,
  expectedIdentity,
  expectedFiles,
  description,
}) {
  assertSerializedDirectoryIdentity(
    directory,
    expectedIdentity,
    description,
  );

  const manifestPath = join(directory, MANIFEST_FILENAME);
  const manifestStat = lstatIfExists(manifestPath);
  if (
    manifestStat !== null &&
    (manifestStat.isSymbolicLink() || !manifestStat.isFile())
  ) {
    throw new Error(
      `Refusing to install: ${description} manifest is not a regular file: ${manifestPath}`,
    );
  }

  const expectedPaths = new Set(expectedFiles.map((file) => file.path));
  for (const relativePath of walkExistingDestinationFiles(
    directory,
    expectedFiles,
  )) {
    const filePath = resolve(directory, relativePath);
    if (
      !expectedPaths.has(relativePath) ||
      !isSafeRelativePath(relativePath) ||
      !isContainedPath(directory, filePath)
    ) {
      throw new Error(
        `Refusing to install: ${description} contains an untracked file: ${directory}`,
      );
    }
  }
  return {
    exists: manifestStat !== null,
    manifestPath,
  };
}

function removeInterruptedSkillStage({
  directory,
  expectedIdentity,
  expectedFiles,
  description,
}) {
  const manifestResult = validateInterruptedSkillStage({
    directory,
    expectedIdentity,
    expectedFiles,
    description,
  });

  for (const file of expectedFiles) {
    const filePath = resolve(directory, file.path);
    assertSerializedDirectoryIdentity(
      directory,
      expectedIdentity,
      description,
    );
    assertSafeAncestors(directory, filePath, description);
    const stat = lstatIfExists(filePath);
    if (stat === null) {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `Refusing to install: ${description} file changed during cleanup: ${filePath}`,
      );
    }
    rmSync(filePath);
    syncDirectory(dirname(filePath));
  }

  const ownedDirectories = [...expectedDestinationDirectories(expectedFiles)]
    .sort((left, right) => {
      const depthDifference =
        right.split("/").length - left.split("/").length;
      return depthDifference === 0
        ? right.localeCompare(left)
        : depthDifference;
    });
  for (const relativePath of ownedDirectories) {
    const directoryPath = resolve(directory, relativePath);
    assertSerializedDirectoryIdentity(
      directory,
      expectedIdentity,
      description,
    );
    const stat = lstatIfExists(directoryPath);
    if (stat === null) {
      continue;
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      readdirSync(directoryPath).length > 0
    ) {
      throw new Error(
        `Refusing to install: ${description} directory changed during cleanup: ${directoryPath}`,
      );
    }
    rmdirSync(directoryPath);
    syncDirectory(dirname(directoryPath));
  }

  if (manifestResult.exists) {
    validateInterruptedSkillStage({
      directory,
      expectedIdentity,
      expectedFiles,
      description,
    });
    rmSync(manifestResult.manifestPath);
    syncDirectory(directory);
  }

  assertSerializedDirectoryIdentity(
    directory,
    expectedIdentity,
    description,
  );
  if (readdirSync(directory).length > 0) {
    throw new Error(
      `Refusing to install: ${description} changed after cleanup: ${directory}`,
    );
  }
  rmdirSync(directory);
  syncDirectory(dirname(directory));
}

function validatePartiallyRemovedSkillDirectory({
  directory,
  expectedIdentity,
  expectedManifestHash,
  expectedFiles,
  skill,
  allowedHarnesses,
  description,
}) {
  assertSerializedDirectoryIdentity(
    directory,
    expectedIdentity,
    description,
  );

  const manifestResult = readManifestIfExists(directory);
  if (!manifestResult.exists) {
    if (readdirSync(directory).length > 0) {
      throw new Error(
        `Refusing to install: ${description} ownership manifest is missing while payload remains: ${directory}`,
      );
    }
    return manifestResult;
  }
  if (manifestResult.contentHash !== expectedManifestHash) {
    throw new Error(
      `Refusing to install: ${description} manifest changed during cleanup: ${manifestResult.manifestPath}`,
    );
  }
  assertManifestOwnership(
    manifestResult.manifest,
    manifestResult.manifestPath,
    { skill, allowedHarnesses },
  );
  if (
    manifestState(manifestResult.manifest) !== MANIFEST_STATE_COMPLETE ||
    !sameManifestFiles(manifestResult.manifest.files, expectedFiles)
  ) {
    throw new Error(
      `Refusing to install: ${description} manifest does not match the swap journal: ${manifestResult.manifestPath}`,
    );
  }

  const expectedFilesByPath = new Map(
    manifestResult.manifest.files.map((file) => [file.path, file]),
  );
  for (const relativePath of walkExistingDestinationFiles(
    directory,
    manifestResult.manifest.files,
  )) {
    const expectedFile = expectedFilesByPath.get(relativePath);
    const filePath = resolve(directory, relativePath);
    if (
      expectedFile === undefined ||
      !isSafeRelativePath(relativePath) ||
      !isContainedPath(directory, filePath) ||
      sha256(readFileSync(filePath)) !== expectedFile.sha256 ||
      (expectedFile.executeBits !== undefined &&
        (lstatSync(filePath).mode & 0o111) !== expectedFile.executeBits)
    ) {
      throw new Error(
        `Refusing to install: ${description} contains changed or untracked files: ${directory}`,
      );
    }
  }
  return manifestResult;
}

function removeOwnedSkillDirectoryIncrementally({
  directory,
  expectedIdentity,
  expectedManifestHash,
  expectedFiles,
  skill,
  allowedHarnesses,
  description,
  beforeManifestRemoval = () => {},
}) {
  const manifestResult = validatePartiallyRemovedSkillDirectory({
    directory,
    expectedIdentity,
    expectedManifestHash,
    expectedFiles,
    skill,
    allowedHarnesses,
    description,
  });

  if (!manifestResult.exists) {
    rmdirSync(directory);
    syncDirectory(dirname(directory));
    return;
  }

  for (const file of manifestResult.manifest.files) {
    const filePath = resolve(directory, file.path);
    assertSerializedDirectoryIdentity(
      directory,
      expectedIdentity,
      description,
    );
    assertSafeAncestors(directory, filePath, description);
    const stat = lstatIfExists(filePath);
    if (stat === null) {
      continue;
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      sha256(readFileSync(filePath)) !== file.sha256 ||
      (file.executeBits !== undefined &&
        (stat.mode & 0o111) !== file.executeBits)
    ) {
      throw new Error(
        `Refusing to install: ${description} file changed during cleanup: ${filePath}`,
      );
    }
    rmSync(filePath);
    syncDirectory(dirname(filePath));
  }

  const ownedDirectories = [...expectedDestinationDirectories(
    manifestResult.manifest.files,
  )].sort((left, right) => {
    const depthDifference =
      right.split("/").length - left.split("/").length;
    return depthDifference === 0
      ? right.localeCompare(left)
      : depthDifference;
  });
  for (const relativePath of ownedDirectories) {
    const directoryPath = resolve(directory, relativePath);
    assertSerializedDirectoryIdentity(
      directory,
      expectedIdentity,
      description,
    );
    const stat = lstatIfExists(directoryPath);
    if (stat === null) {
      continue;
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      readdirSync(directoryPath).length > 0
    ) {
      throw new Error(
        `Refusing to install: ${description} directory changed during cleanup: ${directoryPath}`,
      );
    }
    rmdirSync(directoryPath);
    syncDirectory(dirname(directoryPath));
  }

  validatePartiallyRemovedSkillDirectory({
    directory,
    expectedIdentity,
    expectedManifestHash,
    expectedFiles,
    skill,
    allowedHarnesses,
    description,
  });
  beforeManifestRemoval();
  validatePartiallyRemovedSkillDirectory({
    directory,
    expectedIdentity,
    expectedManifestHash,
    expectedFiles,
    skill,
    allowedHarnesses,
    description,
  });
  rmSync(manifestResult.manifestPath);
  syncDirectory(directory);
  assertSerializedDirectoryIdentity(
    directory,
    expectedIdentity,
    description,
  );
  if (readdirSync(directory).length > 0) {
    throw new Error(
      `Refusing to install: ${description} changed after manifest cleanup: ${directory}`,
    );
  }
  rmdirSync(directory);
  syncDirectory(dirname(directory));
}

function recoverInterruptedSkillSwap({
  resolvedHome,
  targetDir,
  skill,
  allowedHarnesses,
  onInstallEvent,
}) {
  assertSafeAncestors(resolvedHome, targetDir, "Skill destination");
  const parentDir = dirname(targetDir);
  const initialParentStat = lstatIfExists(parentDir);
  if (initialParentStat === null) {
    return;
  }
  if (
    initialParentStat.isSymbolicLink() ||
    !initialParentStat.isDirectory()
  ) {
    throw new Error(
      `Refusing to install: skill swap parent is unsafe: ${parentDir}`,
    );
  }
  const parentIdentity = directoryIdentity(initialParentStat);
  const journalResult = claimSkillSwapJournalForRecovery(targetDir);
  if (!journalResult.exists) {
    return;
  }

  const {
    journal,
    journalPath,
    stageDir,
    contentHash: journalHash,
    identity: journalIdentity,
  } = journalResult;
  const assertRecoveryContext = () => {
    assertSafeAncestors(resolvedHome, targetDir, "Skill destination");
    assertDirectoryIdentity(
      parentDir,
      parentIdentity,
      "skill swap parent",
    );
    const currentJournal = readSkillSwapJournalIfExists(
      targetDir,
      journalPath,
    );
    if (
      !currentJournal.exists ||
      currentJournal.contentHash !== journalHash ||
      currentJournal.identity.device !== journalIdentity.device ||
      currentJournal.identity.inode !== journalIdentity.inode
    ) {
      throw new Error(
        `Refusing to install: skill swap recovery journal changed: ${journalPath}`,
      );
    }
  };

  try {
    onInstallEvent({ phase: "after-skill-recovery-claim", targetDir });
    assertRecoveryContext();

    const targetStat = lstatIfExists(targetDir);
    const stageStat = lstatIfExists(stageDir);
    const hadPriorInstall = journal.priorIdentity !== null;
    const backupDir = hadPriorInstall
      ? findSkillSwapBackupDirectory(targetDir, journal.priorIdentity)
      : null;
    const backupStat =
      backupDir === null ? null : lstatIfExists(backupDir);

    if (journal.state === SKILL_SWAP_JOURNAL_STATE_ALLOCATING) {
      const assertPriorTargetState = () => {
        const currentTargetStat = lstatIfExists(targetDir);
        if (!hadPriorInstall) {
          if (currentTargetStat !== null) {
            throw new Error(
              `Refusing to install: skill destination changed during interrupted stage creation: ${targetDir}`,
            );
          }
          return;
        }
        assertSerializedDirectoryIdentity(
          targetDir,
          journal.priorIdentity,
          "prior skill",
        );
        assertCompleteSkillDirectory({
          directory: targetDir,
          expectedManifestHash: journal.priorManifestSha256,
          skill,
          allowedHarnesses,
          description: "prior skill",
        });
      };

      if (backupStat !== null) {
        throw new Error(
          `Refusing to install: skill backup exists during interrupted stage creation: ${backupDir}`,
        );
      }
      assertPriorTargetState();
      if (stageStat !== null) {
        if (
          stageStat.isSymbolicLink() ||
          !stageStat.isDirectory() ||
          readdirSync(stageDir).length > 0
        ) {
          throw new Error(
            `Refusing to install: unowned content exists at interrupted skill stage: ${stageDir}`,
          );
        }
        assertRecoveryContext();
        assertPriorTargetState();
        rmdirSync(stageDir);
        syncDirectory(parentDir);
      }
      assertRecoveryContext();
      assertPriorTargetState();
      rmSync(journalPath, { force: true });
      syncDirectory(parentDir);
      return;
    }

    if (!hadPriorInstall) {
      if (targetStat === null) {
        if (stageStat !== null) {
          validateInterruptedSkillStage({
            directory: stageDir,
            expectedIdentity: journal.stageIdentity,
            expectedFiles: journal.stagedFiles,
            description: "skill install stage",
          });
          assertRecoveryContext();
          assertPathStillMissing(targetDir, "skill destination");
          removeInterruptedSkillStage({
            directory: stageDir,
            expectedIdentity: journal.stageIdentity,
            expectedFiles: journal.stagedFiles,
            description: "skill install stage",
          });
        }
        assertRecoveryContext();
        assertPathStillMissing(targetDir, "skill destination");
        rmSync(journalPath, { force: true });
        syncDirectory(parentDir);
        return;
      }

      if (
        !targetStat.isSymbolicLink() &&
        targetStat.isDirectory() &&
        String(targetStat.dev) === journal.stageIdentity.device &&
        String(targetStat.ino) === journal.stageIdentity.inode
      ) {
        if (stageStat !== null) {
          throw new Error(
            `Refusing to install: interrupted skill install has duplicate stage paths: ${journalPath}`,
          );
        }
        assertCompleteSkillDirectory({
          directory: targetDir,
          expectedManifestHash: journal.stagedManifestSha256,
          skill,
          allowedHarnesses,
          description: "published skill",
        });
        assertRecoveryContext();
        rmSync(journalPath, { force: true });
        syncDirectory(parentDir);
        return;
      }

      throw new Error(
        `Refusing to install: unable to recover interrupted skill install: ${journalPath}`,
      );
    }

    if (targetStat === null && backupStat !== null) {
      assertCompleteSkillDirectory({
        directory: backupDir,
        expectedManifestHash: journal.priorManifestSha256,
        skill,
        allowedHarnesses,
        description: "skill swap backup",
      });
      if (stageStat !== null) {
        validateInterruptedSkillStage({
          directory: stageDir,
          expectedIdentity: journal.stageIdentity,
          expectedFiles: journal.stagedFiles,
          description: "skill swap stage",
        });
      }
      assertRecoveryContext();
      renameSync(backupDir, targetDir);
      syncDirectory(parentDir);
      assertCompleteSkillDirectory({
        directory: targetDir,
        expectedManifestHash: journal.priorManifestSha256,
        skill,
        allowedHarnesses,
        description: "restored skill",
      });
      if (stageStat !== null) {
        removeInterruptedSkillStage({
          directory: stageDir,
          expectedIdentity: journal.stageIdentity,
          expectedFiles: journal.stagedFiles,
          description: "skill swap stage",
        });
      }
      assertRecoveryContext();
      rmSync(journalPath, { force: true });
      syncDirectory(parentDir);
      return;
    }

    if (
      targetStat !== null &&
      !targetStat.isSymbolicLink() &&
      targetStat.isDirectory()
    ) {
      if (
        String(targetStat.dev) === journal.stageIdentity.device &&
        String(targetStat.ino) === journal.stageIdentity.inode
      ) {
        assertCompleteSkillDirectory({
          directory: targetDir,
          expectedManifestHash: journal.stagedManifestSha256,
          skill,
          allowedHarnesses,
          description: "published skill",
        });
        if (stageStat !== null) {
          throw new Error(
            `Refusing to install: interrupted skill swap has duplicate stage paths: ${journalPath}`,
          );
        }
        if (backupStat !== null) {
          validatePartiallyRemovedSkillDirectory({
            directory: backupDir,
            expectedIdentity: journal.priorIdentity,
            expectedManifestHash: journal.priorManifestSha256,
            expectedFiles: journal.priorFiles,
            skill,
            allowedHarnesses,
            description: "skill swap backup",
          });
          assertRecoveryContext();
          removeOwnedSkillDirectoryIncrementally({
            directory: backupDir,
            expectedIdentity: journal.priorIdentity,
            expectedManifestHash: journal.priorManifestSha256,
            expectedFiles: journal.priorFiles,
            skill,
            allowedHarnesses,
            description: "skill swap backup",
          });
        }
        assertRecoveryContext();
        rmSync(journalPath, { force: true });
        syncDirectory(parentDir);
        return;
      }

      if (
        backupStat === null &&
        String(targetStat.dev) === journal.priorIdentity.device &&
        String(targetStat.ino) === journal.priorIdentity.inode
      ) {
        assertCompleteSkillDirectory({
          directory: targetDir,
          expectedManifestHash: journal.priorManifestSha256,
          skill,
          allowedHarnesses,
          description: "prior skill",
        });
        if (stageStat !== null) {
          validateInterruptedSkillStage({
            directory: stageDir,
            expectedIdentity: journal.stageIdentity,
            expectedFiles: journal.stagedFiles,
            description: "skill swap stage",
          });
          assertRecoveryContext();
          removeInterruptedSkillStage({
            directory: stageDir,
            expectedIdentity: journal.stageIdentity,
            expectedFiles: journal.stagedFiles,
            description: "skill swap stage",
          });
        }
        assertRecoveryContext();
        rmSync(journalPath, { force: true });
        syncDirectory(parentDir);
        return;
      }
    }

    throw new Error(
      `Refusing to install: unable to recover interrupted skill swap: ${journalPath}`,
    );
  } finally {
    ACTIVE_OWNERSHIP_JOURNALS.delete(journalPath);
  }
}

// Determines whether an existing skill install directory may be replaced.
// Throws (refusing to mutate anything) unless the directory is missing, or
// it is fully owned by a valid prior manifest, every listed file's hash
// still matches, and `force` was passed (items 8, 9, 10).
function preflightSkillGroup({ targetDir, skill, allowedHarnesses, force }) {
  const stat = lstatIfExists(targetDir);
  if (stat === null) {
    return {
      existed: false,
      expectedFiles: [],
      expectedManifestHash: null,
      priorHarnesses: [],
      priorManifest: null,
      targetIdentity: null,
    };
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
  assertManifestOwnership(manifestResult.manifest, manifestResult.manifestPath, {
    skill,
    allowedHarnesses,
  });
  if (manifestState(manifestResult.manifest) !== MANIFEST_STATE_COMPLETE) {
    throw new Error(
      `Refusing to install: skill ownership manifest is not complete: ${manifestResult.manifestPath}`,
    );
  }

  const actualFiles = walkExistingDestinationFiles(
    targetDir,
    manifestResult.manifest.files,
  );
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

  return {
    existed: true,
    expectedFiles: manifestResult.manifest.files,
    expectedManifestHash: manifestResult.contentHash,
    priorHarnesses: manifestResult.manifest.harnesses,
    priorManifest: manifestResult.manifest,
    targetIdentity: directoryIdentity(stat),
  };
}

function assertSkillDestinationUnchanged({
  targetDir,
  existed,
  expectedFiles,
  expectedManifestHash,
  targetIdentity,
}) {
  if (!existed) {
    assertPathStillMissing(targetDir, "skill destination");
    return;
  }

  assertDirectoryIdentity(targetDir, targetIdentity, "skill destination");
  assertManifestHash(targetDir, MANIFEST_FILENAME, expectedManifestHash);
  const actualFiles = walkExistingDestinationFiles(targetDir, expectedFiles);
  const expectedPaths = expectedFiles.map((file) => file.path).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Refusing to install: skill destination changed after preflight: ${targetDir}`,
    );
  }
  assertManifestFilesUncorrupted(targetDir, expectedFiles);
}

// Per-file ownership check for a shared agent directory (item 8, 9, 10):
// unrelated files are always preserved, unowned collisions always refuse
// (even with force), and owned collisions require --force and a matching
// hash. Also identifies (and verifies) stale owned files -- files this
// installer previously wrote for this harness that are no longer part of
// the current rendered set -- so a forced update can remove them instead of
// leaving them behind as a permanent, unmanaged collision (item: stale
// owned agent cleanup). A stale file is only ever scheduled for deletion
// once it has been confirmed to still match the hash recorded for it in the
// prior manifest; any drift causes a hard refusal instead.
function preflightAgentGroup({
  targetDir,
  harness,
  skill,
  files,
  getInstalledSkillAgentFiles,
  force,
}) {
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
  if (manifestResult.exists) {
    assertManifestOwnership(manifestResult.manifest, manifestResult.manifestPath, {
      skill,
      exactHarness: harness,
    });
    if (manifestState(manifestResult.manifest) !== MANIFEST_STATE_COMPLETE) {
      throw new Error(
        `Refusing to install: agent ownership manifest is not complete: ${manifestResult.manifestPath}`,
      );
    }
  }

  const transactionResult = readTransactionIfExists(targetDir);
  if (transactionResult.exists) {
    assertJournalIsNotActive(
      transactionResult.manifestPath,
      transactionResult.manifest.ownerProcessId,
    );
    assertManifestOwnership(
      transactionResult.manifest,
      transactionResult.manifestPath,
      {
        skill,
        exactHarness: harness,
      },
    );
    if (
      manifestState(transactionResult.manifest) !==
      MANIFEST_STATE_INSTALLING
    ) {
      throw new Error(
        `Refusing to install: invalid ownership transaction: ${transactionResult.manifestPath}`,
      );
    }
  }

  const requiredManifestFiles = agentManifestFiles(files);
  const requiredFilenames = requiredManifestFiles.map((file) => file.path);
  const requiredHashes = new Map(
    requiredManifestFiles.map((file) => [file.path, file.sha256]),
  );
  let completedBeforeTransactionCleanup = false;
  let transactionOwnedFiles = [];
  if (transactionResult.exists) {
    const previousManifestSha256 =
      transactionResult.manifest.previousManifestSha256;
    let referencesCurrentManifest = false;
    if (manifestResult.exists) {
      referencesCurrentManifest =
        previousManifestSha256 === manifestResult.contentHash;
      completedBeforeTransactionCleanup = sameManifestFiles(
        transactionResult.manifest.files,
        manifestResult.manifest.files,
      );
      if (!referencesCurrentManifest && !completedBeforeTransactionCleanup) {
        throw new Error(
          `Refusing to install: ownership transaction is not linked to the completed manifest: ${transactionResult.manifestPath}`,
        );
      }
    } else if (previousManifestSha256 !== null) {
      throw new Error(
        `Refusing to install: ownership transaction references a missing completed manifest: ${transactionResult.manifestPath}`,
      );
    }

    const matchesValidatedSource = sameManifestFiles(
      transactionResult.manifest.files,
      requiredManifestFiles,
    );
    if (completedBeforeTransactionCleanup || matchesValidatedSource) {
      transactionOwnedFiles = transactionResult.manifest.files;
    } else {
      const completedPaths = new Set(
        manifestResult.exists
          ? manifestResult.manifest.files.map((file) => file.path)
          : [],
      );
      const provisionallyOwnedFiles = [];
      const unresolvedFiles = [];
      for (const file of transactionResult.manifest.files) {
        if (
          completedPaths.has(file.path) ||
          requiredHashes.get(file.path) === file.sha256
        ) {
          provisionallyOwnedFiles.push(file);
        } else {
          unresolvedFiles.push(file);
        }
      }

      const unresolvedExistingFiles = unresolvedFiles.filter((file) => {
        const filePath = resolveSafeAgentFilePath(
          targetDir,
          harness,
          file.path,
          "agent destination",
        );
        return lstatIfExists(filePath) !== null;
      });
      let matchesInstalledSkillSnapshot = false;
      if (unresolvedExistingFiles.length > 0) {
        const installedSkillAgentFiles =
          getInstalledSkillAgentFiles?.();
        matchesInstalledSkillSnapshot =
          installedSkillAgentFiles !== undefined &&
          sameManifestFiles(
            transactionResult.manifest.files,
            installedSkillAgentFiles,
          );
      }

      if (matchesInstalledSkillSnapshot) {
        transactionOwnedFiles = transactionResult.manifest.files;
      } else {
        if (unresolvedExistingFiles.length > 0) {
          throw new Error(
            `Refusing to install: ownership transaction claims an unowned agent file: ${transactionResult.manifestPath}`,
          );
        }
        transactionOwnedFiles = provisionallyOwnedFiles;
      }
    }
  }

  const allowedOwnedHashes = new Map();
  if (manifestResult.exists) {
    for (const file of manifestResult.manifest.files) {
      allowedOwnedHashes.set(file.path, new Set([file.sha256]));
    }
  }
  if (transactionResult.exists) {
    for (const file of transactionOwnedFiles) {
      const hashes = allowedOwnedHashes.get(file.path) ?? new Set();
      hashes.add(file.sha256);
      allowedOwnedHashes.set(file.path, hashes);
    }
  }

  const requiredSet = new Set(requiredFilenames);
  const hasOwnedCollision = manifestResult.exists || transactionResult.exists;
  const expectedFileStates = new Map();
  const existingOwnedPaths = new Set();

  for (const [filename, allowedHashes] of allowedOwnedHashes) {
    const filePath = resolveSafeAgentFilePath(
      targetDir,
      harness,
      filename,
      "agent destination",
    );
    const fileStat = lstatIfExists(filePath);
    if (fileStat === null) {
      expectedFileStates.set(filename, null);
      continue;
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(
        `Refusing to install: existing agent file must be a regular file: ${filePath}`,
      );
    }
    const actualHash = sha256(readFileSync(filePath));
    if (!allowedHashes.has(actualHash)) {
      throw new Error(
        `Refusing to install: file has drifted from the installer manifest, refusing to modify it: ${filePath}`,
      );
    }
    expectedFileStates.set(filename, actualHash);
    existingOwnedPaths.add(filename);
  }

  for (const filename of requiredFilenames) {
    const filePath = resolveSafeAgentFilePath(
      targetDir,
      harness,
      filename,
      "agent destination",
    );
    const fileStat = lstatIfExists(filePath);
    if (fileStat === null) {
      if (!expectedFileStates.has(filename)) {
        expectedFileStates.set(filename, null);
      }
      continue;
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(
        `Refusing to install: existing agent file must be a regular file: ${filePath}`,
      );
    }
    if (!allowedOwnedHashes.has(filename)) {
      throw new Error(
        `Refusing to install: an unmanaged agent file already exists: ${filePath}`,
      );
    }
  }

  const staleFilenames = [];
  for (const filename of allowedOwnedHashes.keys()) {
    if (requiredSet.has(filename) || !existingOwnedPaths.has(filename)) {
      continue;
    }
    staleFilenames.push(filename);
  }

  if (hasOwnedCollision && !force) {
    throw new Error(
      `Refusing to install: agent files already installed at ${targetDir} (pass --force to update)`,
    );
  }

  return {
    expectedFileStates,
    expectedManifestHash: manifestResult.exists
      ? manifestResult.contentHash
      : null,
    expectedTransactionHash: transactionResult.exists
      ? transactionResult.contentHash
      : null,
    completedTransactionNeedsCleanup:
      transactionResult.exists && completedBeforeTransactionCleanup,
    previousManifestSha256: manifestResult.exists
      ? manifestResult.contentHash
      : null,
    staleFilenames,
    targetIdentity:
      stat === null ? null : { device: stat.dev, inode: stat.ino },
  };
}

function installSkillGroup({
  resolvedHome,
  targetDir,
  existed,
  expectedFiles,
  expectedManifestHash,
  finalHarnesses,
  allowedHarnesses,
  targetIdentity,
  skill,
  skillVersion,
  sourceFiles,
  resolvedProjectRoot,
  onInstallEvent,
}) {
  const parentDir = dirname(targetDir);
  const stageDir = uniqueSiblingPath(targetDir, "knights-stage");
  assertSafeAncestors(resolvedHome, targetDir, "Skill destination");
  mkdirSync(parentDir, { recursive: true });
  assertSafeAncestors(resolvedHome, targetDir, "Skill destination");
  syncDirectoryChain(resolvedHome, parentDir);
  const parentStat = lstatSync(parentDir);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(
      `Refusing to install: skill parent directory is unsafe: ${parentDir}`,
    );
  }
  const parentIdentity = directoryIdentity(parentStat);
  const manifestFiles = sourceFiles.map((file) => ({
    path: file.relativePath,
    sha256: sha256(file.content),
    executeBits: file.executeBits,
  }));
  const manifest = buildManifest({
    skill,
    skillVersion,
    source: resolvedProjectRoot,
    harnesses: finalHarnesses,
    files: manifestFiles,
  });
  const serializedSkillManifest = serializeManifest(manifest);
  const stagedManifestSha256 = sha256(
    Buffer.from(serializedSkillManifest, "utf8"),
  );
  const journalPath = skillSwapJournalPath(targetDir);
  assertPathStillMissing(journalPath, "skill swap journal");
  const journalBase = {
    schemaVersion: SKILL_SWAP_JOURNAL_SCHEMA_VERSION,
    installer: INSTALLER_ID,
    ownerProcessId: process.pid,
    targetName: basename(targetDir),
    stageName: basename(stageDir),
    priorIdentity:
      targetIdentity === null
        ? null
        : serializedDirectoryIdentity(targetIdentity),
    stagedFiles: normalizedManifestFiles(manifestFiles),
    priorFiles:
      targetIdentity === null ? [] : normalizedManifestFiles(expectedFiles),
    stagedManifestSha256,
    priorManifestSha256:
      targetIdentity === null ? null : expectedManifestHash,
  };
  const allocatingJournal = {
    ...journalBase,
    state: SKILL_SWAP_JOURNAL_STATE_ALLOCATING,
    stageIdentity: null,
  };
  const serializedAllocatingJournal =
    `${JSON.stringify(allocatingJournal, null, 2)}\n`;
  const allocatingJournalHash = sha256(
    Buffer.from(serializedAllocatingJournal, "utf8"),
  );

  const stagedDirectories = new Set();
  let stageCreated = false;
  let stageIdentity;
  let swapJournalHash = allocatingJournalHash;
  let swapJournalIdentity;
  let stagePublished = false;
  let preserveStageForRecovery = false;
  try {
    writeExclusiveAtomicFile(journalPath, serializedAllocatingJournal);
    const createdJournal = readSkillSwapJournalIfExists(targetDir);
    if (
      !createdJournal.exists ||
      createdJournal.contentHash !== allocatingJournalHash
    ) {
      throw new Error(
        `Refusing to install: skill swap journal changed during creation: ${journalPath}`,
      );
    }
    swapJournalIdentity = createdJournal.identity;
    ACTIVE_OWNERSHIP_JOURNALS.add(journalPath);

    assertSafeAncestors(resolvedHome, targetDir, "Skill destination");
    assertDirectoryIdentity(parentDir, parentIdentity, "skill parent directory");
    mkdirSync(stageDir, { mode: 0o755 });
    stageCreated = true;
    syncDirectory(parentDir);
    stageIdentity = directoryIdentity(lstatSync(stageDir));
    stagedDirectories.add(stageDir);

    const preparedJournal = {
      ...journalBase,
      state: SKILL_SWAP_JOURNAL_STATE_PREPARED,
      stageIdentity: serializedDirectoryIdentity(stageIdentity),
    };
    const serializedPreparedJournal =
      `${JSON.stringify(preparedJournal, null, 2)}\n`;
    const updatedJournal = replaceSkillSwapJournal({
      targetDir,
      journalPath,
      expectedHash: allocatingJournalHash,
      expectedIdentity: swapJournalIdentity,
      content: serializedPreparedJournal,
    });
    swapJournalHash = updatedJournal.contentHash;
    swapJournalIdentity = updatedJournal.identity;
    onInstallEvent({ phase: "after-skill-swap-journal", targetDir });

    for (const file of sourceFiles) {
      const filePath = resolve(stageDir, file.relativePath);
      if (!isContainedPath(stageDir, filePath)) {
        throw new Error(
          `Refusing to install: validated skill file escapes the stage: ${file.relativePath}`,
        );
      }
      const fileDirectory = dirname(filePath);
      mkdirSync(fileDirectory, { recursive: true });
      addDirectoryChain(stagedDirectories, stageDir, fileDirectory);
      writeDurableNewFile(filePath, file.content, file.executeBits);
    }

    onInstallEvent({ phase: "before-skill-manifest", targetDir });
    assertSafeAncestors(resolvedHome, targetDir, "Skill destination");
    assertDirectoryIdentity(parentDir, parentIdentity, "skill parent directory");
    assertSkillPayloadSnapshot({
      directory: stageDir,
      expectedIdentity: stageIdentity,
      expectedFiles: manifestFiles,
      description: "skill stage",
    });
    writeDurableNewFile(
      join(stageDir, MANIFEST_FILENAME),
      serializedSkillManifest,
    );

    for (const directory of [...stagedDirectories].sort(
      (left, right) => right.length - left.length,
    )) {
      syncDirectory(directory);
    }
    syncDirectory(parentDir);

    onInstallEvent({ phase: "before-skill-swap", targetDir });
    assertSafeAncestors(resolvedHome, targetDir, "Skill destination");
    assertDirectoryIdentity(parentDir, parentIdentity, "skill parent directory");
    assertDirectoryIdentity(stageDir, stageIdentity, "skill stage");
    assertCompleteSkillDirectory({
      directory: stageDir,
      expectedManifestHash: stagedManifestSha256,
      skill,
      allowedHarnesses,
      description: "skill stage",
    });
    assertSkillDestinationUnchanged({
      targetDir,
      existed,
      expectedFiles,
      expectedManifestHash,
      targetIdentity,
    });
    if (!existed) {
      renameSync(stageDir, targetDir);
      stagePublished = true;
      syncDirectory(parentDir);
      assertCompleteSkillDirectory({
        directory: targetDir,
        expectedManifestHash: stagedManifestSha256,
        skill,
        allowedHarnesses,
        description: "published skill",
      });
      const currentJournal = readSkillSwapJournalIfExists(targetDir);
      if (
        !currentJournal.exists ||
        currentJournal.contentHash !== swapJournalHash ||
        currentJournal.identity.device !== swapJournalIdentity.device ||
        currentJournal.identity.inode !== swapJournalIdentity.inode
      ) {
        throw new Error(
          `Refusing to install: skill swap journal changed during installation: ${journalPath}`,
        );
      }
      rmSync(journalPath);
      syncDirectory(parentDir);
    } else {
      const backupDir = uniqueSiblingPath(targetDir, "knights-backup");
      assertSafeAncestors(resolvedHome, targetDir, "Skill destination");
      assertDirectoryIdentity(parentDir, parentIdentity, "skill parent directory");
      assertCompleteSkillDirectory({
        directory: stageDir,
        expectedManifestHash: stagedManifestSha256,
        skill,
        allowedHarnesses,
        description: "skill stage",
      });
      assertSkillDestinationUnchanged({
        targetDir,
        existed,
        expectedFiles,
        expectedManifestHash,
        targetIdentity,
      });

      let backupMoved = false;
      try {
        assertPathStillMissing(backupDir, "skill swap backup");
        renameSync(targetDir, backupDir);
        backupMoved = true;
        syncDirectory(parentDir);
        onInstallEvent({ phase: "after-skill-backup", targetDir });
        assertSafeAncestors(resolvedHome, targetDir, "Skill destination");
        assertDirectoryIdentity(
          parentDir,
          parentIdentity,
          "skill parent directory",
        );
        assertPathStillMissing(targetDir, "skill destination");
        assertDirectoryIdentity(stageDir, stageIdentity, "skill stage");
        assertCompleteSkillDirectory({
          directory: stageDir,
          expectedManifestHash: stagedManifestSha256,
          skill,
          allowedHarnesses,
          description: "skill stage",
        });
        assertDirectoryIdentity(
          backupDir,
          targetIdentity,
          "skill swap backup",
        );
        assertCompleteSkillDirectory({
          directory: backupDir,
          expectedManifestHash,
          skill,
          allowedHarnesses,
          description: "skill swap backup",
        });
        renameSync(stageDir, targetDir);
        stagePublished = true;
        syncDirectory(parentDir);
        onInstallEvent({
          phase: "before-skill-backup-cleanup",
          targetDir,
        });
        assertSafeAncestors(resolvedHome, targetDir, "Skill destination");
        assertDirectoryIdentity(
          parentDir,
          parentIdentity,
          "skill parent directory",
        );
        assertDirectoryIdentity(
          targetDir,
          stageIdentity,
          "published skill",
        );
        assertCompleteSkillDirectory({
          directory: targetDir,
          expectedManifestHash: stagedManifestSha256,
          skill,
          allowedHarnesses,
          description: "published skill",
        });
        assertCompleteSkillDirectory({
          directory: backupDir,
          expectedManifestHash,
          skill,
          allowedHarnesses,
          description: "skill swap backup",
        });
        const currentJournal = readSkillSwapJournalIfExists(targetDir);
        if (
          !currentJournal.exists ||
          currentJournal.contentHash !== swapJournalHash ||
          currentJournal.identity.device !== swapJournalIdentity.device ||
          currentJournal.identity.inode !== swapJournalIdentity.inode
        ) {
          throw new Error(
            `Refusing to install: skill swap journal changed during installation: ${journalPath}`,
          );
        }
        removeOwnedSkillDirectoryIncrementally({
          directory: backupDir,
          expectedIdentity: serializedDirectoryIdentity(targetIdentity),
          expectedManifestHash,
          expectedFiles,
          skill,
          allowedHarnesses,
          description: "skill swap backup",
          beforeManifestRemoval: () =>
            onInstallEvent({
              phase: "before-skill-backup-manifest-cleanup",
              targetDir,
            }),
        });
        backupMoved = false;
        rmSync(journalPath, { force: true });
        syncDirectory(parentDir);
      } catch (error) {
        if (backupMoved && !stagePublished) {
          try {
            assertSafeAncestors(
              resolvedHome,
              targetDir,
              "Skill destination",
            );
            assertDirectoryIdentity(
              parentDir,
              parentIdentity,
              "skill parent directory",
            );
            assertPathStillMissing(targetDir, "skill destination");
            assertDirectoryIdentity(
              backupDir,
              targetIdentity,
              "skill swap backup",
            );
            assertCompleteSkillDirectory({
              directory: backupDir,
              expectedManifestHash,
              skill,
              allowedHarnesses,
              description: "skill swap backup",
            });
            renameSync(backupDir, targetDir);
            backupMoved = false;
            syncDirectory(parentDir);
            const currentJournalStat = lstatIfExists(journalPath);
            if (
              currentJournalStat !== null &&
              !currentJournalStat.isSymbolicLink() &&
              currentJournalStat.isFile() &&
              currentJournalStat.dev === swapJournalIdentity.device &&
              currentJournalStat.ino === swapJournalIdentity.inode &&
              sha256(readFileSync(journalPath)) === swapJournalHash
            ) {
              rmSync(journalPath);
              syncDirectory(parentDir);
            }
          } catch (rollbackError) {
            preserveStageForRecovery = true;
            throw new AggregateError(
              [error, rollbackError],
              `Failed to publish staged skill and restore prior install: ${targetDir}`,
            );
          }
        }
        throw error;
      }
    }
  } finally {
    ACTIVE_OWNERSHIP_JOURNALS.delete(journalPath);
    if (!stagePublished && !preserveStageForRecovery) {
      const stageStat = lstatIfExists(stageDir);
      if (
        stageCreated &&
        stageIdentity === undefined &&
        stageStat !== null &&
        !stageStat.isSymbolicLink() &&
        stageStat.isDirectory() &&
        readdirSync(stageDir).length === 0
      ) {
        rmdirSync(stageDir);
        syncDirectory(parentDir);
      } else if (
        stageCreated &&
        stageIdentity !== undefined &&
        stageStat !== null &&
        stageStat.dev === stageIdentity.device &&
        stageStat.ino === stageIdentity.inode &&
        !stageStat.isSymbolicLink() &&
        stageStat.isDirectory()
      ) {
        removeInterruptedSkillStage({
          directory: stageDir,
          expectedIdentity: serializedDirectoryIdentity(stageIdentity),
          expectedFiles: manifestFiles,
          description: "skill stage",
        });
      }
      if (
        lstatIfExists(stageDir) === null &&
        swapJournalIdentity !== undefined
      ) {
        const currentJournal = readSkillSwapJournalIfExists(targetDir);
        if (
          currentJournal.exists &&
          currentJournal.contentHash === swapJournalHash &&
          currentJournal.identity.device === swapJournalIdentity.device &&
          currentJournal.identity.inode === swapJournalIdentity.inode
        ) {
          rmSync(journalPath);
          syncDirectory(parentDir);
        }
      }
    }
  }

  return [
    targetDir,
    ...sourceFiles.map((file) => join(targetDir, file.relativePath)),
    join(targetDir, MANIFEST_FILENAME),
  ];
}

function assertAgentDestinationUnchanged({
  resolvedHome,
  targetDir,
  targetIdentity,
  harness,
  expectedManifestHash,
  expectedTransactionHash,
  expectedFileStates,
}) {
  assertSafeAncestors(resolvedHome, targetDir, "Agent destination");
  assertDirectoryIdentity(targetDir, targetIdentity, "agent directory");
  assertManifestHash(targetDir, MANIFEST_FILENAME, expectedManifestHash);
  assertManifestHash(
    targetDir,
    TRANSACTION_FILENAME,
    expectedTransactionHash,
  );
  assertAgentFileStates(targetDir, harness, expectedFileStates);
}

function installAgentGroup({
  resolvedHome,
  targetDir,
  harness,
  files,
  completedTransactionNeedsCleanup,
  expectedFileStates,
  expectedManifestHash,
  expectedTransactionHash,
  previousManifestSha256,
  staleFilenames = [],
  targetIdentity,
  skill,
  skillVersion,
  resolvedProjectRoot,
  onInstallEvent,
}) {
  assertSafeAncestors(resolvedHome, targetDir, "Agent destination");
  if (targetIdentity === null) {
    assertPathStillMissing(targetDir, "agent directory");
  } else {
    assertDirectoryIdentity(targetDir, targetIdentity, "agent directory");
  }
  mkdirSync(targetDir, { recursive: true });
  syncDirectoryChain(resolvedHome, targetDir);
  const installedTargetIdentity =
    targetIdentity ?? directoryIdentity(lstatSync(targetDir));

  const manifestFiles = agentManifestFiles(files);
  const manifestPath = join(targetDir, MANIFEST_FILENAME);
  const transactionPath = join(targetDir, TRANSACTION_FILENAME);
  const transactionManifest = buildManifest({
    skill,
    skillVersion,
    source: resolvedProjectRoot,
    harnesses: [harness],
    files: manifestFiles,
    state: MANIFEST_STATE_INSTALLING,
    previousManifestSha256,
  });
  const serializedTransactionManifest =
    serializeManifest(transactionManifest);
  let journalIsActive = false;
  try {
    assertAgentDestinationUnchanged({
      resolvedHome,
      targetDir,
      targetIdentity: installedTargetIdentity,
      harness,
      expectedManifestHash,
      expectedTransactionHash,
      expectedFileStates,
    });
    if (completedTransactionNeedsCleanup) {
      rmSync(transactionPath, { force: true });
      syncDirectory(targetDir);
      expectedTransactionHash = null;
    }
    onInstallEvent({
      phase: "before-agent-transaction-manifest",
      targetDir,
      harness,
    });
    assertAgentDestinationUnchanged({
      resolvedHome,
      targetDir,
      targetIdentity: installedTargetIdentity,
      harness,
      expectedManifestHash,
      expectedTransactionHash,
      expectedFileStates,
    });
    if (expectedTransactionHash === null) {
      writeExclusiveAtomicFile(
        transactionPath,
        serializedTransactionManifest,
      );
    } else {
      writeAtomicFile(transactionPath, serializedTransactionManifest);
    }
    expectedTransactionHash = sha256(
      Buffer.from(serializedTransactionManifest, "utf8"),
    );
    ACTIVE_OWNERSHIP_JOURNALS.add(transactionPath);
    journalIsActive = true;
    onInstallEvent({
      phase: "after-agent-transaction-manifest",
      targetDir,
      harness,
    });

    const installedPaths = [];
  for (const [fileIndex, file] of files.entries()) {
    assertAgentDestinationUnchanged({
      resolvedHome,
      targetDir,
      targetIdentity: installedTargetIdentity,
      harness,
      expectedManifestHash,
      expectedTransactionHash,
      expectedFileStates,
    });
    const filePath = resolveSafeAgentFilePath(
      targetDir,
      harness,
      file.filename,
      "agent destination",
    );
    writeAtomicFile(filePath, file.content);
    expectedFileStates.set(file.filename, sha256(file.content));
    installedPaths.push(filePath);
    onInstallEvent({
      phase: "after-agent-file",
      targetDir,
      harness,
      filename: file.filename,
      fileIndex,
    });
  }

  // The retained completed manifest authenticates the prior path set, while
  // the linked transaction journal records the desired path set before stale
  // files are removed. A later forced run can therefore distinguish an
  // expected absence from an unowned collision.
  for (const filename of staleFilenames) {
    assertAgentDestinationUnchanged({
      resolvedHome,
      targetDir,
      targetIdentity: installedTargetIdentity,
      harness,
      expectedManifestHash,
      expectedTransactionHash,
      expectedFileStates,
    });
    const filePath = resolveSafeAgentFilePath(
      targetDir,
      harness,
      filename,
      "agent destination",
    );
    rmSync(filePath, { force: true });
    expectedFileStates.set(filename, null);
  }
  if (staleFilenames.length > 0) {
    syncDirectory(targetDir);
  }

  assertAgentDestinationUnchanged({
    resolvedHome,
    targetDir,
    targetIdentity: installedTargetIdentity,
    harness,
    expectedManifestHash,
    expectedTransactionHash,
    expectedFileStates,
  });
  const completedManifest = buildManifest({
    skill,
    skillVersion,
    source: resolvedProjectRoot,
    harnesses: [harness],
    files: manifestFiles,
  });
  const serializedCompletedManifest = serializeManifest(completedManifest);
  writeAtomicFile(manifestPath, serializedCompletedManifest);
  expectedManifestHash = sha256(
    Buffer.from(serializedCompletedManifest, "utf8"),
  );
  assertAgentDestinationUnchanged({
    resolvedHome,
    targetDir,
    targetIdentity: installedTargetIdentity,
    harness,
    expectedManifestHash,
    expectedTransactionHash,
    expectedFileStates,
  });
  onInstallEvent({
    phase: "before-agent-transaction-cleanup",
    targetDir,
    harness,
  });
  assertAgentDestinationUnchanged({
    resolvedHome,
    targetDir,
    targetIdentity: installedTargetIdentity,
    harness,
    expectedManifestHash,
    expectedTransactionHash,
    expectedFileStates,
  });
    rmSync(transactionPath, { force: true });
    syncDirectory(targetDir);
    installedPaths.push(manifestPath);

    return installedPaths;
  } finally {
    if (journalIsActive) {
      ACTIVE_OWNERSHIP_JOURNALS.delete(transactionPath);
    }
  }
}

export function install(options = {}) {
  const skill = options.skill ?? DEFAULT_SKILL;
  assertSafeSkillName(skill);

  let harnesses = normalizeHarnesses(options.harnesses ?? ["all"]);
  const force = options.force === true;
  const onInstallEvent = options.onInstallEvent ?? (() => {});
  if (typeof onInstallEvent !== "function") {
    throw new Error("onInstallEvent must be a function");
  }
  if (options.home !== undefined) {
    assertSafeHome(options.home);
  }
  const resolvedHome = resolve(options.home ?? homedir());
  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;

  // Phase 1: validate every source input. Nothing under `home` is touched
  // yet, so any failure here leaves the home directory byte-for-byte
  // unmodified (item 11).
  const source = validateSource({ projectRoot, skill, harnesses });
  onInstallEvent({ phase: "source-validated" });

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

  // Restore or finalize any previously journaled whole-skill swap before
  // ordinary ownership preflight. Recovery only touches artifacts named and
  // hash-verified by this installer, never unrelated siblings.
  for (const group of skillGroups) {
    recoverInterruptedSkillSwap({
      resolvedHome,
      targetDir: group.targetDir,
      skill,
      allowedHarnesses: group.harnesses,
      onInstallEvent,
    });
  }

  // Phase 3: preflight every selected harness's destination before any
  // mutation, so a collision or safety failure in one harness causes zero
  // changes to every harness (item 13).
  const skillPreflight = skillGroups.map((group) => {
    assertSafeAncestors(resolvedHome, group.targetDir, "Skill destination");
    const preflight = preflightSkillGroup({
      targetDir: group.targetDir,
      skill,
      allowedHarnesses: group.harnesses,
      force,
    });
    const finalHarnesses = mergedHarnesses(
      preflight.priorHarnesses,
      group.selectedHarnesses,
      group.harnesses,
    );
    return {
      group,
      ...preflight,
      finalHarnesses,
    };
  });

  // Replacing a shared skill snapshot also replaces the config/prompts used
  // by its previously installed siblings. Update their agents in this plan,
  // not just their ownership entries. Never add an uninstalled sibling.
  const sharedSiblings = skillPreflight.flatMap(({ priorHarnesses }) =>
    priorHarnesses.filter((harness) => !harnesses.includes(harness)),
  );
  if (sharedSiblings.length > 0) {
    if (source.isKnightsSkill) {
      Object.assign(
        source.generatedAgents,
        validateGeneratedAgents({
          projectRoot: source.realProjectRoot,
          harnesses: sharedSiblings,
          // Use the original render snapshot even if source files changed
          // after validation; the shared skill and agents must agree.
          rendered: source.renderedAgents,
        }),
      );
    }
    harnesses = normalizeHarnesses([...harnesses, ...sharedSiblings]);
  }
  const agentGroups = source.isKnightsSkill
    ? harnesses.map((harness) => ({
        harness,
        targetDir: resolve(resolvedHome, AGENT_HARNESS_DIRS[harness]),
        files: source.generatedAgents[harness],
      }))
    : [];

  // Complete every interrupted agent transaction that depends on one of the
  // skill snapshots above before replacing that snapshot. This includes an
  // unselected sibling in a shared Codex/Gemini skill directory. Completing
  // the old transaction first also prevents a later transaction journal from
  // becoming the only surviving ownership record for bytes written by the
  // interrupted operation.
  const interruptedAgentRecovery = [];
  if (source.isKnightsSkill) {
    for (const skillSnapshot of skillPreflight) {
      const pendingAgentGroups = skillSnapshot.group.harnesses
        .map((harness) => ({
          harness,
          targetDir: resolve(
            resolvedHome,
            AGENT_HARNESS_DIRS[harness],
          ),
        }))
        .filter((agentGroup) => {
          assertSafeAncestors(
            resolvedHome,
            agentGroup.targetDir,
            "Agent destination",
          );
          return readTransactionIfExists(agentGroup.targetDir).exists;
        });

      if (pendingAgentGroups.length === 0) {
        continue;
      }
      if (skillSnapshot.priorManifest === null) {
        throw new Error(
          `Refusing to install: interrupted agent transaction has no installed skill snapshot: ${skillSnapshot.group.targetDir}`,
        );
      }

      const recoveryPayloads = deriveInstalledSkillAgentPayloads({
        directory: skillSnapshot.group.targetDir,
        manifest: skillSnapshot.priorManifest,
        harnesses: pendingAgentGroups.map(({ harness }) => harness),
      });
      for (const agentGroup of pendingAgentGroups) {
        const files = recoveryPayloads[agentGroup.harness];
        const preflight = preflightAgentGroup({
          targetDir: agentGroup.targetDir,
          harness: agentGroup.harness,
          skill,
          files,
          getInstalledSkillAgentFiles: () => agentManifestFiles(files),
          force,
        });
        interruptedAgentRecovery.push({
          agentGroup: { ...agentGroup, files },
          skillVersion: skillSnapshot.priorManifest.skillVersion,
          resolvedProjectRoot: skillSnapshot.priorManifest.source,
          ...preflight,
        });
      }
    }
  }

  // Recovery is part of the earlier interrupted operation. All recovery
  // destinations have been preflighted above, and every write remains
  // protected by the retained transaction journal and captured file states.
  const installedPaths = [];
  for (const {
    agentGroup,
    completedTransactionNeedsCleanup,
    expectedFileStates,
    expectedManifestHash,
    expectedTransactionHash,
    previousManifestSha256,
    resolvedProjectRoot,
    skillVersion,
    staleFilenames,
    targetIdentity,
  } of interruptedAgentRecovery) {
    installedPaths.push(
      ...installAgentGroup({
        resolvedHome,
        targetDir: agentGroup.targetDir,
        harness: agentGroup.harness,
        files: agentGroup.files,
        completedTransactionNeedsCleanup,
        expectedFileStates,
        expectedManifestHash,
        expectedTransactionHash,
        previousManifestSha256,
        staleFilenames,
        targetIdentity,
        skill,
        skillVersion,
        resolvedProjectRoot,
        onInstallEvent,
      }),
    );
  }

  const agentPreflight = agentGroups.map((agentGroup) => {
    assertSafeAncestors(
      resolvedHome,
      agentGroup.targetDir,
      "Agent destination",
    );
    const skillSnapshot = skillPreflight.find(({ group }) =>
      group.harnesses.includes(agentGroup.harness),
    );
    const preflight = preflightAgentGroup({
      targetDir: agentGroup.targetDir,
      harness: agentGroup.harness,
      skill,
      files: agentGroup.files,
      getInstalledSkillAgentFiles: () => {
        if (
          skillSnapshot === undefined ||
          skillSnapshot.priorManifest === null
        ) {
          return undefined;
        }
        return deriveInstalledSkillAgentFiles({
          directory: skillSnapshot.group.targetDir,
          manifest: skillSnapshot.priorManifest,
          harnesses: [agentGroup.harness],
        })[agentGroup.harness];
      },
      force,
    });
    return { agentGroup, ...preflight };
  });

  // Phase 4: every current-install check above passed, so it is now safe to
  // publish the new skill snapshots and agent payloads.
  for (const {
    group,
    existed,
    expectedFiles,
    expectedManifestHash,
    finalHarnesses,
    targetIdentity,
  } of skillPreflight) {
    installedPaths.push(
      ...installSkillGroup({
        resolvedHome,
        targetDir: group.targetDir,
        existed,
        expectedFiles,
        expectedManifestHash,
        finalHarnesses,
        allowedHarnesses: group.harnesses,
        targetIdentity,
        skill,
        skillVersion: source.skillVersion,
        sourceFiles: source.files,
        resolvedProjectRoot: source.resolvedProjectRoot,
        onInstallEvent,
      }),
    );
  }

  for (const {
    agentGroup,
    completedTransactionNeedsCleanup,
    expectedFileStates,
    expectedManifestHash,
    expectedTransactionHash,
    previousManifestSha256,
    staleFilenames,
    targetIdentity,
  } of agentPreflight) {
    installedPaths.push(
      ...installAgentGroup({
        resolvedHome,
        targetDir: agentGroup.targetDir,
        harness: agentGroup.harness,
        files: agentGroup.files,
        completedTransactionNeedsCleanup,
        expectedFileStates,
        expectedManifestHash,
        expectedTransactionHash,
        previousManifestSha256,
        staleFilenames,
        targetIdentity,
        skill,
        skillVersion: source.skillVersion,
        resolvedProjectRoot: source.resolvedProjectRoot,
        onInstallEvent,
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
