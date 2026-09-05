import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { isMainModule } from "./is-main-module.mjs";
import { checkGeneratedAgents, renderRepositoryAgents } from "./render-agents.mjs";
import {
  parseYamlDocument,
} from "../skills/knights-of-the-round-table/scripts/parse-yaml.mjs";
import {
  assertValidCanonicalConfig,
  assertValidConfig,
  isSafeRelativePath,
  validateCanonicalConfig,
  validateConfig,
} from "../skills/knights-of-the-round-table/scripts/validate-config.mjs";

export {
  assertValidCanonicalConfig,
  assertValidConfig,
  isSafeRelativePath,
  validateCanonicalConfig,
  validateConfig,
};

const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATHS = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "plugin.json",
  ".github/plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
];
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function requireString(value, label) {
  requireCondition(typeof value === "string" && value.trim() !== "", `${label} must be a non-empty string`);
}

// Reject symlinks in every component before reading (including contained links).
// A lexical containment check alone would allow a link to escape the skill root.
function localPath(root, path, kind = "file") {
  requireString(path, "local path");
  requireCondition(!isAbsolute(path) && !/[\\:\0]/.test(path), `unsafe local path: ${path}`);
  const target = resolve(root, path);
  const rel = relative(root, target);
  requireCondition(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    `local path must stay inside its root: ${path}`);
  let current = root;
  const parts = rel === "" ? [] : rel.split(sep);
  for (const part of parts) {
    current = resolve(current, part);
    requireCondition(!lstatSync(current).isSymbolicLink(), `local path must not be a symlink: ${path}`);
  }
  const stats = lstatSync(target);
  requireCondition(kind === "directory" ? stats.isDirectory() : stats.isFile(),
    `${path} must be a ${kind === "directory" ? "directory" : "regular file"}`);
  return target;
}

function readLocal(root, path) {
  return readFileSync(localPath(root, path), "utf8");
}

function readJson(root, path) {
  const value = JSON.parse(readLocal(root, path));
  requireCondition(isMapping(value), `${path} manifest must be a mapping`);
  return value;
}

function checkVersion(value, version, label) {
  requireCondition(value === version, `${label} version must agree with VERSION (${version})`);
}

function checkRepository(value) {
  if (value.repository === undefined) return;
  requireString(value.repository, "repository");
  const url = new URL(value.repository);
  requireCondition(url.protocol === "https:" && !url.username && !url.password &&
    !url.search && !url.hash && !url.pathname.endsWith(".git"),
  "repository must be a public HTTPS URL without credentials or .git");
}

function checkComponents(root, manifest, key, requiredPath, arrays = true) {
  const paths = arrays && Array.isArray(manifest[key]) ? manifest[key] : [manifest[key]];
  requireCondition(paths.length > 0 && paths.every((path) => typeof path === "string"),
    `${key} must be ${arrays ? "a string or non-empty string array" : "a string"}`);
  requireCondition(paths.includes(requiredPath), `${key} must expose ${requiredPath}`);
  for (const path of paths) {
    requireCondition(path.startsWith("./"), `${key} component path must start with ./: ${path}`);
    localPath(root, path, "directory");
  }
}

function checkPlugin(root, manifest, { name, version, harness }) {
  requireCondition(manifest.name === name, `plugin name must be ${name}`);
  checkVersion(manifest.version, version, "plugin");
  checkRepository(manifest);
  checkComponents(root, manifest, "skills", "./skills/", harness !== "codex");
  if (harness === "claude") {
    requireCondition(Array.isArray(manifest.agents) && manifest.agents.length > 0,
      "Claude agents must be a non-empty explicit Markdown file list");
    requireCondition(new Set(manifest.agents).size === manifest.agents.length,
      "Claude agents must not contain duplicate paths");
    for (const path of manifest.agents) {
      requireCondition(typeof path === "string" && path.startsWith("./") && path.endsWith(".md"),
        "Claude agents must contain local ./ Markdown file paths");
      localPath(root, path);
    }
  } else if (harness === "codex") {
    requireCondition(!Object.hasOwn(manifest, "agents"),
      "Codex plugin manifests do not support agents; use the explicit installer");
  } else {
    checkComponents(root, manifest, "agents", "./agents/");
  }
}

function checkMarketplace(root, manifest, { name, version, harness }) {
  requireString(manifest.name, "marketplace name");
  requireCondition(Array.isArray(manifest.plugins) && manifest.plugins.length > 0,
    "marketplace plugins must be a non-empty array");
  if (harness === "copilot") {
    requireCondition(isMapping(manifest.owner), "marketplace owner must be a mapping");
    requireString(manifest.owner.name, "marketplace owner.name");
  } else {
    requireCondition(!Object.hasOwn(manifest, "version"), "Codex marketplace does not support a version field");
  }
  const names = new Set();
  for (const entry of manifest.plugins) {
    requireCondition(isMapping(entry), "marketplace plugin entry must be a mapping");
    requireString(entry.name, "marketplace plugin name");
    requireCondition(!names.has(entry.name), `duplicate marketplace plugin name: ${entry.name}`);
    names.add(entry.name);
    requireCondition(typeof entry.source === "string" || isMapping(entry.source),
      `plugin ${entry.name} source must be a path or source mapping`);
    if (entry.name === name) {
      requireCondition(harness === "copilot" ? entry.source === "./"
        : entry.source === "./" || (isMapping(entry.source) &&
          entry.source.source === "local" && entry.source.path === "./"),
      `${harness} plugin source must be local repository root ./`);
    }
    if (harness === "codex") {
      requireCondition(!Object.hasOwn(entry, "version"), "Codex marketplace plugin entry does not support a version field");
      requireCondition(isMapping(entry.policy), "Codex plugin policy must be a mapping");
      requireString(entry.policy.installation, "policy.installation");
      requireString(entry.policy.authentication, "policy.authentication");
      requireString(entry.category, "category");
    }
    // Validate local sources even on additional entries, without pinning them to
    // this package's identity/version or assuming the first entry is ours.
    const isLocalSource = typeof entry.source === "string"
      ? !/^[a-z][a-z0-9+.-]*:/i.test(entry.source)
      : entry.source.source === "local";
    if (isLocalSource) {
      const sourcePath = typeof entry.source === "string" ? entry.source : entry.source.path;
      requireCondition(typeof sourcePath === "string" && sourcePath.startsWith("./"),
        `plugin ${entry.name} local source path must start with ./`);
      const sourceRoot = localPath(root, sourcePath, "directory");
      const sourceManifest = readJson(sourceRoot,
        harness === "codex" ? ".codex-plugin/plugin.json" : "plugin.json");
      requireCondition(sourceManifest.name === entry.name, `source plugin name must be ${entry.name}`);
      requireString(sourceManifest.version, "source plugin version");
      if (harness === "copilot" && entry.version !== undefined) {
        checkVersion(entry.version, sourceManifest.version, "marketplace source");
      }
    }
  }
  const entry = manifest.plugins.find((candidate) => candidate.name === name);
  requireCondition(entry !== undefined, `marketplace must include plugin ${name}`);
  if (harness === "copilot") {
    checkPlugin(root, entry, { name, version, harness });
  } else {
    const source = entry.source;
    // No marketplace version field: resolve the local source to its manifest.
    const sourceRoot = localPath(root, typeof source === "string" ? source : source.path, "directory");
    checkPlugin(sourceRoot, readJson(sourceRoot, ".codex-plugin/plugin.json"), { name, version, harness });
  }
}

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text.replace(/\r\n/g, "\n"));
  requireCondition(match !== null, "SKILL.md must contain YAML frontmatter");
  const value = YAML.parse(match[1]);
  requireCondition(isMapping(value), "SKILL.md frontmatter must be a mapping");
  return value;
}

function withoutFencedCode(text) {
  let fence = null;
  return text.split(/\r\n?|\n/).map((line) => {
    if (fence !== null) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) {
        fence = null;
      }
      return "";
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && (opening[1][0] !== "`" || !opening[2].includes("`"))) {
      fence = opening[1];
      return "";
    }
    return line;
  }).join("\n");
}

// Deterministic Markdown subset: inline and reference-definition link targets
// are document-relative. Concrete backtick paths in skill-owned namespaces or
// beginning ./ are skill-root-relative. SKILL.md also checks ../ backtick paths;
// supporting prose may discuss source-repository paths such as ../../scripts/.
// Commands, globs, placeholders and bare filenames are not dependency declarations.
function localReferences(prose, isSkillEntrypoint) {
  const references = [];
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)|^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm)) {
    const target = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
    const rawPath = target.split(/[?#]/)[0];
    let path;
    try {
      path = decodeURIComponent(rawPath);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      // Markdown can name files containing a literal, unencoded percent sign.
      path = rawPath;
    }
    if (path) references.push({ path, fromDocument: true });
  }
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) {
    const path = match[1];
    if (/^(?:\.\/|(?:references|assets|reviewers|scripts|config)\/)[^\s`<>*?]+$/.test(path) ||
        (isSkillEntrypoint && /^\.\.\/[^\s`<>*?]+$/.test(path))) {
      references.push({ path, fromDocument: false });
    }
  }
  return references;
}

function skillProseFiles(skillRoot) {
  const files = ["SKILL.md"];
  function walk(path) {
    localPath(skillRoot, path, "directory");
    for (const entry of readdirSync(resolve(skillRoot, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${path}/${entry.name}`;
      requireCondition(!entry.isSymbolicLink(), `skill prose must not be a symlink: ${child}`);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".md")) files.push(child);
    }
  }
  for (const directory of ["references", "assets", "reviewers"]) {
    if (lstatSync(resolve(skillRoot, directory), { throwIfNoEntry: false })) walk(directory);
  }
  return files;
}

export function validateRepository({ projectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  const result = {
    errors: [], skillCount: 0, reviewerCount: 0, generatedAgentCount: 0, manifestCount: 0,
  };
  function capture(label, action) {
    try { return action(); }
    catch (error) { result.errors.push(`${label}: ${error.message}`); }
  }
  const root = capture("repository", () => realpathSync(projectRoot));
  if (!root) return result;
  const version = capture("VERSION", () => {
    const value = readLocal(root, "VERSION").trim();
    requireCondition(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value), "VERSION must contain a plugin version");
    return value;
  });
  const packageJson = capture("package.json", () => {
    const value = readJson(root, "package.json");
    requireString(value.name, "package name");
    checkVersion(value.version, version, "package.json");
    return value;
  });
  for (const [index, path] of MANIFEST_PATHS.entries()) {
    capture(path, () => {
      const manifest = readJson(root, path);
      result.manifestCount++;
      const harness = ["claude", "codex", "copilot", "copilot", "codex"][index];
      const options = { name: packageJson?.name, version, harness };
      if (index < 3) checkPlugin(root, manifest, options);
      else checkMarketplace(root, manifest, options);
    });
  }

  const skillEntries = capture("skills", () =>
    readdirSync(localPath(root, "skills", "directory"), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) ?? [];
  for (const entry of skillEntries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const label = `skills/${entry.name}`;
    result.skillCount++;
    const skillRoot = capture(label, () => localPath(root, label, "directory"));
    if (!skillRoot) continue;
    capture(`${label}/SKILL.md`, () => {
      const frontmatter = parseFrontmatter(readLocal(skillRoot, "SKILL.md"));
      requireCondition(typeof frontmatter.name === "string" &&
        frontmatter.name.length <= 64 && NAME_PATTERN.test(frontmatter.name),
      "skill name must be lowercase hyphenated and at most 64 characters");
      requireCondition(frontmatter.name === entry.name, "skill name must equal its directory name");
      requireString(frontmatter.description, "skill description");
      requireCondition(frontmatter.description.length <= 1024, "skill description must be at most 1024 characters");
    });
    const proseFiles = capture(label, () => skillProseFiles(skillRoot)) ?? [];
    for (const path of proseFiles) {
      capture(`${label}/${path}`, () => {
        const prose = withoutFencedCode(readLocal(skillRoot, path));
        requireCondition(!/(?:^|[^A-Za-z0-9_])(?:TBD|TODO|FIXME|XXX)(?=$|[^A-Za-z0-9_])/.test(prose),
          "unfinished prose placeholder");
        for (const reference of localReferences(prose, path === "SKILL.md")) {
          const target = reference.fromDocument
            ? relative(skillRoot, resolve(skillRoot, path, "..", reference.path))
            : reference.path;
          // Absolute links must not be made relative before the safety check.
          requireCondition(!isAbsolute(reference.path), `unsafe reference path: ${reference.path}`);
          const kind = reference.path.endsWith("/") ? "directory" : "file";
          try { localPath(skillRoot, target, kind); }
          catch (error) { throw new Error(`reference ${reference.path}: ${error.message}`); }
        }
      });
    }
  }
  if (result.skillCount === 0) {
    result.errors.push("skills must contain at least one skill directory");
  }
  const repositoryAgents = capture("reviewer configuration", () =>
    renderRepositoryAgents({ projectRoot: root }));
  if (!repositoryAgents) return result;
  for (const { config } of repositoryAgents.skills) {
    result.reviewerCount += Object.values(config.panels).reduce((count, panel) => count + panel.length, 0);
  }
  capture("Claude agents", () => {
    const actual = readJson(root, ".claude-plugin/plugin.json").agents;
    const expected = Object.keys(repositoryAgents.rendered.claude).sort()
      .map((filename) => `./generated/claude/agents/${filename}`);
    requireCondition(Array.isArray(actual) &&
      JSON.stringify([...actual].sort()) === JSON.stringify(expected),
    "Claude agents file list must match the repository renderer outputs");
  });
  capture("generated agents", () => {
    const generated = checkGeneratedAgents(repositoryAgents.rendered, { projectRoot: root });
    result.generatedAgentCount = generated.fileCount;
    requireCondition(generated.drift.length === 0,
      `generated agents or ownership manifest are out of date: ${generated.drift.join(", ")}`);
  });
  return result;

}

function runConfigCli(configPath) {
  let config;
  try {
    config = parseYamlDocument(
      readFileSync(configPath, "utf8"),
      "reviewer configuration",
    );
  } catch (error) {
    console.error(`Unable to load reviewer configuration: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Validated ${Object.values(config.panels).reduce((count, panel) => count + panel.length, 0)} whole-panel reviewers across ${
      Object.keys(config.panels).length
    } harnesses.`,
  );
}

function runCli() {
  if (process.argv[2] !== undefined) {
    runConfigCli(process.argv[2]);
    return;
  }
  const result = validateRepository();
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Validated ${result.skillCount} skill${result.skillCount === 1 ? "" : "s"}, ` +
    `${result.reviewerCount} whole-panel reviewers, ${result.generatedAgentCount} generated agents, ` +
    `and ${result.manifestCount} manifests.`,
  );
}

if (isMainModule(import.meta.url)) {
  runCli();
}
