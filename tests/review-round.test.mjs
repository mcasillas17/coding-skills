import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateRound } from "../scripts/review-round.mjs";

const REQUIRED_REVIEWERS = [
  "correctness",
  "tests",
  "security",
  "documentation",
  "architecture",
  "performance",
];

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/review-rounds/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

function completed(reviewer, findings = []) {
  return { reviewer, status: "completed", findings };
}

function finding(overrides = {}) {
  return {
    id: "finding:example",
    severity: "medium",
    confidence: 5,
    file: "scripts/example.mjs",
    line: 1,
    title: "Example finding",
    evidence: "Concrete evidence",
    recommendation: "Specific actionable fix",
    status: "open",
    ...overrides,
  };
}

function baseRound(overrides = {}) {
  return {
    round: 1,
    maxRounds: 10,
    requiredReviewers: [...REQUIRED_REVIEWERS],
    results: REQUIRED_REVIEWERS.map((reviewer) => completed(reviewer)),
    ...overrides,
  };
}

function runCliWithRound(round) {
  const directory = mkdtempSync(join(tmpdir(), "review-round-"));
  const path = join(directory, "round.json");
  writeFileSync(
    path,
    typeof round === "string" ? round : JSON.stringify(round),
  );

  try {
    return spawnSync(process.execPath, ["scripts/review-round.mjs", path], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("converges only when every configured role completed with no findings", () => {
  assert.deepEqual(evaluateRound(fixture("converged")), {
    state: "converged",
    actionable: [],
    missingReviewers: [],
  });
});

test("deduplicates actionable findings by stable ID", () => {
  const result = evaluateRound(fixture("actionable"));
  assert.equal(result.state, "actionable");
  assert.deepEqual(result.missingReviewers, []);
  assert.deepEqual(
    result.actionable.map(({ id }) => id),
    ["finding:null-path"],
  );
});

test("does not claim convergence when a reviewer is missing", () => {
  const result = evaluateRound(fixture("incomplete"));
  assert.equal(result.state, "incomplete");
  assert.deepEqual(result.missingReviewers, ["performance"]);
  assert.deepEqual(
    result.actionable.map(({ id }) => id),
    ["finding:missing-timeout"],
  );
});

test("stops with unresolved findings at the configured round limit", () => {
  const result = evaluateRound(fixture("limit-reached"));
  assert.equal(result.state, "limit-reached");
  assert.deepEqual(result.missingReviewers, []);
  assert.equal(result.actionable.length, 1);
  assert.equal(result.actionable[0].id, "finding:layering-violation");
});

test("keeps a single finding when duplicate IDs carry byte-for-byte identical payloads", () => {
  const shared = finding({ id: "finding:duplicate" });
  const round = baseRound({
    results: [
      completed("correctness", [shared]),
      completed("tests", [{ ...shared }]),
      ...REQUIRED_REVIEWERS.slice(2).map((reviewer) => completed(reviewer)),
    ],
  });

  const result = evaluateRound(round);
  assert.equal(result.state, "actionable");
  assert.equal(result.actionable.length, 1);
  assert.deepEqual(result.actionable[0], shared);
});

test("rejects conflicting payloads that share a finding ID", () => {
  const round = baseRound({
    results: [
      completed("correctness", [finding({ id: "finding:conflict" })]),
      completed("tests", [
        finding({ id: "finding:conflict", severity: "critical" }),
      ]),
      ...REQUIRED_REVIEWERS.slice(2).map((reviewer) => completed(reviewer)),
    ],
  });

  assert.throws(() => evaluateRound(round), /conflicting finding payload/);
});

test("orders actionable findings and missing reviewers deterministically", () => {
  const round = baseRound({
    requiredReviewers: ["performance", "architecture", "tests", "correctness"],
    results: [
      completed("correctness", [finding({ id: "finding:zzz-last" })]),
      completed("architecture", [finding({ id: "finding:aaa-first" })]),
    ],
  });

  const result = evaluateRound(round);
  assert.equal(result.state, "incomplete");
  assert.deepEqual(
    result.actionable.map(({ id }) => id),
    ["finding:aaa-first", "finding:zzz-last"],
  );
  assert.deepEqual(result.missingReviewers, ["performance", "tests"]);
});

test("rejects a round that is not a mapping", () => {
  for (const invalid of [null, [], "round", 1, undefined]) {
    assert.throws(() => evaluateRound(invalid));
  }
});

test("rejects unknown and missing top-level keys", () => {
  const round = baseRound();
  round.extra = true;
  delete round.maxRounds;

  assert.throws(() => evaluateRound(round), (error) => {
    assert.match(error.message, /unknown top-level key: extra/);
    assert.match(error.message, /missing required key: maxRounds/);
    return true;
  });
});

test("rejects a non-positive-integer round or maxRounds", () => {
  assert.throws(
    () => evaluateRound(baseRound({ round: 0 })),
    /round must be a positive integer/,
  );
  assert.throws(
    () => evaluateRound(baseRound({ round: 1.5 })),
    /round must be a positive integer/,
  );
  assert.throws(
    () => evaluateRound(baseRound({ maxRounds: 0 })),
    /maxRounds must be a positive integer/,
  );
});

test("rejects a round number that exceeds maxRounds", () => {
  assert.throws(
    () => evaluateRound(baseRound({ round: 11, maxRounds: 10 })),
    /round must not exceed maxRounds/,
  );
});

test("rejects malformed requiredReviewers", () => {
  assert.throws(
    () => evaluateRound(baseRound({ requiredReviewers: [] })),
    /requiredReviewers must be a non-empty array/,
  );
  assert.throws(
    () => evaluateRound(baseRound({ requiredReviewers: ["   "] })),
    /requiredReviewers\[0\] must be a non-empty string/,
  );
  assert.throws(
    () =>
      evaluateRound(
        baseRound({ requiredReviewers: ["correctness", "correctness"] }),
      ),
    /duplicate required reviewer: correctness/,
  );
});

test("rejects results that are not an array", () => {
  assert.throws(
    () => evaluateRound(baseRound({ results: {} })),
    /results must be an array/,
  );
});

test("rejects a result with unknown keys or an unrecognized reviewer", () => {
  assert.throws(
    () =>
      evaluateRound(
        baseRound({
          results: [
            { ...completed("correctness"), extra: true },
            ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
              completed(reviewer),
            ),
          ],
        }),
      ),
    /results\[0\] unknown key: extra/,
  );

  assert.throws(
    () =>
      evaluateRound(
        baseRound({
          results: [
            completed("astrology"),
            ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
              completed(reviewer),
            ),
          ],
        }),
      ),
    /results\[0\]\.reviewer is not a recognized reviewer: astrology/,
  );
});

test("rejects duplicate results for the same reviewer", () => {
  assert.throws(
    () =>
      evaluateRound(
        baseRound({
          results: [
            completed("correctness"),
            completed("correctness"),
            ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
              completed(reviewer),
            ),
          ],
        }),
      ),
    /duplicate result for reviewer: correctness/,
  );
});

test("rejects an unrecognized result status", () => {
  assert.throws(
    () =>
      evaluateRound(
        baseRound({
          results: [
            { reviewer: "correctness", status: "in-progress" },
            ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
              completed(reviewer),
            ),
          ],
        }),
      ),
    /results\[0\]\.status must be one of completed, failed, skipped/,
  );
});

test("requires a findings array only for completed results", () => {
  assert.throws(
    () =>
      evaluateRound(
        baseRound({
          results: [
            { reviewer: "correctness", status: "completed" },
            ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
              completed(reviewer),
            ),
          ],
        }),
      ),
    /results\[0\]\.findings must be an array for a completed result/,
  );

  assert.throws(
    () =>
      evaluateRound(
        baseRound({
          results: [
            { reviewer: "correctness", status: "failed", findings: [] },
            ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
              completed(reviewer),
            ),
          ],
        }),
      ),
    /results\[0\]\.findings must be omitted unless status is completed/,
  );
});

test("treats non-completed reviewers as incomplete rather than completed", () => {
  const round = baseRound({
    results: [
      { reviewer: "correctness", status: "failed" },
      ...REQUIRED_REVIEWERS.slice(1).map((reviewer) => completed(reviewer)),
    ],
  });

  const result = evaluateRound(round);
  assert.equal(result.state, "incomplete");
  assert.deepEqual(result.missingReviewers, ["correctness"]);
});

test("rejects a finding that is not a mapping or carries unknown keys", () => {
  assert.throws(
    () =>
      evaluateRound(
        baseRound({
          results: [
            completed("correctness", ["not-an-object"]),
            ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
              completed(reviewer),
            ),
          ],
        }),
      ),
    /results\[0\]\.findings\[0\] must be a mapping/,
  );

  assert.throws(
    () =>
      evaluateRound(
        baseRound({
          results: [
            completed("correctness", [finding({ extra: true })]),
            ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
              completed(reviewer),
            ),
          ],
        }),
      ),
    /results\[0\]\.findings\[0\] unknown key: extra/,
  );
});

test("rejects findings with empty required string fields", () => {
  for (const field of ["id", "file", "title", "evidence", "recommendation"]) {
    assert.throws(
      () =>
        evaluateRound(
          baseRound({
            results: [
              completed("correctness", [finding({ [field]: "  " })]),
              ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
                completed(reviewer),
              ),
            ],
          }),
        ),
      new RegExp(`findings\\[0\\]\\.${field} must be a non-empty string`),
      `expected rejection for field ${field}`,
    );
  }
});

test("rejects an unrecognized finding severity", () => {
  assert.throws(
    () =>
      evaluateRound(
        baseRound({
          results: [
            completed("correctness", [finding({ severity: "urgent" })]),
            ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
              completed(reviewer),
            ),
          ],
        }),
      ),
    /findings\[0\]\.severity must be one of critical, high, medium, low/,
  );
});

test("rejects a finding confidence outside 1 through 10", () => {
  for (const confidence of [0, 11, 5.5, "8"]) {
    assert.throws(
      () =>
        evaluateRound(
          baseRound({
            results: [
              completed("correctness", [finding({ confidence })]),
              ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
                completed(reviewer),
              ),
            ],
          }),
        ),
      /findings\[0\]\.confidence must be an integer from 1 to 10/,
      `expected rejection for confidence ${confidence}`,
    );
  }
});

test("rejects a finding line that is not a positive integer", () => {
  for (const line of [0, -1, 1.5]) {
    assert.throws(
      () =>
        evaluateRound(
          baseRound({
            results: [
              completed("correctness", [finding({ line })]),
              ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
                completed(reviewer),
              ),
            ],
          }),
        ),
      /findings\[0\]\.line must be a positive integer/,
      `expected rejection for line ${line}`,
    );
  }
});

test("rejects a finding status other than open", () => {
  assert.throws(
    () =>
      evaluateRound(
        baseRound({
          results: [
            completed("correctness", [finding({ status: "accepted" })]),
            ...REQUIRED_REVIEWERS.slice(1).map((reviewer) =>
              completed(reviewer),
            ),
          ],
        }),
      ),
    /findings\[0\]\.status must be open/,
  );
});

test("CLI exits 0 and prints the evaluation for a converged round", () => {
  const result = runCliWithRound(fixture("converged"));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    state: "converged",
    actionable: [],
    missingReviewers: [],
  });
  assert.equal(result.stderr, "");
});

test("CLI exits 2 for an actionable round", () => {
  const result = runCliWithRound(fixture("actionable"));
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, "actionable");
});

test("CLI exits 3 for an incomplete round", () => {
  const result = runCliWithRound(fixture("incomplete"));
  assert.equal(result.status, 3, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, "incomplete");
});

test("CLI exits 3 for a limit-reached round", () => {
  const result = runCliWithRound(fixture("limit-reached"));
  assert.equal(result.status, 3, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, "limit-reached");
});

test("CLI exits 3 and reports malformed JSON without printing a bogus result", () => {
  const result = runCliWithRound("{ not json");
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unable to parse review round JSON/);
});

test("CLI exits 3 and reports validation errors without printing a bogus result", () => {
  const result = runCliWithRound({ ...baseRound(), round: 0 });
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /round must be a positive integer/);
});

test("CLI exits 3 when the file does not exist", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/review-round.mjs", "/no/such/file.json"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unable to read review round file/);
});

test("CLI exits 3 when the argument count is wrong", () => {
  const missingArg = spawnSync(process.execPath, ["scripts/review-round.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(missingArg.status, 3);
  assert.equal(missingArg.stdout, "");

  const extraArg = spawnSync(
    process.execPath,
    ["scripts/review-round.mjs", "a.json", "b.json"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(extraArg.status, 3);
  assert.equal(extraArg.stdout, "");
});
