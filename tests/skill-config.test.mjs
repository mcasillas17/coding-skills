import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const installedSkillRoot = fileURLToPath(
  new URL("../skills/knights-of-the-round-table/", import.meta.url),
);
const validatorPath = join(installedSkillRoot, "scripts/validate-config.mjs");
const canonicalConfigPath = join(
  installedSkillRoot,
  "config/reviewers.yaml",
);
const canonicalRoles = [
  "correctness",
  "tests",
  "security",
  "documentation",
  "architecture",
  "performance",
];

async function validatorModule() {
  return import(new URL(
    "../skills/knights-of-the-round-table/scripts/validate-config.mjs",
    import.meta.url,
  ));
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "knights-config-"));
  const skillRoot = join(directory, "installed-skill");
  const repositoryRoot = join(directory, "repository");
  mkdirSync(join(skillRoot, "config"), { recursive: true });
  mkdirSync(join(skillRoot, "reviewers"), { recursive: true });
  mkdirSync(repositoryRoot, { recursive: true });
  copyFileSync(canonicalConfigPath, join(skillRoot, "config/reviewers.yaml"));
  for (const role of canonicalRoles) {
    copyFileSync(
      join(installedSkillRoot, `reviewers/${role}.md`),
      join(skillRoot, `reviewers/${role}.md`),
    );
  }

  return {
    directory,
    skillRoot,
    repositoryRoot,
    writeOverride(value) {
      writeFileSync(
        join(repositoryRoot, ".knights-of-the-round-table.yaml"),
        typeof value === "string" ? value : YAML.stringify(value),
      );
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("installed skill ships a skill-local override validator", () => {
  assert.equal(
    existsSync(validatorPath),
    true,
    "missing skills/knights-of-the-round-table/scripts/validate-config.mjs",
  );
});

test("skill-local validator runs from a standalone installed skill copy", () => {
  const directory = mkdtempSync(join(tmpdir(), "knights-installed-skill-"));
  const copiedSkillRoot = join(directory, "knights-of-the-round-table");
  const targetRepository = join(directory, "repository");
  cpSync(installedSkillRoot, copiedSkillRoot, { recursive: true });
  mkdirSync(targetRepository);
  writeFileSync(
    join(targetRepository, ".knights-of-the-round-table.yaml"),
    "maxReviewRounds: 3\n",
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        join(copiedSkillRoot, "scripts/validate-config.mjs"),
        targetRepository,
      ],
      {
        cwd: targetRepository,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).maxReviewRounds, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("skill-local validator loads the canonical configuration without an override", async () => {
  const fixture = createFixture();
  try {
    const { loadEffectiveConfig } = await validatorModule();
    const config = loadEffectiveConfig({
      skillRoot: fixture.skillRoot,
      repositoryRoot: fixture.repositoryRoot,
    });

    assert.equal(config.maxReviewRounds, 10);
    assert.equal(config.reviewerRetryCount, 1);
    assert.deepEqual(
      config.reviewers.map(({ role }) => role),
      canonicalRoles,
    );
  } finally {
    fixture.cleanup();
  }
});

test("override merge only lowers the round cap, remaps existing harness agents, and appends extra roles", async () => {
  const fixture = createFixture();
  writeFileSync(
    join(fixture.skillRoot, "reviewers/accessibility.md"),
    "# Accessibility reviewer\n",
  );
  fixture.writeOverride({
    maxReviewRounds: 4,
    reviewers: [
      {
        role: "correctness",
        harnesses: {
          copilot: "repository-correctness-reviewer",
        },
      },
      {
        role: "accessibility",
        prompt: "reviewers/accessibility.md",
        fallbackRole: "correctness",
        harnesses: {
          claude: "accessibility-reviewer",
          copilot: "accessibility-reviewer",
          codex: "accessibility-reviewer",
          gemini: "accessibility-reviewer",
        },
      },
    ],
  });

  try {
    const { loadEffectiveConfig } = await validatorModule();
    const config = loadEffectiveConfig({
      skillRoot: fixture.skillRoot,
      repositoryRoot: fixture.repositoryRoot,
    });
    const correctness = config.reviewers.find(
      ({ role }) => role === "correctness",
    );

    assert.equal(config.maxReviewRounds, 4);
    assert.equal(config.reviewerRetryCount, 1);
    assert.equal(correctness.prompt, "reviewers/correctness.md");
    assert.equal(correctness.fallbackRole, null);
    assert.deepEqual(correctness.harnesses, {
      claude: "correctness-reviewer",
      copilot: "repository-correctness-reviewer",
      codex: "correctness-reviewer",
      gemini: "correctness-reviewer",
    });
    assert.deepEqual(
      config.reviewers.map(({ role }) => role),
      [...canonicalRoles, "accessibility"],
    );
  } finally {
    fixture.cleanup();
  }
});

test("override merge cannot replace or disable the canonical reviewer floor", async () => {
  const fixture = createFixture();
  fixture.writeOverride({
    reviewers: [
      {
        role: "tests",
        harnesses: { claude: "repository-tests-reviewer" },
      },
    ],
  });

  try {
    const { loadEffectiveConfig } = await validatorModule();
    const config = loadEffectiveConfig({
      skillRoot: fixture.skillRoot,
      repositoryRoot: fixture.repositoryRoot,
    });

    assert.deepEqual(
      config.reviewers.slice(0, canonicalRoles.length).map(({ role }) => role),
      canonicalRoles,
    );
    assert.equal(config.reviewers.length, canonicalRoles.length);
  } finally {
    fixture.cleanup();
  }
});

test("override reviewer mappings are key-order independent", async () => {
  const fixture = createFixture();
  fixture.writeOverride(`
reviewers:
  - harnesses:
      copilot: repository-correctness-reviewer
    role: correctness
`);

  try {
    const { loadEffectiveConfig } = await validatorModule();
    const config = loadEffectiveConfig({
      skillRoot: fixture.skillRoot,
      repositoryRoot: fixture.repositoryRoot,
    });
    const correctness = config.reviewers.find(
      ({ role }) => role === "correctness",
    );

    assert.equal(
      correctness.harnesses.copilot,
      "repository-correctness-reviewer",
    );
  } finally {
    fixture.cleanup();
  }
});

test("override parser rejects additional YAML document content", async () => {
  const { loadEffectiveConfig } = await validatorModule();
  for (const [override, expectedError] of [
    [
      "maxReviewRounds: 3\n...\nreviewers: []\n",
      /content after YAML document terminator/,
    ],
    [
      "maxReviewRounds: 3\n---\nreviewers: []\n",
      /multiple YAML documents are not supported/,
    ],
  ]) {
    const fixture = createFixture();
    fixture.writeOverride(override);
    try {
      assert.throws(
        () =>
          loadEffectiveConfig({
            skillRoot: fixture.skillRoot,
            repositoryRoot: fixture.repositoryRoot,
          }),
        expectedError,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("override file must be a regular file contained in the repository root", async () => {
  const fixture = createFixture();
  const outsideOverride = join(fixture.directory, "outside-override.yaml");
  writeFileSync(outsideOverride, "maxReviewRounds: 3\n");
  symlinkSync(
    outsideOverride,
    join(fixture.repositoryRoot, ".knights-of-the-round-table.yaml"),
  );

  try {
    const { loadEffectiveConfig } = await validatorModule();
    assert.throws(
      () =>
        loadEffectiveConfig({
          skillRoot: fixture.skillRoot,
          repositoryRoot: fixture.repositoryRoot,
        }),
      /repository reviewer override must resolve inside the repository root/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("dangling repository override symlinks fail closed", async () => {
  const fixture = createFixture();
  symlinkSync(
    join(fixture.directory, "missing-override.yaml"),
    join(fixture.repositoryRoot, ".knights-of-the-round-table.yaml"),
  );

  try {
    const { loadEffectiveConfig } = await validatorModule();
    assert.throws(
      () =>
        loadEffectiveConfig({
          skillRoot: fixture.skillRoot,
          repositoryRoot: fixture.repositoryRoot,
        }),
      /repository reviewer override must resolve inside the repository root/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("plain YAML harness agent names may contain quote characters", async () => {
  const fixture = createFixture();
  fixture.writeOverride(`
reviewers:
  - role: correctness
    harnesses:
      copilot: team's-reviewer
      claude: team"reviewer
`);

  try {
    const { loadEffectiveConfig } = await validatorModule();
    const config = loadEffectiveConfig({
      skillRoot: fixture.skillRoot,
      repositoryRoot: fixture.repositoryRoot,
    });
    const correctness = config.reviewers.find(
      ({ role }) => role === "correctness",
    );

    assert.equal(correctness.harnesses.copilot, "team's-reviewer");
    assert.equal(correctness.harnesses.claude, 'team"reviewer');
  } finally {
    fixture.cleanup();
  }
});

test("override schema rejects every field outside the documented allowlist", async () => {
  const disallowedOverrides = [
    [
      { reviewerRetryCount: 1 },
      /unknown override top-level key: reviewerRetryCount/,
    ],
    [
      { documentationPolicy: "impact-based" },
      /unknown override top-level key: documentationPolicy/,
    ],
    [
      {
        reviewers: [
          {
            role: "correctness",
            prompt: "reviewers/correctness.md",
          },
        ],
      },
      /canonical reviewer correctness may only override harnesses/,
    ],
    [
      {
        reviewers: [
          {
            role: "tests",
            fallbackRole: null,
          },
        ],
      },
      /canonical reviewer tests may only override harnesses/,
    ],
    [
      {
        reviewers: [
          {
            role: "security",
            disabled: true,
          },
        ],
      },
      /canonical reviewer security may only override harnesses/,
    ],
  ];
  const { loadEffectiveConfig } = await validatorModule();

  for (const [override, expectedError] of disallowedOverrides) {
    const fixture = createFixture();
    fixture.writeOverride(override);
    try {
      assert.throws(
        () =>
          loadEffectiveConfig({
            skillRoot: fixture.skillRoot,
            repositoryRoot: fixture.repositoryRoot,
          }),
        expectedError,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("override maxReviewRounds must be an explicit lower value", async () => {
  const { loadEffectiveConfig } = await validatorModule();

  for (const maxReviewRounds of [0, 10, 11]) {
    const fixture = createFixture();
    fixture.writeOverride({ maxReviewRounds });
    try {
      assert.throws(
        () =>
          loadEffectiveConfig({
            skillRoot: fixture.skillRoot,
            repositoryRoot: fixture.repositoryRoot,
          }),
        /override maxReviewRounds must be an integer from 1 through 9/,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("override limits extra roles to bound reviewer executions", async () => {
  const fixture = createFixture();
  const roleSuffixes = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliet",
    "kilo",
  ];
  for (const suffix of roleSuffixes) {
    writeFileSync(
      join(fixture.skillRoot, `reviewers/extra-${suffix}.md`),
      `# Extra ${suffix}\n`,
    );
  }
  const extraReviewers = roleSuffixes.map((suffix) => ({
    role: `extra-${suffix}`,
    prompt: `reviewers/extra-${suffix}.md`,
    fallbackRole: "correctness",
    harnesses: {
      claude: `extra-${suffix}-reviewer`,
      copilot: `extra-${suffix}-reviewer`,
      codex: `extra-${suffix}-reviewer`,
      gemini: `extra-${suffix}-reviewer`,
    },
  }));

  try {
    const { loadEffectiveConfig } = await validatorModule();
    fixture.writeOverride({ reviewers: extraReviewers.slice(0, 10) });
    const maximumConfig = loadEffectiveConfig({
      skillRoot: fixture.skillRoot,
      repositoryRoot: fixture.repositoryRoot,
    });
    assert.equal(maximumConfig.reviewers.length, 16);

    fixture.writeOverride({ reviewers: extraReviewers });
    assert.throws(
      () =>
        loadEffectiveConfig({
          skillRoot: fixture.skillRoot,
          repositoryRoot: fixture.repositoryRoot,
        }),
      /override may add at most 10 extra reviewer roles/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("canonical defaults require exactly ten rounds, one retry, and all six immutable role prompts", async () => {
  const { loadEffectiveConfig } = await validatorModule();
  const mutations = [
    [
      (config) => {
        config.maxReviewRounds = 9;
      },
      /canonical maxReviewRounds must be exactly 10/,
    ],
    [
      (config) => {
        config.reviewerRetryCount = 0;
      },
      /reviewerRetryCount must be exactly 1/,
    ],
    [
      (config) => {
        config.reviewers = config.reviewers.filter(
          ({ role }) => role !== "security",
        );
      },
      /canonical reviewer role is required: security/,
    ],
    [
      (config) => {
        config.reviewers.find(
          ({ role }) => role === "correctness",
        ).prompt = "reviewers/tests.md";
      },
      /canonical reviewer correctness prompt must remain reviewers\/correctness\.md/,
    ],
  ];

  for (const [mutate, expectedError] of mutations) {
    const fixture = createFixture();
    const config = YAML.parse(
      readFileSync(join(fixture.skillRoot, "config/reviewers.yaml"), "utf8"),
    );
    mutate(config);
    writeFileSync(
      join(fixture.skillRoot, "config/reviewers.yaml"),
      YAML.stringify(config),
    );
    try {
      assert.throws(
        () =>
          loadEffectiveConfig({
            skillRoot: fixture.skillRoot,
            repositoryRoot: fixture.repositoryRoot,
          }),
        expectedError,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("extra reviewer prompts must exist and resolve inside the installed skill", async () => {
  const { loadEffectiveConfig } = await validatorModule();
  const fixture = createFixture();
  const outsidePrompt = join(fixture.directory, "outside.md");
  writeFileSync(outsidePrompt, "# Outside\n");
  symlinkSync(outsidePrompt, join(fixture.skillRoot, "reviewers/escape.md"));
  fixture.writeOverride({
    reviewers: [
      {
        role: "accessibility",
        prompt: "reviewers/escape.md",
        fallbackRole: "correctness",
        harnesses: {
          claude: "accessibility-reviewer",
          copilot: "accessibility-reviewer",
          codex: "accessibility-reviewer",
          gemini: "accessibility-reviewer",
        },
      },
    ],
  });

  try {
    assert.throws(
      () =>
        loadEffectiveConfig({
          skillRoot: fixture.skillRoot,
          repositoryRoot: fixture.repositoryRoot,
        }),
      /reviewer accessibility prompt must resolve inside the installed skill/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("skill-local validator CLI emits the effective configuration and fails closed on invalid overrides", () => {
  const repository = mkdtempSync(join(tmpdir(), "knights-config-cli-"));
  const overridePath = join(
    repository,
    ".knights-of-the-round-table.yaml",
  );

  try {
    writeFileSync(overridePath, "maxReviewRounds: 3\n");
    const success = spawnSync(process.execPath, [validatorPath, repository], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).maxReviewRounds, 3);
    assert.equal(success.stderr, "");

    writeFileSync(overridePath, "reviewerRetryCount: 0\n");
    const failure = spawnSync(process.execPath, [validatorPath, repository], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, "");
    assert.match(
      failure.stderr,
      /unknown override top-level key: reviewerRetryCount/,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("source validator reuses the installed skill validation implementation", async () => {
  const rootValidator = await import("../scripts/validate.mjs");
  const skillValidator = await validatorModule();

  assert.strictEqual(rootValidator.validateConfig, skillValidator.validateConfig);
  assert.strictEqual(
    rootValidator.assertValidConfig,
    skillValidator.assertValidConfig,
  );
  assert.strictEqual(
    rootValidator.isSafeRelativePath,
    skillValidator.isSafeRelativePath,
  );

  const rootSource = readFileSync(
    join(repositoryRoot, "scripts/validate.mjs"),
    "utf8",
  );
  assert.match(
    rootSource,
    /skills\/knights-of-the-round-table\/scripts\/validate-config\.mjs/,
  );
});
