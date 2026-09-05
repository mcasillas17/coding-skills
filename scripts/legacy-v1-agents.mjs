// Frozen v1 bytes, used ONLY to recover hash-verified installed snapshots before
// upgrading them. New source/config/runtime inputs must always pass v2 validation.
import { isSafeRelativePath } from "../skills/knights-of-the-round-table/scripts/validate-config.mjs";
const descriptions = {
  architecture: "Reviews boundaries, coupling, consistency, maintainability, and migration impact.",
  correctness: "Reviews requirements, logic, edge cases, regressions, and error paths.",
  documentation: "Reviews impacted setup, examples, API documentation, diagrams, and screenshots.",
  performance: "Reviews repeated I/O, algorithmic cost, memory, queries, network use, and caching.",
  security: "Reviews exploitable trust-boundary, authorization, injection, secret, and dependency risks.",
  tests: "Reviews behavioral coverage, false-positive tests, and untested failure paths.",
};
const harnesses = ["claude", "copilot", "codex", "gemini"];
const extensions = { claude: ".md", copilot: ".agent.md", codex: ".toml", gemini: ".md" };
const mapping = value => value !== null && typeof value === "object" && !Array.isArray(value);
function check(value, message) { if (!value) throw new Error(`Invalid installed v1 snapshot: ${message}`); }
function keys(value, allowed) {
  check(mapping(value), "expected mapping");
  check(Object.keys(value).every(key => allowed.includes(key)), "unknown key");
}
export function assertLegacyV1Config(config) {
  keys(config, ["version", "maxReviewRounds", "reviewerRetryCount", "documentationPolicy", "taskSources", "reviewers"]);
  check(config.version === 1 && Number.isInteger(config.maxReviewRounds) && config.maxReviewRounds > 0 &&
    config.maxReviewRounds <= 10 && config.reviewerRetryCount === 1 && config.documentationPolicy === "impact-based", "invalid v1 policy");
  check(Array.isArray(config.taskSources) && new Set(config.taskSources).size === config.taskSources.length &&
    config.taskSources.every(source => ["inline-prompt", "local-file"].includes(source)), "invalid task sources");
  check(Array.isArray(config.reviewers) && config.reviewers.length > 0, "missing reviewers");
  const roles = new Map(), agents = Object.fromEntries(harnesses.map(h => [h, new Set()]));
  for (const reviewer of config.reviewers) {
    keys(reviewer, ["role", "prompt", "fallbackRole", "harnesses"]);
    check(typeof reviewer.role === "string" && /^[a-z]+(?:-[a-z]+)*$/.test(reviewer.role) && !roles.has(reviewer.role), "invalid/duplicate role");
    check(isSafeRelativePath(reviewer.prompt), "unsafe prompt");
    check(reviewer.fallbackRole === null || typeof reviewer.fallbackRole === "string", "invalid fallback");
    keys(reviewer.harnesses, harnesses);
    for (const harness of harnesses) {
      const name = reviewer.harnesses[harness];
      check(isSafeRelativePath(name) && !name.includes("/") && !agents[harness].has(name), "unsafe/duplicate agent name");
      agents[harness].add(name);
    }
    roles.set(reviewer.role, reviewer);
  }
  for (const role of roles.keys()) {
    const visited = new Set();
    let current = role;
    while (current !== null) {
      check(roles.has(current) && !visited.has(current), "missing/cyclic fallback");
      visited.add(current);
      current = roles.get(current).fallbackRole;
    }
  }
}
export function renderLegacyV1Agents(config, readVerifiedPrompt) {
  assertLegacyV1Config(config);
  const rendered = Object.fromEntries(harnesses.map(h => [h, {}]));
  for (const reviewer of config.reviewers) {
    const prompt = readVerifiedPrompt(reviewer.prompt).replace(/\r\n/g, "\n").trimEnd();
    const description = descriptions[reviewer.role] ?? `Reviews changes from the ${reviewer.role} perspective.`;
    for (const harness of harnesses) {
      const name = reviewer.harnesses[harness], quote = JSON.stringify;
      const header = `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n`;
      const body = {
        claude: `${header}tools: Read, Grep, Glob\nmodel: inherit\n---\n\n${prompt}\n`,
        copilot: `${header}tools: [read, search]\nuser-invocable: false\n---\n\n${prompt}\n`,
        codex: `name = ${quote(name)}\ndescription = ${quote(description)}\nsandbox_mode = "read-only"\ndeveloper_instructions = ${quote(prompt)}\n`,
        gemini: `${header}tools:\n  - read_file\n  - grep_search\n  - glob\n  - list_directory\nmodel: inherit\n---\n\n${prompt}\n`,
      };
      rendered[harness][`${name}${extensions[harness]}`] = body[harness];
    }
  }
  return rendered;
}
