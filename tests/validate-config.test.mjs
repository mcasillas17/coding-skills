import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

import { validateConfig } from "../scripts/validate.mjs";

const configPath = new URL(
  "../skills/knights-of-the-round-table/config/reviewers.yaml",
  import.meta.url,
);

function harnessNames(name) {
  return {
    claude: name,
    copilot: name,
    codex: name,
    gemini: name,
  };
}

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
        harnesses: harnessNames("correctness-reviewer"),
      },
      {
        role: "tests",
        prompt: "reviewers/tests.md",
        fallbackRole: "correctness",
        harnesses: harnessNames("tests-reviewer"),
      },
    ],
    ...overrides,
  };
}

function runValidatorWithConfig(contents) {
  const directory = mkdtempSync(join(tmpdir(), "reviewer-config-"));
  const temporaryConfigPath = join(directory, "reviewers.yaml");
  writeFileSync(temporaryConfigPath, contents);

  try {
    return spawnSync(
      process.execPath,
      ["scripts/validate.mjs", temporaryConfigPath],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("default configuration enables the approved acyclic reviewer roles", () => {
  const config = YAML.parse(readFileSync(configPath, "utf8"));

  assert.equal(config.reviewerRetryCount, 1);
  assert.deepEqual(config.taskSources, ["inline-prompt", "local-file"]);
  assert.deepEqual(
    config.reviewers.map(({ role, prompt, harnesses: roleHarnesses }) => ({
      role,
      prompt,
      harnesses: roleHarnesses,
    })),
    [
      {
        role: "correctness",
        prompt: "reviewers/correctness.md",
        harnesses: {
          claude: "correctness-reviewer",
          copilot: "correctness-reviewer",
          codex: "correctness-reviewer",
          gemini: "correctness-reviewer",
        },
      },
      {
        role: "tests",
        prompt: "reviewers/tests.md",
        harnesses: {
          claude: "tests-reviewer",
          copilot: "tests-reviewer",
          codex: "tests-reviewer",
          gemini: "tests-reviewer",
        },
      },
      {
        role: "security",
        prompt: "reviewers/security.md",
        harnesses: {
          claude: "security-reviewer",
          copilot: "security-reviewer",
          codex: "security-reviewer",
          gemini: "security-reviewer",
        },
      },
      {
        role: "documentation",
        prompt: "reviewers/documentation.md",
        harnesses: {
          claude: "documentation-reviewer",
          copilot: "documentation-reviewer",
          codex: "documentation-reviewer",
          gemini: "documentation-reviewer",
        },
      },
      {
        role: "architecture",
        prompt: "reviewers/architecture.md",
        harnesses: {
          claude: "architecture-reviewer",
          copilot: "architecture-reviewer",
          codex: "architecture-reviewer",
          gemini: "architecture-reviewer",
        },
      },
      {
        role: "performance",
        prompt: "reviewers/performance.md",
        harnesses: {
          claude: "performance-reviewer",
          copilot: "performance-reviewer",
          codex: "performance-reviewer",
          gemini: "performance-reviewer",
        },
      },
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
          harnesses: harnessNames("tests-reviewer"),
        },
        {
          role: "tests",
          prompt: "reviewers/tests.md",
          fallbackRole: "tests",
          harnesses: harnessNames("duplicate-tests-reviewer"),
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
          harnesses: harnessNames("correctness-reviewer"),
        },
        {
          role: "architecture",
          prompt: "reviewers/architecture.md",
          fallbackRole: "performance",
          harnesses: harnessNames("architecture-reviewer"),
        },
        {
          role: "performance",
          prompt: "reviewers/performance.md",
          fallbackRole: "correctness",
          harnesses: harnessNames("performance-reviewer"),
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

test("configuration rejects duplicate agent names within each harness", () => {
  const config = validConfig();
  config.reviewers[1].harnesses = {
    ...config.reviewers[1].harnesses,
    claude: config.reviewers[0].harnesses.claude,
  };

  const errors = validateConfig(config);

  assert.ok(
    errors.some((error) =>
      error.includes(
        "duplicate harness agent name for claude: correctness-reviewer",
      ),
    ),
    errors.join("\n"),
  );
  assert.ok(
    !errors.some((error) =>
      error.includes("duplicate harness agent name for copilot"),
    ),
    errors.join("\n"),
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
    "reviewerRetryCount must be exactly 1",
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

test("configuration enforces the hard round cap and single retry", () => {
  const excessiveRounds = validateConfig(
    validConfig({ maxReviewRounds: 11 }),
  );
  assert.ok(
    excessiveRounds.some((error) =>
      error.includes("maxReviewRounds must be at most 10"),
    ),
    excessiveRounds.join("\n"),
  );

  for (const reviewerRetryCount of [0, 2]) {
    const errors = validateConfig(validConfig({ reviewerRetryCount }));
    assert.ok(
      errors.some((error) =>
        error.includes("reviewerRetryCount must be exactly 1"),
      ),
      errors.join("\n"),
    );
  }
});

test("validator CLI reports repository component counts by default", () => {
  const result = spawnSync(process.execPath, ["scripts/validate.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    "Validated 1 skill, 6 reviewer roles, 24 generated agents, and 5 manifests.",
  );
  assert.equal(result.stderr, "");
});

test("validator CLI runs correctly when invoked through a symlinked script path", () => {
  const directory = mkdtempSync(join(tmpdir(), "validator-symlink-"));
  const realScriptPath = fileURLToPath(
    new URL("../scripts/validate.mjs", import.meta.url),
  );
  const linkPath = join(directory, "validate-link.mjs");
  symlinkSync(realScriptPath, linkPath);

  try {
    const result = spawnSync(process.execPath, [linkPath], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      "Validated 1 skill, 6 reviewer roles, 24 generated agents, and 5 manifests.",
    );
    assert.equal(result.stderr, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("validator CLI exits 1 and reports validation failures to stderr", () => {
  const result = runValidatorWithConfig("version: 2\nreviewers: []\n");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /version must be 1/);
  assert.match(result.stderr, /reviewers must be a non-empty array/);
  assert.equal(result.stdout, "");
});

test("validator CLI exits 1 and reports YAML parse errors to stderr", () => {
  const result = runValidatorWithConfig("reviewers: [\n");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to load reviewer configuration:/);
  assert.equal(result.stdout, "");
});
