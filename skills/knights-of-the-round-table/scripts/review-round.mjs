import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

const TOP_LEVEL_KEYS = ["round", "maxRounds", "requiredReviewers", "results"];
const RESULT_KEYS = new Set(["reviewer", "status", "findings"]);
const RESULT_STATUSES = new Set(["completed", "failed", "skipped"]);
const FINDING_FIELD_ORDER = [
  "id",
  "severity",
  "confidence",
  "file",
  "line",
  "title",
  "evidence",
  "recommendation",
  "status",
];
const FINDING_KEYS = new Set(FINDING_FIELD_ORDER);
const SEVERITY_PRIORITY = new Map([
  ["critical", 4],
  ["high", 3],
  ["medium", 2],
  ["low", 1],
]);
const SEVERITIES = new Set(SEVERITY_PRIORITY.keys());
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

function canonicalizeFinding(finding) {
  const canonical = {};
  for (const key of FINDING_FIELD_ORDER) {
    canonical[key] = finding[key];
  }
  return canonical;
}

function compareLexically(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFindingReports(a, b) {
  const severityDifference =
    SEVERITY_PRIORITY.get(b.finding.severity) -
    SEVERITY_PRIORITY.get(a.finding.severity);
  if (severityDifference !== 0) {
    return severityDifference;
  }

  const confidenceDifference =
    b.finding.confidence - a.finding.confidence;
  if (confidenceDifference !== 0) {
    return confidenceDifference;
  }

  return compareLexically(a.reviewer, b.reviewer);
}

function createActionableFinding(report, reportedBy) {
  return {
    ...report.finding,
    reportedBy: [...reportedBy].sort(compareLexically),
  };
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

      if (status === "completed" && !Array.isArray(result.findings)) {
        errors.push(
          `${label}.findings must be an array for a completed result`,
        );
      } else if (
        Object.hasOwn(result, "findings") &&
        !Array.isArray(result.findings)
      ) {
        errors.push(`${label}.findings must be an array when present`);
      }

      if (Array.isArray(result.findings)) {
        const seenFindingIds = new Set();
        result.findings.forEach((finding, findingIndex) => {
          validateFinding(
            finding,
            `${label}.findings[${findingIndex}]`,
            errors,
          );
          if (isMapping(finding) && isNonEmptyString(finding.id)) {
            if (seenFindingIds.has(finding.id)) {
              errors.push(
                `duplicate finding id for reviewer ${reviewer}: ${finding.id}`,
              );
            }
            seenFindingIds.add(finding.id);
          }
        });
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

  const findingGroupsById = new Map();
  for (const result of completedResults) {
    for (const rawFinding of result.findings) {
      const report = {
        reviewer: result.reviewer,
        finding: canonicalizeFinding(rawFinding),
      };
      const existing = findingGroupsById.get(report.finding.id);
      if (existing === undefined) {
        findingGroupsById.set(report.finding.id, {
          canonicalReport: report,
          reportedBy: new Set([result.reviewer]),
        });
      } else {
        existing.reportedBy.add(result.reviewer);
        if (compareFindingReports(report, existing.canonicalReport) < 0) {
          existing.canonicalReport = report;
        }
      }
    }
  }

  const actionable = [...findingGroupsById.values()]
    .map(({ canonicalReport, reportedBy }) =>
      createActionableFinding(canonicalReport, reportedBy),
    )
    .sort((a, b) => compareLexically(a.id, b.id));

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

export function runCli() {
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

if (isMainModule(import.meta.url)) {
  runCli();
}
