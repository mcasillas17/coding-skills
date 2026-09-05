import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";

import { validateConfig } from "../scripts/validate.mjs";

const configPath = new URL(
  "../skills/knights-of-the-round-table/config/reviewers.yaml",
  import.meta.url,
);

const harnesses = {
  claude: "reviewer",
  copilot: "reviewer",
  codex: "reviewer",
  gemini: "reviewer",
};

function validConfig(overrides = {}) {
  return {
    version: 1,
    maxReviewRounds: 10,
    reviewerRetryCount: 1,
    documentationPolicy: "impact-based",
    taskSources: ["inline-prompt", "local-file"],
    reviewers: [
      {
        role: "correctness",
        prompt: "reviewers/correctness.md",
        fallbackRole: null,
        harnesses,
      },
      {
        role: "tests",
        prompt: "reviewers/tests.md",
        fallbackRole: "correctness",
        harnesses,
      },
    ],
    ...overrides,
  };
}

test("default configuration enables the approved acyclic reviewer roles", () => {
  const config = YAML.parse(readFileSync(configPath, "utf8"));

  assert.deepEqual(
    config.reviewers.map(({ role }) => role),
    [
      "correctness",
      "tests",
      "security",
      "documentation",
      "architecture",
      "performance",
    ],
  );
  assert.equal(config.maxReviewRounds, 10);
  assert.deepEqual(
    Object.fromEntries(
      config.reviewers.map(({ role, fallbackRole }) => [role, fallbackRole]),
    ),
    {
      correctness: null,
      tests: "correctness",
      security: "correctness",
      documentation: "correctness",
      architecture: "correctness",
      performance: "architecture",
    },
  );
  assert.deepEqual(validateConfig(config), []);
});

test("configuration allows null only as an explicit terminal fallback", () => {
  assert.deepEqual(validateConfig(validConfig()), []);

  const missingFallback = validConfig();
  delete missingFallback.reviewers[0].fallbackRole;
  assert.ok(
    validateConfig(missingFallback).some((error) =>
      error.includes("fallbackRole must be a reviewer role or null"),
    ),
  );

  const invalidFallback = validConfig();
  invalidFallback.reviewers[0].fallbackRole = "";
  assert.ok(
    validateConfig(invalidFallback).some((error) =>
      error.includes("fallbackRole must be a reviewer role or null"),
    ),
  );
});

test("configuration rejects duplicate roles and every fallback cycle", () => {
  const duplicateErrors = validateConfig(
    validConfig({
      reviewers: [
        {
          role: "tests",
          prompt: "reviewers/tests.md",
          fallbackRole: null,
          harnesses,
        },
        {
          role: "tests",
          prompt: "reviewers/tests.md",
          fallbackRole: "tests",
          harnesses,
        },
      ],
    }),
  );
  assert.ok(
    duplicateErrors.some((error) => error.includes("duplicate reviewer role")),
  );
  assert.ok(
    duplicateErrors.some((error) =>
      error.includes("fallback cycle starting at tests"),
    ),
  );

  const multiRoleCycleErrors = validateConfig(
    validConfig({
      reviewers: [
        {
          role: "correctness",
          prompt: "reviewers/correctness.md",
          fallbackRole: "architecture",
          harnesses,
        },
        {
          role: "architecture",
          prompt: "reviewers/architecture.md",
          fallbackRole: "performance",
          harnesses,
        },
        {
          role: "performance",
          prompt: "reviewers/performance.md",
          fallbackRole: "correctness",
          harnesses,
        },
      ],
    }),
  );
  assert.ok(
    multiRoleCycleErrors.some((error) =>
      error.includes("fallback cycle starting at correctness"),
    ),
  );
});

test("configuration rejects unknown and malformed values", () => {
  const errors = validateConfig({
    ...validConfig(),
    extra: true,
    version: 2,
    maxReviewRounds: 0,
    reviewerRetryCount: -1,
    documentationPolicy: "always",
    taskSources: ["inline-prompt", "remote-url"],
    reviewers: [
      {
        role: "Bad Role",
        prompt: "../outside.md",
        fallbackRole: "missing",
        harnesses: {
          claude: "",
          copilot: "reviewer",
          codex: "reviewer",
          unexpected: "reviewer",
        },
        extra: true,
      },
    ],
  });

  for (const expected of [
    "unknown top-level key: extra",
    "version must be 1",
    "maxReviewRounds must be a positive integer",
    "reviewerRetryCount must be a non-negative integer",
    "documentationPolicy must be impact-based",
    "unsupported task source: remote-url",
    "unknown reviewer key: extra",
    "role must be lowercase hyphenated",
    "prompt must be a safe relative path",
    "fallback role does not exist: missing",
    "harness claude must map to a non-empty agent",
    "missing harness mapping: gemini",
    "unknown harness mapping: unexpected",
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      `expected error containing "${expected}", received:\n${errors.join("\n")}`,
    );
  }
});

test("validator CLI reports the successful reviewer and harness counts", () => {
  const result = spawnSync(process.execPath, ["scripts/validate.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    "Validated 6 reviewer roles across 4 harnesses.",
  );
  assert.equal(result.stderr, "");
});
