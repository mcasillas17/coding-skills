import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYamlDocument } from "./parse-yaml.mjs";

const DEFAULT_SKILL_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const HARNESSES = ["copilot", "claude", "codex", "gemini"];
export const DIMENSIONS = ["correctness", "tests", "security", "documentation", "architecture", "performance"];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
const KEYS = ["version", "strategy", "maxReviewRounds", "reviewerRetryCount", "documentationPolicy", "taskSources", "prompt", "panels"];
const mapping = value => value !== null && typeof value === "object" && !Array.isArray(value);

function unknownKeys(value, keys, label, errors) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${label} unknown key: ${key}`);
}

export function isSafeRelativePath(value) {
  return typeof value === "string" && value.length > 0 &&
    !posix.isAbsolute(value) && !/[\\:\0\r\n]/.test(value) &&
    value.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..") &&
    posix.normalize(value) === value;
}

function validatePanels(panels, errors, partial = false) {
  if (!mapping(panels)) { errors.push("panels must be a mapping"); return; }
  unknownKeys(panels, HARNESSES, "panels", errors);
  if (!partial) for (const harness of HARNESSES) {
    if (!Object.hasOwn(panels, harness)) errors.push(`missing panel: ${harness}`);
  }
  for (const [harness, panel] of Object.entries(panels)) {
    if (!Array.isArray(panel) || !panel.length) { errors.push(`${harness} panel must be a non-empty array`); continue; }
    const ids = new Set(), models = new Set(), executors = new Map();
    const executor = (entry, label) => {
      if (!mapping(entry)) { errors.push(`${label} must be a mapping`); return; }
      if (typeof entry.id !== "string" || !ID.test(entry.id)) errors.push(`${label} id must be lowercase hyphenated`);
      if (typeof entry.model !== "string" || !MODEL.test(entry.model) || entry.model === "inherit") errors.push(`${label} model must be an explicit model ID or requested alias`);
      if (executors.has(entry.id) && executors.get(entry.id) !== entry.model) errors.push(`${harness} conflicting model for agent ${entry.id}`);
      executors.set(entry.id, entry.model);
    };
    for (const [index, reviewer] of panel.entries()) {
      const label = `${harness}[${index}]`;
      executor(reviewer, label);
      if (!mapping(reviewer)) continue;
      unknownKeys(reviewer, ["id", "model", "fallback"], label, errors);
      if (ids.has(reviewer.id)) errors.push(`${harness} duplicate reviewer id: ${reviewer.id}`);
      if (models.has(reviewer.model)) errors.push(`${harness} duplicate primary model: ${reviewer.model}`);
      ids.add(reviewer.id); models.add(reviewer.model);
      if (reviewer.fallback !== null) {
        executor(reviewer.fallback, `${label}.fallback`);
        if (mapping(reviewer.fallback)) {
          unknownKeys(reviewer.fallback, ["id", "model"], `${label}.fallback`, errors);
          if (reviewer.fallback.id === reviewer.id) errors.push(`${label} fallback must be a different executor`);
        }
      }
    }
  }
}

function roundLimit(value, errors) {
  if (!Number.isSafeInteger(value) || value < 1) errors.push("maxReviewRounds must be a positive safe integer");
}

export function validateConfig(config) {
  if (!mapping(config)) return ["configuration must be a mapping"];
  const errors = [];
  unknownKeys(config, KEYS, "configuration", errors);
  if (config.version !== 2) errors.push("version must be 2");
  if (config.strategy !== "whole_panel") errors.push("strategy must be whole_panel");
  // No cap by default: the panel runs until it returns no feedback.
  if (Object.hasOwn(config, "maxReviewRounds")) roundLimit(config.maxReviewRounds, errors);
  if (config.reviewerRetryCount !== 1) errors.push("reviewerRetryCount must be exactly 1");
  if (config.documentationPolicy !== "impact-based") errors.push("documentationPolicy must be impact-based");
  if (!Array.isArray(config.taskSources) || config.taskSources.length !== 2 ||
      !config.taskSources.includes("inline-prompt") || !config.taskSources.includes("local-file")) {
    errors.push("taskSources must contain inline-prompt and local-file exactly once");
  }
  if (!isSafeRelativePath(config.prompt)) errors.push("prompt must be a safe relative path");
  validatePanels(config.panels, errors);
  return errors;
}

// The defaults are tested in the source package; effective configs have no hidden
// panel floor or upper-only/lower-only round policy.
export const validateCanonicalConfig = validateConfig;
function assertErrors(errors, label) {
  if (errors.length) throw new Error(`Invalid ${label}:\n${errors.join("\n")}`);
}
export function assertValidConfig(config) { assertErrors(validateConfig(config), "reviewer configuration"); }
export const assertValidCanonicalConfig = assertValidConfig;

export function validateOverride(override) {
  if (!mapping(override)) return ["override configuration must be a mapping"];
  const errors = [];
  unknownKeys(override, ["maxReviewRounds", "panels"], "override", errors);
  if (Object.hasOwn(override, "maxReviewRounds")) roundLimit(override.maxReviewRounds, errors);
  if (Object.hasOwn(override, "panels")) validatePanels(override.panels, errors, true);
  return errors;
}
export function assertValidOverride(override) { assertErrors(validateOverride(override), "reviewer override"); }
export function mergeConfig(canonicalConfig, overrideConfig = {}) {
  assertValidCanonicalConfig(canonicalConfig);
  assertValidOverride(overrideConfig);
  const result = structuredClone(canonicalConfig);
  if (Object.hasOwn(overrideConfig, "maxReviewRounds")) result.maxReviewRounds = overrideConfig.maxReviewRounds;
  Object.assign(result.panels, structuredClone(overrideConfig.panels ?? {}));
  assertValidConfig(result);
  return result;
}

function contained(root, path) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function containedFile(root, path) {
  if (!isSafeRelativePath(path)) throw new Error("file must be a safe relative path");
  let current = root;
  for (const part of path.split("/")) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${path} must not be a symlink`);
  }
  if (!contained(root, realpathSync(current))) throw new Error(`${path} must resolve inside its root`);
  if (!lstatSync(current).isFile()) throw new Error(`${path} must be a regular file`);
  return current;
}
export function validatePromptPaths(config, skillRoot) {
  try { containedFile(realpathSync(skillRoot), config.prompt); return []; }
  catch (error) { return [`reviewer prompt: ${error.message}`]; }
}
export function assertValidPromptPaths(config, skillRoot) {
  assertErrors(validatePromptPaths(config, skillRoot), "reviewer prompt paths");
}
function parseFile(root, path) {
  return parseYamlDocument(readFileSync(containedFile(root, path), "utf8"), path);
}
export function loadEffectiveConfig(options = {}) {
  const skillRoot = realpathSync(options.skillRoot ?? DEFAULT_SKILL_ROOT);
  const repositoryRoot = realpathSync(options.repositoryRoot ?? process.cwd());
  if (!lstatSync(repositoryRoot).isDirectory()) throw new Error("repository root must be a directory");
  const config = parseFile(skillRoot, "config/reviewers.yaml");
  assertValidCanonicalConfig(config);
  assertValidPromptPaths(config, skillRoot);
  const override = ".knights-of-the-round-table.yaml";
  // A dangling link is not a missing override; lstat sees it and containedFile
  // rejects it rather than silently using defaults.
  const exists = lstatSync(resolve(repositoryRoot, override), { throwIfNoEntry: false });
  const effective = mergeConfig(config, exists ? parseFile(repositoryRoot, override) : {});
  // A cap the user states when invoking the skill wins over the repository's.
  if (options.maxReviewRounds === undefined) return effective;
  return mergeConfig(effective, { maxReviewRounds: options.maxReviewRounds });
}
export function runCli(args = process.argv.slice(2)) {
  try {
    if (args.length > 1) throw new Error("Usage: node scripts/validate-config.mjs [repository-root]");
    console.log(JSON.stringify(loadEffectiveConfig({ repositoryRoot: args[0] ?? process.cwd() }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) runCli();
