import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, openSync, closeSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isSafeRelativePath } from "./validate-config.mjs";

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const digestValue = value => createHash("sha256").update(stableJson(value)).digest("hex");
export const configDigest = config => digestValue(config);

function fileDigest(path) {
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  const fd = openSync(path, "r");
  try {
    let size;
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
  } finally { closeSync(fd); }
  return hash.digest("hex");
}

// Read-only fingerprint of the review surface, not an execution attestation.
// Reports live outside the repository so writing a report cannot change itself.
export function createSnapshot(repositoryRoot, { artifacts = [] } = {}) {
  const root = realpathSync(repositoryRoot);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (realpathSync(git("rev-parse", "--show-toplevel").trim()) !== root) throw new Error("snapshot requires the repository root");
  if (!Array.isArray(artifacts) || artifacts.some(path => !isSafeRelativePath(path) || path.split("/").includes(".git"))) {
    throw new Error("artifact paths must be safe repository-relative paths outside .git");
  }
  const capture = () => {
    const head = git("rev-parse", "--verify", "HEAD").trim();
    const index = git("ls-files", "--stage", "-z");
    const indexEntries = index.split("\0").filter(Boolean);
    if (indexEntries.some(entry => /^160000 /.test(entry))) {
      throw new Error("submodule review surfaces are unsupported; one repository per invocation");
    }
    const trackedPaths = new Set(indexEntries.map(entry => entry.slice(entry.indexOf("\t") + 1)));
    const paths = [...new Set([
      ...trackedPaths,
      ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean),
      ...artifacts,
    ])].sort();
    const files = paths.map(path => {
      if (!isSafeRelativePath(path) || path.split("/").includes(".git")) throw new Error(`unsafe snapshot path: ${JSON.stringify(path)}`);
      const isArtifact = artifacts.includes(path);
      // Never traverse a parent symlink, even for explicit ignored artifacts.
      const parts = path.split("/");
      let parent = root;
      for (const part of parts.slice(0, -1)) {
        parent = resolve(parent, part);
        const stats = lstatSync(parent, { throwIfNoEntry: false });
        if (stats?.isSymbolicLink()) throw new Error(`snapshot path traverses a symlink: ${path}`);
        // A normal file replacing an indexed directory makes its old children
        // deleted. Its replacement bytes are captured via the untracked list.
        if (stats?.isFile()) {
          if (isArtifact) throw new Error(`task artifact is missing: ${path}`);
          if (trackedPaths.has(path)) return [path, "deleted"];
        }
        if (stats && !stats.isDirectory()) throw new Error(`snapshot requires directory parents: ${path}`);
      }
      const fullPath = resolve(root, path), stats = lstatSync(fullPath, { throwIfNoEntry: false });
      if (!stats) {
        if (isArtifact) throw new Error(`task artifact is missing: ${path}`);
        return [path, "deleted"];
      }
      if (stats.isSymbolicLink()) {
        if (isArtifact) throw new Error(`task artifact must not be a symlink: ${path}`);
        return [path, "symlink", readlinkSync(fullPath)];
      }
      if (stats.isDirectory() && trackedPaths.has(path) && !isArtifact) return [path, "deleted"];
      if (!stats.isFile()) throw new Error(`snapshot requires regular files (not nested repositories): ${path}`);
      return [path, stats.mode & 0o777, fileDigest(fullPath)];
    });
    return { head, index, files };
  };
  // Detect ordinary concurrent edits instead of minting a mixed-state snapshot.
  const first = capture(), second = capture();
  if (stableJson(first) !== stableJson(second)) throw new Error("repository changed while capturing snapshot; retry after writers stop");
  const taskArtifacts = [...new Set(artifacts)].sort();
  return {
    version: 1, repositoryRoot: root, head: first.head,
    digest: digestValue({ repositoryRoot: root, ...first, artifacts: taskArtifacts }),
    artifacts: taskArtifacts,
  };
}
