import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseYamlDocument } from "./parse-yaml.mjs";
const DEFAULT_SKILL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OVERRIDE_FILENAME = ".knights-of-the-round-table.yaml";
const ALLOWED_TOP_LEVEL = new Set([
  "version",
  "maxReviewRounds",
  "reviewerRetryCount",
  "documentationPolicy",
  "taskSources",
  "reviewers",
]);
const ALLOWED_REVIEWER_KEYS = new Set([
  "role",
  "prompt",
  "fallbackRole",
  "harnesses",
]);
const ALLOWED_OVERRIDE_KEYS = new Set(["maxReviewRounds", "reviewers"]);
const ALLOWED_CANONICAL_OVERRIDE_REVIEWER_KEYS = new Set([
  "role",
  "harnesses",
]);
const HARNESSES = ["claude", "copilot", "codex", "gemini"];
const TASK_SOURCES = new Set(["inline-prompt", "local-file"]);
const ROLE_PATTERN = /^[a-z]+(?:-[a-z]+)*$/;
const CANONICAL_REVIEWERS = [
  {
    role: "correctness",
    prompt: "reviewers/correctness.md",
    fallbackRole: null,
  },
  {
    role: "tests",
    prompt: "reviewers/tests.md",
    fallbackRole: "correctness",
  },
  {
    role: "security",
    prompt: "reviewers/security.md",
    fallbackRole: "correctness",
  },
  {
    role: "documentation",
    prompt: "reviewers/documentation.md",
    fallbackRole: "correctness",
  },
  {
    role: "architecture",
    prompt: "reviewers/architecture.md",
    fallbackRole: "correctness",
  },
  {
    role: "performance",
    prompt: "reviewers/performance.md",
    fallbackRole: "architecture",
  },
];
const CANONICAL_REVIEWER_BY_ROLE = new Map(
  CANONICAL_REVIEWERS.map((reviewer) => [reviewer.role, reviewer]),
);
const MAX_EXTRA_REVIEWERS = 10;
const MAX_EFFECTIVE_REVIEWERS =
  CANONICAL_REVIEWERS.length + MAX_EXTRA_REVIEWERS;

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isMainModule(moduleUrl, invokedPath = process.argv[1]) {
  if (invokedPath === undefined) {
    return false;
  }

  const invokedRealPath = realpathOrNull(invokedPath);
  const moduleRealPath = realpathOrNull(fileURLToPath(moduleUrl));
  return (
    invokedRealPath !== null &&
    moduleRealPath !== null &&
    invokedRealPath === moduleRealPath
  );
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function cloneReviewer(reviewer) {
  return {
    ...reviewer,
    harnesses: { ...reviewer.harnesses },
  };
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

function parseYamlFile(path, label) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${error.message}`, {
      cause: error,
    });
  }

  try {
    return parseYamlDocument(contents, label);
  } catch (error) {
    throw new Error(`Unable to parse ${label}: ${error.message}`, {
      cause: error,
    });
  }
}

export function isSafeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    posix.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("\0")
  ) {
    return false;
  }

  const segments = value.split("/");
  return (
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    ) && posix.normalize(value) === value
  );
}

export function validateConfig(config) {
  const errors = [];
  if (!isMapping(config)) {
    return ["configuration must be a mapping"];
  }

  for (const key of Object.keys(config)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      errors.push(`unknown top-level key: ${key}`);
    }
  }

  if (config.version !== 1) {
    errors.push("version must be 1");
  }
  if (!Number.isInteger(config.maxReviewRounds) || config.maxReviewRounds < 1) {
    errors.push("maxReviewRounds must be a positive integer");
  } else if (config.maxReviewRounds > 10) {
    errors.push("maxReviewRounds must be at most 10");
  }
  if (config.reviewerRetryCount !== 1) {
    errors.push("reviewerRetryCount must be exactly 1");
  }
  if (config.documentationPolicy !== "impact-based") {
    errors.push("documentationPolicy must be impact-based");
  }

  if (!Array.isArray(config.taskSources)) {
    errors.push("taskSources must be an array");
  } else {
    const seenTaskSources = new Set();
    for (const source of config.taskSources) {
      if (!TASK_SOURCES.has(source)) {
        errors.push(`unsupported task source: ${String(source)}`);
      } else if (seenTaskSources.has(source)) {
        errors.push(`duplicate task source: ${source}`);
      }
      seenTaskSources.add(source);
    }
  }

  if (!Array.isArray(config.reviewers) || config.reviewers.length === 0) {
    errors.push("reviewers must be a non-empty array");
    return errors;
  }
  if (config.reviewers.length > MAX_EFFECTIVE_REVIEWERS) {
    errors.push(
      `reviewers must contain at most ${MAX_EFFECTIVE_REVIEWERS} roles`,
    );
  }

  const roleNames = new Set();
  const reviewerByRole = new Map();
  const harnessAgentNames = Object.fromEntries(
    HARNESSES.map((harness) => [harness, new Set()]),
  );

  for (const [index, reviewer] of config.reviewers.entries()) {
    const label = `reviewers[${index}]`;
    if (!isMapping(reviewer)) {
      errors.push(`${label} must be a mapping`);
      continue;
    }

    for (const key of Object.keys(reviewer)) {
      if (!ALLOWED_REVIEWER_KEYS.has(key)) {
        errors.push(`${label} unknown reviewer key: ${key}`);
      }
    }

    const { role } = reviewer;
    if (typeof role !== "string" || !ROLE_PATTERN.test(role)) {
      errors.push(`${label} role must be lowercase hyphenated`);
    } else {
      if (roleNames.has(role)) {
        errors.push(`duplicate reviewer role: ${role}`);
      }
      roleNames.add(role);
      reviewerByRole.set(role, reviewer);
    }

    if (!isSafeRelativePath(reviewer.prompt)) {
      errors.push(`${label} prompt must be a safe relative path`);
    }

    if (
      !Object.hasOwn(reviewer, "fallbackRole") ||
      (reviewer.fallbackRole !== null &&
        (typeof reviewer.fallbackRole !== "string" ||
          !ROLE_PATTERN.test(reviewer.fallbackRole)))
    ) {
      errors.push(`${label} fallbackRole must be a reviewer role or null`);
    }

    if (!isMapping(reviewer.harnesses)) {
      errors.push(`${label} harnesses must be a mapping`);
      continue;
    }

    for (const harness of HARNESSES) {
      if (!Object.hasOwn(reviewer.harnesses, harness)) {
        errors.push(`${label} missing harness mapping: ${harness}`);
      } else if (!isNonEmptyString(reviewer.harnesses[harness])) {
        errors.push(`${label} harness ${harness} must map to a non-empty agent`);
      } else if (harnessAgentNames[harness].has(reviewer.harnesses[harness])) {
        errors.push(
          `duplicate harness agent name for ${harness}: ${reviewer.harnesses[harness]}`,
        );
      } else {
        harnessAgentNames[harness].add(reviewer.harnesses[harness]);
      }
    }
    for (const harness of Object.keys(reviewer.harnesses)) {
      if (!HARNESSES.includes(harness)) {
        errors.push(`${label} unknown harness mapping: ${harness}`);
      }
    }
  }

  for (const reviewer of config.reviewers) {
    if (
      isMapping(reviewer) &&
      typeof reviewer.fallbackRole === "string" &&
      ROLE_PATTERN.test(reviewer.fallbackRole) &&
      !reviewerByRole.has(reviewer.fallbackRole)
    ) {
      errors.push(`fallback role does not exist: ${reviewer.fallbackRole}`);
    }
  }

  for (const [role] of reviewerByRole) {
    const visited = new Set();
    let currentRole = role;
    while (currentRole !== null && reviewerByRole.has(currentRole)) {
      if (visited.has(currentRole)) {
        errors.push(`fallback cycle starting at ${role}`);
        break;
      }
      visited.add(currentRole);
      currentRole = reviewerByRole.get(currentRole).fallbackRole;
    }
  }

  return errors;
}

export function assertValidConfig(config) {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid reviewer configuration:\n${errors.join("\n")}`);
  }
}

export function validateCanonicalConfig(config) {
  const errors = validateConfig(config);
  if (!isMapping(config)) {
    return errors;
  }

  if (config.maxReviewRounds !== 10) {
    errors.push("canonical maxReviewRounds must be exactly 10");
  }

  if (!Array.isArray(config.reviewers)) {
    return errors;
  }

  const reviewersByRole = new Map(
    config.reviewers
      .filter((reviewer) => isMapping(reviewer))
      .map((reviewer) => [reviewer.role, reviewer]),
  );
  for (const expected of CANONICAL_REVIEWERS) {
    const reviewer = reviewersByRole.get(expected.role);
    if (reviewer === undefined) {
      errors.push(`canonical reviewer role is required: ${expected.role}`);
      continue;
    }
    if (reviewer.prompt !== expected.prompt) {
      errors.push(
        `canonical reviewer ${expected.role} prompt must remain ${expected.prompt}`,
      );
    }
    if (reviewer.fallbackRole !== expected.fallbackRole) {
      errors.push(
        `canonical reviewer ${expected.role} fallbackRole must remain ${String(expected.fallbackRole)}`,
      );
    }
  }

  for (const reviewer of config.reviewers) {
    if (
      isMapping(reviewer) &&
      typeof reviewer.role === "string" &&
      !CANONICAL_REVIEWER_BY_ROLE.has(reviewer.role)
    ) {
      errors.push(
        `canonical configuration must not define extra reviewer role: ${reviewer.role}`,
      );
    }
  }

  return errors;
}

export function assertValidCanonicalConfig(config) {
  const errors = validateCanonicalConfig(config);
  if (errors.length > 0) {
    throw new Error(
      `Invalid canonical reviewer configuration:\n${errors.join("\n")}`,
    );
  }
}

function validateHarnessOverride(harnesses, label, errors, { partial }) {
  if (!isMapping(harnesses)) {
    errors.push(`${label} harnesses must be a mapping`);
    return;
  }

  const harnessNames = Object.keys(harnesses);
  if (partial && harnessNames.length === 0) {
    errors.push(`${label} harnesses must include at least one mapping`);
  }

  for (const harness of harnessNames) {
    if (!HARNESSES.includes(harness)) {
      errors.push(`${label} unknown harness mapping: ${harness}`);
    } else if (!isNonEmptyString(harnesses[harness])) {
      errors.push(`${label} harness ${harness} must map to a non-empty agent`);
    }
  }

  if (!partial) {
    for (const harness of HARNESSES) {
      if (!Object.hasOwn(harnesses, harness)) {
        errors.push(`${label} missing harness mapping: ${harness}`);
      }
    }
  }
}

export function validateOverride(override) {
  const errors = [];
  if (!isMapping(override)) {
    return ["override configuration must be a mapping"];
  }

  for (const key of Object.keys(override)) {
    if (!ALLOWED_OVERRIDE_KEYS.has(key)) {
      errors.push(`unknown override top-level key: ${key}`);
    }
  }

  if (
    Object.hasOwn(override, "maxReviewRounds") &&
    (!Number.isInteger(override.maxReviewRounds) ||
      override.maxReviewRounds < 1 ||
      override.maxReviewRounds >= 10)
  ) {
    errors.push(
      "override maxReviewRounds must be an integer from 1 through 9",
    );
  }

  if (!Object.hasOwn(override, "reviewers")) {
    return errors;
  }
  if (!Array.isArray(override.reviewers)) {
    errors.push("override reviewers must be an array");
    return errors;
  }

  const seenRoles = new Set();
  let extraReviewerCount = 0;
  override.reviewers.forEach((reviewer, index) => {
    const label = `override reviewers[${index}]`;
    if (!isMapping(reviewer)) {
      errors.push(`${label} must be a mapping`);
      return;
    }

    const { role } = reviewer;
    if (typeof role !== "string" || !ROLE_PATTERN.test(role)) {
      errors.push(`${label} role must be lowercase hyphenated`);
      return;
    }
    if (seenRoles.has(role)) {
      errors.push(`duplicate override reviewer role: ${role}`);
    }
    seenRoles.add(role);

    if (CANONICAL_REVIEWER_BY_ROLE.has(role)) {
      const invalidKeys = Object.keys(reviewer).filter(
        (key) => !ALLOWED_CANONICAL_OVERRIDE_REVIEWER_KEYS.has(key),
      );
      if (invalidKeys.length > 0) {
        errors.push(
          `canonical reviewer ${role} may only override harnesses`,
        );
      }
      if (!Object.hasOwn(reviewer, "harnesses")) {
        errors.push(
          `canonical reviewer ${role} override must define harnesses`,
        );
      } else {
        validateHarnessOverride(
          reviewer.harnesses,
          `canonical reviewer ${role}`,
          errors,
          { partial: true },
        );
      }
      return;
    }

    extraReviewerCount += 1;
    for (const key of Object.keys(reviewer)) {
      if (!ALLOWED_REVIEWER_KEYS.has(key)) {
        errors.push(`${label} unknown reviewer key: ${key}`);
      }
    }
    for (const key of ALLOWED_REVIEWER_KEYS) {
      if (!Object.hasOwn(reviewer, key)) {
        errors.push(`${label} missing required key: ${key}`);
      }
    }

    if (!isSafeRelativePath(reviewer.prompt)) {
      errors.push(`${label} prompt must be a safe relative path`);
    }
    if (
      reviewer.fallbackRole !== null &&
      (typeof reviewer.fallbackRole !== "string" ||
        !ROLE_PATTERN.test(reviewer.fallbackRole))
    ) {
      errors.push(`${label} fallbackRole must be a reviewer role or null`);
    }
    validateHarnessOverride(reviewer.harnesses, label, errors, {
      partial: false,
    });
  });
  if (extraReviewerCount > MAX_EXTRA_REVIEWERS) {
    errors.push(
      `override may add at most ${MAX_EXTRA_REVIEWERS} extra reviewer roles`,
    );
  }

  return errors;
}

export function assertValidOverride(override) {
  const errors = validateOverride(override);
  if (errors.length > 0) {
    throw new Error(`Invalid reviewer override:\n${errors.join("\n")}`);
  }
}

export function mergeConfig(canonicalConfig, overrideConfig = {}) {
  assertValidCanonicalConfig(canonicalConfig);
  assertValidOverride(overrideConfig);

  const merged = {
    ...canonicalConfig,
    reviewers: canonicalConfig.reviewers.map(cloneReviewer),
  };
  if (Object.hasOwn(overrideConfig, "maxReviewRounds")) {
    merged.maxReviewRounds = overrideConfig.maxReviewRounds;
  }

  const reviewerByRole = new Map(
    merged.reviewers.map((reviewer) => [reviewer.role, reviewer]),
  );
  for (const reviewerOverride of overrideConfig.reviewers ?? []) {
    const existing = reviewerByRole.get(reviewerOverride.role);
    if (existing !== undefined) {
      existing.harnesses = {
        ...existing.harnesses,
        ...reviewerOverride.harnesses,
      };
      continue;
    }

    const extraReviewer = cloneReviewer(reviewerOverride);
    merged.reviewers.push(extraReviewer);
    reviewerByRole.set(extraReviewer.role, extraReviewer);
  }

  assertValidConfig(merged);
  return merged;
}

export function validatePromptPaths(config, skillRoot) {
  const errors = [];
  const realSkillRoot = realpathOrNull(skillRoot);
  if (realSkillRoot === null || !lstatSync(realSkillRoot).isDirectory()) {
    return ["installed skill root must be an existing directory"];
  }

  if (!Array.isArray(config?.reviewers)) {
    return errors;
  }

  for (const reviewer of config.reviewers) {
    if (
      !isMapping(reviewer) ||
      !isNonEmptyString(reviewer.role) ||
      !isSafeRelativePath(reviewer.prompt)
    ) {
      continue;
    }

    const promptPath = resolve(realSkillRoot, reviewer.prompt);
    const realPromptPath = realpathOrNull(promptPath);
    if (realPromptPath === null) {
      errors.push(
        `reviewer ${reviewer.role} prompt must exist inside the installed skill`,
      );
      continue;
    }
    if (!isContainedPath(realSkillRoot, realPromptPath)) {
      errors.push(
        `reviewer ${reviewer.role} prompt must resolve inside the installed skill`,
      );
      continue;
    }
    if (!lstatSync(realPromptPath).isFile()) {
      errors.push(`reviewer ${reviewer.role} prompt must be a regular file`);
    }
  }

  return errors;
}

export function assertValidPromptPaths(config, skillRoot) {
  const errors = validatePromptPaths(config, skillRoot);
  if (errors.length > 0) {
    throw new Error(`Invalid reviewer prompt paths:\n${errors.join("\n")}`);
  }
}

export function loadEffectiveConfig(options = {}) {
  const skillRoot = realpathSync(options.skillRoot ?? DEFAULT_SKILL_ROOT);
  const repositoryRoot = realpathSync(options.repositoryRoot ?? process.cwd());
  if (!lstatSync(repositoryRoot).isDirectory()) {
    throw new Error("repository root must be a directory");
  }

  const canonicalConfig = parseYamlFile(
    resolve(skillRoot, "config/reviewers.yaml"),
    "canonical reviewer configuration",
  );
  assertValidCanonicalConfig(canonicalConfig);
  assertValidPromptPaths(canonicalConfig, skillRoot);

  const overridePath = resolve(repositoryRoot, OVERRIDE_FILENAME);
  try {
    lstatSync(overridePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return mergeConfig(canonicalConfig);
    }
    throw new Error(
      `Unable to inspect repository reviewer override: ${error.message}`,
      { cause: error },
    );
  }
  const realOverridePath = realpathOrNull(overridePath);
  if (
    realOverridePath === null ||
    !isContainedPath(repositoryRoot, realOverridePath)
  ) {
    throw new Error(
      "repository reviewer override must resolve inside the repository root",
    );
  }
  if (!lstatSync(realOverridePath).isFile()) {
    throw new Error("repository reviewer override must be a regular file");
  }

  const overrideConfig = parseYamlFile(
    realOverridePath,
    "repository reviewer override",
  );
  const effectiveConfig = mergeConfig(canonicalConfig, overrideConfig);
  assertValidPromptPaths(effectiveConfig, skillRoot);
  return effectiveConfig;
}

export function runCli(args = process.argv.slice(2)) {
  if (args.length > 1) {
    console.error(
      "Usage: node scripts/validate-config.mjs [repository-root]",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const effectiveConfig = loadEffectiveConfig({
      repositoryRoot: args[0] ?? process.cwd(),
    });
    console.log(JSON.stringify(effectiveConfig, null, 2));
  } catch (error) {
    console.error(`Unable to validate reviewer configuration: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  runCli();
}
