import { readFileSync } from "node:fs";
import { posix } from "node:path";
import YAML from "yaml";

import { isMainModule } from "./is-main-module.mjs";

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
const HARNESSES = ["claude", "copilot", "codex", "gemini"];
const TASK_SOURCES = new Set(["inline-prompt", "local-file"]);
const ROLE_PATTERN = /^[a-z]+(?:-[a-z]+)*$/;

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    posix.normalize(value) === value
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
  }
  if (
    !Number.isInteger(config.reviewerRetryCount) ||
    config.reviewerRetryCount < 0
  ) {
    errors.push("reviewerRetryCount must be a non-negative integer");
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
      } else if (
        typeof reviewer.harnesses[harness] !== "string" ||
        reviewer.harnesses[harness].trim() === ""
      ) {
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

function runCli() {
  const configPath =
    process.argv[2] ??
    new URL(
      "../skills/knights-of-the-round-table/config/reviewers.yaml",
      import.meta.url,
    );

  let config;
  try {
    config = YAML.parse(readFileSync(configPath, "utf8"));
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
    `Validated ${config.reviewers.length} reviewer roles across ${HARNESSES.length} harnesses.`,
  );
}

if (isMainModule(import.meta.url)) {
  runCli();
}
