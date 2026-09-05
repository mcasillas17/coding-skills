import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertValidConfig, DIMENSIONS, isSafeRelativePath, loadEffectiveConfig } from "./validate-config.mjs";
import { configDigest, createSnapshot, stableJson } from "./snapshot.mjs";
import { preflight, resolvePanel } from "./harness.mjs";
export { configDigest, createSnapshot, preflight, resolvePanel };

const mapping = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim() !== "";
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const severity = { critical: 4, high: 3, medium: 2, low: 1 };
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function keys(value, allowed, label) {
  requireValue(mapping(value), `${label} must be a mapping`);
  for (const key of Object.keys(value)) requireValue(allowed.includes(key), `${label} unknown key: ${key}`);
}
function validateFinding(finding) {
  keys(finding, ["id", "severity", "confidence", "file", "line", "title", "evidence", "recommendation", "status"], "finding");
  for (const field of ["id", "title", "evidence", "recommendation"]) requireValue(text(finding[field]), `finding ${field} must be non-empty`);
  requireValue(isSafeRelativePath(finding.file), "finding file must be a safe relative path");
  requireValue(positive(finding.line), "finding line must be a positive integer");
  requireValue(Object.hasOwn(severity, finding.severity), "finding severity must be critical, high, medium or low");
  requireValue(Number.isInteger(finding.confidence) && finding.confidence >= 1 && finding.confidence <= 10, "finding confidence must be 1 through 10");
  requireValue(finding.status === "open", "finding status must be open");
}

export function evaluateRound(round, context) {
  requireValue(mapping(context) && mapping(context.config) && mapping(context.snapshot), "independent config and current snapshot context are required");
  assertValidConfig(context.config);
  requireValue(context.snapshot.version === 1 && hash(context.snapshot.digest) &&
    text(context.snapshot.repositoryRoot) && /^[a-f0-9]{40,64}$/.test(context.snapshot.head ?? ""), "invalid current snapshot context");
  const panel = resolvePanel(context.config, context.harness, context);
  const required = new Map(panel.map(entry => [entry.id, entry]));
  keys(round, ["version", "round", "phase", "configDigest", "snapshotDigest", "results"], "round");
  requireValue(round.version === 2, "round version must be 2");
  requireValue(positive(round.round) && round.round <= context.config.maxReviewRounds, "round must be within configured maxReviewRounds");
  requireValue(["implementation", "final"].includes(round.phase), "phase must be implementation or final");
  requireValue(round.configDigest === configDigest(context.config), "stale or mismatched config digest");
  requireValue(round.snapshotDigest === context.snapshot.digest, "stale or mismatched snapshot digest");
  requireValue(Array.isArray(round.results), "results must be an array");
  const seen = new Set(), completed = new Set(), executions = [], groups = new Map();
  for (const result of round.results) {
    keys(result, ["reviewer", "status", "requestedModel", "execution", "snapshotDigest", "coverage", "findings"], "result");
    requireValue(required.has(result.reviewer) && !seen.has(result.reviewer), `unknown or duplicate reviewer: ${result.reviewer}`);
    seen.add(result.reviewer);
    requireValue(["completed", "failed", "skipped"].includes(result.status), "result status must be completed, failed or skipped");
    requireValue(result.snapshotDigest === context.snapshot.digest, "stale result snapshot digest");
    const expected = required.get(result.reviewer);
    requireValue(result.requestedModel === expected.model, `requested model mismatch: ${result.reviewer}`);
    if (result.findings !== undefined) {
      requireValue(Array.isArray(result.findings), "findings must be an array");
      result.findings.forEach(validateFinding);
    }
    if (result.status !== "completed") continue;
    requireValue(Array.isArray(result.findings), "completed result requires findings array");
    requireValue(Array.isArray(result.coverage) && result.coverage.length === DIMENSIONS.length &&
      DIMENSIONS.every(area => result.coverage.includes(area)), "every reviewer must cover all six dimensions exactly once");
    keys(result.execution, ["id", "model", "reason"], "execution");
    const match = target => target && target.invocationId === result.execution.id && target.model === result.execution.model;
    const fallback = !match(expected);
    requireValue(!fallback || match(expected.fallback), `execution identity/model mismatch for ${result.reviewer}`);
    requireValue(!fallback || text(result.execution.reason), "fallback execution requires a reason");
    if (result.execution.reason !== undefined) requireValue(text(result.execution.reason), "execution reason must be non-empty");
    completed.add(result.reviewer);
    executions.push({ reviewer: result.reviewer, requestedModel: expected.model, ...result.execution, fallback, coverage: [...DIMENSIONS] });
    const findingKeys = new Set();
    for (const finding of result.findings) {
      // Generic IDs alone are not defect identity. Title further distinguishes
      // independent defects reported at the same line; all raw evidence survives.
      const identity = stableJson([finding.file, finding.line, finding.id, finding.title]);
      requireValue(!findingKeys.has(identity), "duplicate finding identity within one reviewer result");
      findingKeys.add(identity);
      if (!groups.has(identity)) groups.set(identity, []);
      groups.get(identity).push({ reviewer: result.reviewer, execution: { ...result.execution }, finding: { ...finding } });
    }
  }
  const actionable = [...groups.entries()].sort(([a], [b]) => cmp(a, b)).map(([, reports]) => {
    reports.sort((a, b) => severity[b.finding.severity] - severity[a.finding.severity] ||
      b.finding.confidence - a.finding.confidence || cmp(a.reviewer, b.reviewer));
    return { ...reports[0].finding, reportedBy: reports.map(r => r.reviewer).sort(cmp), reports };
  });
  const missingReviewers = panel.map(r => r.id).filter(id => !completed.has(id)).sort(cmp);
  const state = missingReviewers.length ? "incomplete" :
    !actionable.length ? "converged" :
      round.round >= context.config.maxReviewRounds ? "limit-reached" : "actionable";
  return {
    state, actionable, missingReviewers,
    executions: executions.sort((a, b) => cmp(a.reviewer, b.reviewer)),
    publicationReady: state === "converged" && round.phase === "final",
  };
}

const USAGE = `Usage:
  node scripts/review-round.mjs snapshot --repo <root> [--artifact <relative-file>]...
  node scripts/review-round.mjs panel --repo <root> --harness <host> --mode <standalone|plugin> [--plugin-name <name>]
  node scripts/review-round.mjs preflight <inventory.json> --repo <root> --harness <host> --mode <mode> [--plugin-name <name>]
  node scripts/review-round.mjs evaluate <round.json> --repo <root> --harness <host> --mode <mode> [--plugin-name <name>] [--artifact <relative-file>]...
JSON is emitted to stdout. Store reports/inventory outside the reviewed repository.
Model availability, read-only isolation and actual execution require truthful host/operator attestation.`;
export function runCli(args = process.argv.slice(2)) {
  try {
    if (args.length === 1 && args[0] === "--help") { console.log(USAGE); return; }
    const [command, ...rest] = args, options = { artifacts: [] };
    let input;
    if (["evaluate", "preflight"].includes(command)) input = rest.shift();
    requireValue(["snapshot", "panel", "preflight", "evaluate"].includes(command), USAGE);
    const names = { "--repo": "repositoryRoot", "--harness": "harness", "--mode": "mode", "--plugin-name": "pluginName", "--artifact": "artifact" };
    while (rest.length) {
      const flag = rest.shift(), value = rest.shift();
      requireValue(Object.hasOwn(names, flag) && text(value) && !value.startsWith("--"), USAGE);
      const name = names[flag];
      if (name === "artifact") options.artifacts.push(value);
      else { requireValue(options[name] === undefined, `duplicate option: ${flag}`); options[name] = value; }
    }
    requireValue(text(options.repositoryRoot), "--repo is required");
    if (command === "snapshot") { console.log(JSON.stringify(createSnapshot(options.repositoryRoot, options), null, 2)); return; }
    requireValue(text(options.harness) && text(options.mode), "--harness and --mode are required");
    const config = loadEffectiveConfig(options);
    let output;
    if (command === "panel") output = { configDigest: configDigest(config), maxReviewRounds: config.maxReviewRounds, panel: resolvePanel(config, options.harness, options) };
    else {
      requireValue(text(input), USAGE);
      const document = JSON.parse(readFileSync(input, "utf8"));
      if (command === "preflight") output = preflight(config, options.harness, options, document);
      else {
        output = evaluateRound(document, { ...options, config, snapshot: createSnapshot(options.repositoryRoot, options) });
        process.exitCode = output.state === "converged" ? 0 : output.state === "actionable" ? 2 : 3;
      }
    }
    console.log(JSON.stringify(output, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) runCli();
