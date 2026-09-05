import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOP_LEVEL_KEYS = ["round", "maxRounds", "requiredReviewers", "results"];
const RESULT_KEYS = new Set(["reviewer", "status", "findings"]);
const RESULT_STATUSES = new Set(["completed", "failed", "skipped"]);
const FINDING_KEYS = new Set([
  "id",
  "severity",
  "confidence",
  "file",
  "line",
  "title",
  "evidence",
  "recommendation",
  "status",
]);
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const FINDING_STATUSES = new Set(["open"]);

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function deepEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (isMapping(a) && isMapping(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key, index) => key === bKeys[index]) &&
      aKeys.every((key) => deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function validateFinding(finding, label, errors) {
  if (!isMapping(finding)) {
    errors.push(`${label} must be a mapping`);
    return;
  }

  for (const key of Object.keys(finding)) {
    if (!FINDING_KEYS.has(key)) {
      errors.push(`${label} unknown key: ${key}`);
    }
  }

  for (const field of ["id", "file", "title", "evidence", "recommendation"]) {
    if (!isNonEmptyString(finding[field])) {
      errors.push(`${label}.${field} must be a non-empty string`);
    }
  }

  if (!SEVERITIES.has(finding.severity)) {
    errors.push(`${label}.severity must be one of critical, high, medium, low`);
  }

  if (
    !(
      Number.isInteger(finding.confidence) &&
      finding.confidence >= 1 &&
      finding.confidence <= 10
    )
  ) {
    errors.push(`${label}.confidence must be an integer from 1 to 10`);
  }

  if (!isPositiveInteger(finding.line)) {
    errors.push(`${label}.line must be a positive integer`);
  }

  if (!FINDING_STATUSES.has(finding.status)) {
    errors.push(`${label}.status must be open`);
  }
}

function collectErrors(round) {
  if (!isMapping(round)) {
    return ["review round must be a mapping"];
  }

  const errors = [];
  const roundKeys = new Set(TOP_LEVEL_KEYS);
  for (const key of Object.keys(round)) {
    if (!roundKeys.has(key)) {
      errors.push(`unknown top-level key: ${key}`);
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!Object.hasOwn(round, key)) {
      errors.push(`missing required key: ${key}`);
    }
  }

  if (!isPositiveInteger(round.maxRounds)) {
    errors.push("maxRounds must be a positive integer");
  }
  if (!isPositiveInteger(round.round)) {
    errors.push("round must be a positive integer");
  } else if (isPositiveInteger(round.maxRounds) && round.round > round.maxRounds) {
    errors.push("round must not exceed maxRounds");
  }

  let knownReviewers = new Set();
  if (!Array.isArray(round.requiredReviewers) || round.requiredReviewers.length === 0) {
    errors.push("requiredReviewers must be a non-empty array");
  } else {
    const seen = new Set();
    round.requiredReviewers.forEach((reviewer, index) => {
      const label = `requiredReviewers[${index}]`;
      if (!isNonEmptyString(reviewer)) {
        errors.push(`${label} must be a non-empty string`);
        return;
      }
      if (seen.has(reviewer)) {
        errors.push(`duplicate required reviewer: ${reviewer}`);
      }
      seen.add(reviewer);
    });
    knownReviewers = seen;
  }

  if (!Array.isArray(round.results)) {
    errors.push("results must be an array");
  } else {
    const seenReviewers = new Set();
    round.results.forEach((result, index) => {
      const label = `results[${index}]`;
      if (!isMapping(result)) {
        errors.push(`${label} must be a mapping`);
        return;
      }

      for (const key of Object.keys(result)) {
        if (!RESULT_KEYS.has(key)) {
          errors.push(`${label} unknown key: ${key}`);
        }
      }

      const { reviewer, status } = result;
      if (!isNonEmptyString(reviewer)) {
        errors.push(`${label}.reviewer must be a non-empty string`);
      } else {
        if (!knownReviewers.has(reviewer)) {
          errors.push(
            `${label}.reviewer is not a recognized reviewer: ${reviewer}`,
          );
        }
        if (seenReviewers.has(reviewer)) {
          errors.push(`duplicate result for reviewer: ${reviewer}`);
        }
        seenReviewers.add(reviewer);
      }

      if (!RESULT_STATUSES.has(status)) {
        errors.push(
          `${label}.status must be one of completed, failed, skipped`,
        );
      }

      if (status === "completed") {
        if (!Array.isArray(result.findings)) {
          errors.push(
            `${label}.findings must be an array for a completed result`,
          );
        } else {
          result.findings.forEach((finding, findingIndex) => {
            validateFinding(
              finding,
              `${label}.findings[${findingIndex}]`,
              errors,
            );
          });
        }
      } else if (Object.hasOwn(result, "findings")) {
        if (!Array.isArray(result.findings)) {
          errors.push(`${label}.findings must be an array when present`);
        } else {
          result.findings.forEach((finding, findingIndex) => {
            validateFinding(
              finding,
              `${label}.findings[${findingIndex}]`,
              errors,
            );
          });
        }
      }
    });
  }

  return errors;
}

export function evaluateRound(round) {
  const errors = collectErrors(round);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  const completedResults = round.results.filter(
    (result) => result.status === "completed",
  );
  const completedReviewers = new Set(
    completedResults.map((result) => result.reviewer),
  );
  const missingReviewers = round.requiredReviewers
    .filter((reviewer) => !completedReviewers.has(reviewer))
    .slice()
    .sort();

  const findingsById = new Map();
  for (const result of completedResults) {
    for (const finding of result.findings) {
      const existing = findingsById.get(finding.id);
      if (existing === undefined) {
        findingsById.set(finding.id, finding);
      } else if (!deepEqual(existing, finding)) {
        throw new Error(`conflicting finding payload for id: ${finding.id}`);
      }
    }
  }

  const actionable = [...findingsById.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  if (missingReviewers.length > 0) {
    return { state: "incomplete", actionable, missingReviewers };
  }
  if (actionable.length > 0) {
    if (round.round >= round.maxRounds) {
      return { state: "limit-reached", actionable, missingReviewers: [] };
    }
    return { state: "actionable", actionable, missingReviewers: [] };
  }
  return { state: "converged", actionable: [], missingReviewers: [] };
}

function exitCodeFor(state) {
  if (state === "converged") {
    return 0;
  }
  if (state === "actionable") {
    return 2;
  }
  return 3;
}

function runCli() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("Usage: node scripts/review-round.mjs <review-round.json>");
    process.exitCode = 3;
    return;
  }

  const [path] = args;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`Unable to read review round file: ${error.message}`);
    process.exitCode = 3;
    return;
  }

  let round;
  try {
    round = JSON.parse(raw);
  } catch (error) {
    console.error(`Unable to parse review round JSON: ${error.message}`);
    process.exitCode = 3;
    return;
  }

  let result;
  try {
    result = evaluateRound(round);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 3;
    return;
  }

  console.log(JSON.stringify(result));
  process.exitCode = exitCodeFor(result.state);
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli();
}
