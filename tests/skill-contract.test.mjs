import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

import { parseFrontmatter } from "./frontmatter.mjs";

const repositoryRoot = new URL("..", import.meta.url);
const skillRoot = new URL(
  "../skills/knights-of-the-round-table/",
  import.meta.url,
);

const SKILL_PATH = new URL("SKILL.md", skillRoot);
const REFERENCES = {
  reviewLoop: new URL("references/review-loop.md", skillRoot),
  reviewerContract: new URL("references/reviewer-contract.md", skillRoot),
  documentationAndPr: new URL("references/documentation-and-pr.md", skillRoot),
  harnessAdapters: new URL("references/harness-adapters.md", skillRoot),
};
const PR_TEMPLATE_PATH = new URL("assets/pr-body-template.md", skillRoot);
const SKILL_EVALUATOR_PATH = new URL("scripts/review-round.mjs", skillRoot);
const CONFIG_PATH = new URL(
  "../skills/knights-of-the-round-table/config/reviewers.yaml",
  import.meta.url,
);

const PLACEHOLDER_PATTERN = /\b(?:TBD|TODO|FIXME|XXX)\b/;

// Banned "workflow summary" verbs/phrases for the frontmatter description.
// These describe *how* the skill works (process/sequence), which the
// writing-skills CSO guidance says causes agents to skip the full body.
const WORKFLOW_SUMMARY_PATTERNS = [
  /\bretr(?:y|ies|ied)\b/i,
  /\bfallback\b/i,
  /\btriage/i,
  /\bconverg/i,
  /\brerun/i,
  /\brepeat(?:s|ing|ed)?\b/i,
  /ten[- ]round/i,
  /round\s*10\b/i,
  /\bcommit(?:s|ted|ting)?\b/i,
  /\bpush(?:es|ed|ing)?\b/i,
  /\bforce\b/i,
  /\bopens?\s+a\s+pull\s+request\b/i,
];

function readText(url) {
  return readFileSync(url, "utf8");
}

function exists(url) {
  return existsSync(url);
}

function section(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  assert.notEqual(start, -1, `missing section: ${marker}`);
  const contentStart = start + marker.length;
  const nextHeading = markdown.indexOf("\n## ", contentStart);
  return markdown.slice(
    contentStart,
    nextHeading === -1 ? markdown.length : nextHeading,
  );
}

let skillText;
let frontmatter;

test("SKILL.md exists and has valid Agent Skills frontmatter", () => {
  assert.equal(exists(SKILL_PATH), true, "SKILL.md must exist");
  skillText = readText(SKILL_PATH);
  frontmatter = parseFrontmatter(skillText, "SKILL.md");
  assert.equal(typeof frontmatter.name, "string");
  assert.equal(typeof frontmatter.description, "string");
});

test("frontmatter name is the canonical skill name", () => {
  skillText = readText(SKILL_PATH);
  frontmatter = parseFrontmatter(skillText, "SKILL.md");
  assert.equal(frontmatter.name, "knights-of-the-round-table");
  assert.match(frontmatter.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test("description starts with 'Use when' and states only triggering conditions", () => {
  skillText = readText(SKILL_PATH);
  frontmatter = parseFrontmatter(skillText, "SKILL.md");
  const { description } = frontmatter;
  const [positiveTriggers] = description.split("NOT for");

  assert.match(description, /^Use when/);
  assert.ok(
    description.length <= 500,
    `description should stay under 500 characters, got ${description.length}`,
  );
  assert.match(positiveTriggers, /implementation/i);
  assert.match(positiveTriggers, /pull-request delivery/i);
  assert.doesNotMatch(
    positiveTriggers,
    /\bor when\b/i,
    "positive triggers must not contradict the review-only exclusion",
  );

  for (const pattern of WORKFLOW_SUMMARY_PATTERNS) {
    assert.doesNotMatch(
      description,
      pattern,
      `description must not summarize workflow steps (matched ${pattern})`,
    );
  }
});

test("description declares explicit negative triggers", () => {
  skillText = readText(SKILL_PATH);
  frontmatter = parseFrontmatter(skillText, "SKILL.md");
  const { description } = frontmatter;

  assert.match(description, /NOT for/);
  // At least two distinct exclusions must be present.
  assert.match(description, /review-only/i);
  assert.match(description, /multiple repositories/i);
});

test("SKILL.md declares required metadata fields", () => {
  skillText = readText(SKILL_PATH);
  frontmatter = parseFrontmatter(skillText, "SKILL.md");
  assert.equal(frontmatter.license, "MIT");
  assert.equal(typeof frontmatter.compatibility, "string");
  assert.ok(frontmatter.compatibility.length > 0);
});

test("SKILL.md contains every required main section heading", () => {
  skillText = readText(SKILL_PATH);
  for (const heading of [
    "## Overview",
    "## Preconditions",
    "## Resolve task",
    "## Implement",
    "## Review and repair loop",
    "## Documentation",
    "## Publish",
    "## Failure conditions",
    "## Completion report",
    "## Quick reference",
    "## Common mistakes / red flags",
  ]) {
    assert.match(
      skillText,
      new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
      `missing heading: ${heading}`,
    );
  }
  assert.match(skillText, /\*\*Core principle:\*\*/);
});

test("SKILL.md stays under 500 lines", () => {
  skillText = readText(SKILL_PATH);
  const lineCount = skillText.split("\n").length;
  assert.ok(lineCount < 500, `SKILL.md has ${lineCount} lines`);
});

test("SKILL.md and all referenced files contain no placeholder markers", () => {
  skillText = readText(SKILL_PATH);
  assert.doesNotMatch(skillText, PLACEHOLDER_PATTERN);
  for (const url of Object.values(REFERENCES)) {
    assert.doesNotMatch(readText(url), PLACEHOLDER_PATTERN, url.pathname);
  }
  assert.doesNotMatch(readText(PR_TEMPLATE_PATH), PLACEHOLDER_PATTERN);
});

test("every reference and asset file required by the skill exists", () => {
  for (const url of Object.values(REFERENCES)) {
    assert.equal(exists(url), true, `missing reference: ${url.pathname}`);
  }
  assert.equal(exists(PR_TEMPLATE_PATH), true, "missing PR body template");
  assert.equal(
    exists(SKILL_EVALUATOR_PATH),
    true,
    "missing installed-skill evaluator",
  );
});

test("SKILL.md links to every reference and the PR body template", () => {
  skillText = readText(SKILL_PATH);
  assert.match(skillText, /references\/review-loop\.md/);
  assert.match(skillText, /references\/reviewer-contract\.md/);
  assert.match(skillText, /references\/documentation-and-pr\.md/);
  assert.match(skillText, /references\/harness-adapters\.md/);
  assert.match(skillText, /assets\/pr-body-template\.md/);
});

test("default repository resolution uses the current working directory's Git root", () => {
  skillText = readText(SKILL_PATH);
  const preconditions = section(skillText, "Preconditions");
  assert.match(preconditions, /git rev-parse --show-toplevel/);
  assert.match(preconditions, /current working directory/i);
});

test("task source is restricted to inline prompt or a readable local file", () => {
  skillText = readText(SKILL_PATH);
  const preconditions = section(skillText, "Preconditions");
  assert.match(preconditions, /inline prompt/i);
  assert.match(preconditions, /local (?:task )?file/i);
  assert.match(preconditions, /do not fetch (?:the )?task/i);
  assert.match(preconditions, /\bURL\b/);
});

test("SKILL.md requires reading repository instructions and isolating unrelated changes", () => {
  skillText = readText(SKILL_PATH);
  const preconditions = section(skillText, "Preconditions");
  assert.match(preconditions, /repository instruction/i);
  assert.match(preconditions, /unrelated (?:in-progress )?changes/i);
  assert.match(preconditions, /isolat/i);
  assert.match(preconditions, /dedicated non-default\s+(?:task|feature) branch/i);
});

test("SKILL.md loads the canonical config and an optional repo-root override", () => {
  skillText = readText(SKILL_PATH);
  const preconditions = section(skillText, "Preconditions");
  assert.match(preconditions, /installed skill directory/i);
  assert.match(preconditions, /config\/reviewers\.yaml/);
  assert.match(preconditions, /\.knights-of-the-round-table\.yaml/);
  assert.match(preconditions, /optional/i);
  assert.match(preconditions, /repo(?:sitory)?-root/i);
});

test("repository overrides cannot weaken the hard retry, round, or publication gates", () => {
  skillText = readText(SKILL_PATH);
  const preconditions = section(skillText, "Preconditions");
  assert.match(preconditions, /override[^.]*must not[^.]*hard gate/is);
  assert.match(preconditions, /reviewerRetryCount[^.]*1/is);
  assert.match(preconditions, /maxReviewRounds[^.]*10/is);
  assert.match(preconditions, /publication gate/i);
  assert.match(preconditions, /must not remove[^.]*six canonical\s+roles/is);
  assert.match(preconditions, /after schema validation[^.]*orchestrator[^.]*enforces/is);
});

test("SKILL.md requires selecting the current harness and checking capabilities", () => {
  skillText = readText(SKILL_PATH);
  const preconditions = section(skillText, "Preconditions");
  assert.match(preconditions, /current harness/i);
  assert.match(preconditions, /capabilit/i);
  assert.match(preconditions, /references\/harness-adapters\.md/);
  assert.match(preconditions, /reviewer[^.]*capability[^.]*fallback/is);
  assert.match(
    preconditions,
    /validation, Git, or pull request capability[^.]*stop/is,
  );
});

test("SKILL.md names all six default reviewer roles", () => {
  skillText = readText(SKILL_PATH);
  const reviewLoop = section(skillText, "Review and repair loop");
  const quickReference = section(skillText, "Quick reference");
  for (const role of [
    "correctness",
    "tests",
    "security",
    "documentation",
    "architecture",
    "performance",
  ]) {
    assert.match(reviewLoop, new RegExp(`\\b${role}\\b`, "i"));
    assert.match(quickReference, new RegExp(`\\b${role}\\b`, "i"));
  }
});

test("SKILL.md matches the six roles actually configured in reviewers.yaml", () => {
  skillText = readText(SKILL_PATH);
  const config = YAML.parse(readText(CONFIG_PATH));
  const configuredRoles = config.reviewers.map((reviewer) => reviewer.role).sort();
  assert.deepEqual(configuredRoles, [
    "architecture",
    "correctness",
    "documentation",
    "performance",
    "security",
    "tests",
  ]);
  const reviewLoop = section(skillText, "Review and repair loop");
  for (const role of configuredRoles) {
    assert.match(reviewLoop, new RegExp(`\\*\\*${role}\\*\\*`));
  }
});

test("SKILL.md requires reviewers to run independently and read-only", () => {
  skillText = readText(SKILL_PATH);
  const reviewLoop = section(skillText, "Review and repair loop");
  assert.match(reviewLoop, /independent/i);
  assert.match(reviewLoop, /read-only/i);
});

test("SKILL.md requires the structured reviewer contract and scripts/review-round.mjs", () => {
  skillText = readText(SKILL_PATH);
  const reviewLoop = section(skillText, "Review and repair loop");
  assert.match(reviewLoop, /references\/reviewer-contract\.md/);
  assert.match(reviewLoop, /scripts\/review-round\.mjs/);
});

test("SKILL.md supplies every reviewer with the complete review context", () => {
  skillText = readText(SKILL_PATH);
  const reviewLoop = section(skillText, "Review and repair loop");
  for (const requiredContext of [
    /normalized task/i,
    /acceptance criteria/i,
    /repository instructions/i,
    /current diff/i,
    /relevant files/i,
    /validation\s+output/i,
    /prior-round findings/i,
    /dispositions/i,
  ]) {
    assert.match(reviewLoop, requiredContext);
  }
});

test("SKILL.md requires exactly one retry then one configured fallback attempt then stop", () => {
  skillText = readText(SKILL_PATH);
  const reviewLoop = section(skillText, "Review and repair loop");
  assert.match(reviewLoop, /retry[^.]*once/i);
  assert.match(reviewLoop, /one configured fallback attempt/i);
  assert.match(reviewLoop, /then stop/i);
  assert.doesNotMatch(
    reviewLoop,
    /fallback agent[^.]*fallback role/is,
    "the workflow must not try multiple fallback layers",
  );
});

test("fallback preserves the missing required role and effective coverage", () => {
  skillText = readText(SKILL_PATH);
  const reviewLoop = section(skillText, "Review and repair loop");
  assert.match(reviewLoop, /every role in the effective configuration/i);
  assert.match(reviewLoop, /fallback changes the executor, not the required role/i);
  assert.match(reviewLoop, /original role/i);
  assert.doesNotMatch(
    skillText,
    /(?:all six configured reviewer roles|with all six roles)/i,
    "the canonical six are defaults; a validated override defines the effective set",
  );
});

test("SKILL.md forbids silently reducing reviewer coverage", () => {
  skillText = readText(SKILL_PATH);
  assert.match(
    section(skillText, "Review and repair loop"),
    /never silently (?:reduce|downgrade)/i,
  );
});

test("SKILL.md requires a full new review round after every accepted fix", () => {
  skillText = readText(SKILL_PATH);
  const reviewLoop = section(skillText, "Review and repair loop");
  assert.match(reviewLoop, /accepted finding/i);
  assert.match(reviewLoop, /rerun[^.]*validation/i);
  assert.match(reviewLoop, /full[^.]*review round/i);
});

test("SKILL.md requires evidence or a reason for every rejected finding", () => {
  skillText = readText(SKILL_PATH);
  const reviewLoop = section(skillText, "Review and repair loop");
  assert.match(reviewLoop, /rejected finding/i);
  assert.match(reviewLoop, /(?:evidence|reason)/i);
});

test("SKILL.md blocks the run when round 10 still has actionable findings", () => {
  skillText = readText(SKILL_PATH);
  const reviewLoop = section(skillText, "Review and repair loop");
  const failures = section(skillText, "Failure conditions");
  const quickReference = section(skillText, "Quick reference");
  assert.match(reviewLoop, /maximum of 10 review rounds/i);
  assert.match(reviewLoop, /effective `maxReviewRounds`/i);
  assert.match(reviewLoop, /blocked/i);
  assert.match(failures, /effective `maxReviewRounds`[^.]*at most 10/is);
  assert.match(quickReference, /effective `maxReviewRounds`[^|]*maximum of 10/i);
});

test("SKILL.md states that time pressure never waives a gate", () => {
  skillText = readText(SKILL_PATH);
  const reviewLoop = section(skillText, "Review and repair loop");
  assert.match(reviewLoop, /time pressure/i);
  assert.match(reviewLoop, /never/i);
});

test("SKILL.md states that reaching a round number never authorizes publication", () => {
  skillText = readText(SKILL_PATH);
  const reviewLoop = section(skillText, "Review and repair loop");
  assert.match(reviewLoop, /round count/i);
  assert.match(reviewLoop, /never[^.]*authorize/i);
});

test("SKILL.md forbids opening any pull request, including a draft, without full clean coverage", () => {
  skillText = readText(SKILL_PATH);
  const publish = section(skillText, "Publish");
  assert.match(publish, /draft pull request/i);
  assert.match(publish, /every required review/i);
  assert.match(publish, /no actionable findings remain/i);
});

test("SKILL.md makes impact-based documentation mandatory when affected", () => {
  skillText = readText(SKILL_PATH);
  const documentation = section(skillText, "Documentation");
  assert.match(documentation, /impact-based/i);
  assert.match(documentation, /mandatory/i);
  assert.match(
    documentation,
    /code or documentation change after a clean round invalidates convergence/i,
  );
  assert.match(
    documentation,
    /full configured review round\s+with every role in the effective configuration/i,
  );
  assert.doesNotMatch(skillText, /Only then does it update impacted documentation/i);
});

test("SKILL.md authorizes normal commit, push, and PR but never force", () => {
  skillText = readText(SKILL_PATH);
  const publish = section(skillText, "Publish");
  assert.match(publish, /automatically open/i);
  assert.match(publish, /never force/i);
});

test("SKILL.md requires separate consent for sensitive, destructive, or production actions", () => {
  skillText = readText(SKILL_PATH);
  const publish = section(skillText, "Publish");
  assert.match(publish, /destructive/i);
  assert.match(publish, /production/i);
  assert.match(publish, /consent/i);
});

test("SKILL.md fails closed when a dedicated task branch cannot be established", () => {
  skillText = readText(SKILL_PATH);
  const failures = section(skillText, "Failure conditions");
  assert.match(
    failures,
    /dedicated non-default (?:task|feature) branch cannot be (?:created|selected)/i,
  );
  assert.match(failures, /conflicting repository instructions/i);
  assert.match(failures, /override[^.]*schema validation[^.]*hard gate/is);
  assert.match(failures, /recovery step/i);
});

test("SKILL.md completion report records fallback execution provenance", () => {
  skillText = readText(SKILL_PATH);
  const completionReport = section(skillText, "Completion report");
  assert.match(completionReport, /roles executed via fallback/i);
  assert.match(completionReport, /executing (?:agent|reviewer)/i);
});

// --- references/review-loop.md ---

test("review-loop.md documents the round state machine using the evaluator's exact states", () => {
  const text = readText(REFERENCES.reviewLoop);
  for (const state of ["converged", "actionable", "incomplete", "limit-reached"]) {
    assert.match(text, new RegExp(`\`${state}\``));
  }
});

test("review-loop.md documents the retry/fallback/stop sequence", () => {
  const text = readText(REFERENCES.reviewLoop);
  assert.match(text, /retry[^.]*once/i);
  assert.match(text, /one configured fallback attempt/i);
  assert.match(text, /then stop/i);
  assert.doesNotMatch(
    text,
    /fallback agent[^.]*fallback role/is,
    "the loop must not try multiple fallback layers",
  );
  assert.match(text, /fallback changes the executor, not the required role/i);
});

test("review-loop.md documents finding deduplication by reportedBy", () => {
  const text = readText(REFERENCES.reviewLoop);
  assert.match(text, /reportedBy/);
  assert.match(text, /duplicate/i);
  assert.match(text, /highest severity/i);
  assert.match(text, /highest confidence/i);
  assert.match(text, /lexic/i);
  assert.match(text, /unique within[^.]*reviewer/i);
});

test("review-loop.md separates raw finding status from orchestration dispositions", () => {
  const text = readText(REFERENCES.reviewLoop);
  assert.match(text, /`open`/);
  for (const disposition of ["accepted", "fixed", "rejected", "duplicate"]) {
    assert.match(text, new RegExp(`\`${disposition}\``));
  }
});

test("review-loop.md requires a full round after every accepted fix", () => {
  const text = readText(REFERENCES.reviewLoop);
  assert.match(text, /every accepted (?:finding|fix)/i);
  assert.match(text, /full[^.]*round/i);
  assert.match(text, /affected[^.]*validation/i);
});

test("review-loop.md documents the hard ten-round failure path", () => {
  const text = readText(REFERENCES.reviewLoop);
  assert.match(text, /`limit-reached`/);
  assert.match(text, /maximum of 10 review rounds/i);
  assert.match(text, /effective `maxReviewRounds`/i);
  assert.match(text, /round >= maxRounds[^|]*effective limit/i);
  assert.match(text, /blocked/i);
});

// --- references/reviewer-contract.md ---

test("reviewer-contract.md distinguishes raw reviewer output from evaluator envelopes", () => {
  const text = readText(REFERENCES.reviewerContract);
  const reviewerPrompt = readText(
    new URL(
      "../skills/knights-of-the-round-table/reviewers/correctness.md",
      import.meta.url,
    ),
  );

  assert.match(text, /raw reviewer payload/i);
  assert.match(text, /adapter[^.]*adds[^.]*status/is);
  assert.match(text, /result envelope/i);
  assert.match(text, /preserves?[^.]*findings/is);
  assert.match(text, /fallback[^.]*raw `reviewer`[^.]*discard/is);
  assert.match(text, /executor identity[^.]*`fallbackRole`[^.]*harness/i);
  assert.match(text, /envelope[^.]*`reviewer`[^.]*original\s+required role/is);
  assert.doesNotMatch(reviewerPrompt, /"status"\s*:\s*"completed"/);
  assert.match(reviewerPrompt, /"status"\s*:\s*"open"/);
});

test("reviewer-contract.md defines the exact finding schema fields in order", () => {
  const text = readText(REFERENCES.reviewerContract);
  for (const field of [
    "id",
    "severity",
    "confidence",
    "file",
    "line",
    "title",
    "evidence",
    "recommendation",
    "status",
  ]) {
    assert.match(text, new RegExp(`\`${field}\``), `missing field: ${field}`);
  }
  assert.doesNotMatch(text, /fields and order\s+validated/i);
  assert.match(text, /canonical output order/i);
});

test("reviewer-contract.md defines severity, confidence, and raw status exactly", () => {
  const text = readText(REFERENCES.reviewerContract);
  assert.match(text, /critical\s*\|\s*high\s*\|\s*medium\s*\|\s*low/);
  assert.match(text, /1[^.]*(?:through|to|-)[^.]*10/);
  assert.match(text, /status.*`open`/is);
});

test("reviewer-contract.md defines result-level statuses matching evaluateRound", () => {
  const text = readText(REFERENCES.reviewerContract);
  for (const status of ["completed", "failed", "skipped"]) {
    assert.match(text, new RegExp(`\`${status}\``));
  }
  assert.match(text, /reportedBy/);
  assert.match(text, /failed[^.]*skipped[^.]*may omit[^.]*findings/is);
  assert.match(text, /non-completed[^.]*findings[^.]*not actionable/is);
  assert.match(text, /does not require input JSON key order/i);
});

test("reviewer-contract.md documents the evaluator round shape and CLI exit codes", () => {
  const text = readText(REFERENCES.reviewerContract);
  for (const field of ["round", "maxRounds", "requiredReviewers", "results"]) {
    assert.match(text, new RegExp(`\`${field}\``), `missing round field: ${field}`);
  }
  assert.match(text, /exit code `0`[^.]*`converged`/is);
  assert.match(text, /exit code `2`[^.]*`actionable`/is);
  assert.match(text, /exit code `3`[^.]*`incomplete`[^.]*`limit-reached`[^.]*invalid/is);
  assert.match(text, /duplicate result[^.]*hard error/i);
  assert.match(text, /unknown top-level key[^.]*hard error/i);
  assert.match(text, /reviewer[^.]*not[^.]*requiredReviewers[^.]*hard error/is);
});

test("reviewer-contract.md distinguishes raw status from orchestration dispositions", () => {
  const text = readText(REFERENCES.reviewerContract);
  assert.match(text, /raw/i);
  assert.match(text, /disposition/i);
  for (const disposition of ["accepted", "fixed", "rejected", "duplicate"]) {
    assert.match(text, new RegExp(`\`${disposition}\``));
  }
});

test("reviewer-contract.md matches the live evaluateRound implementation", async () => {
  const module = await import("../scripts/review-round.mjs");
  assert.equal(typeof module.evaluateRound, "function");

  const converged = module.evaluateRound({
    round: 1,
    maxRounds: 10,
    requiredReviewers: ["correctness"],
    results: [{ reviewer: "correctness", status: "completed", findings: [] }],
  });
  assert.equal(converged.state, "converged");

  const text = readText(REFERENCES.reviewerContract);
  assert.match(text, new RegExp(converged.state));
});

test("documented evaluator statuses and finding constraints are executable", async () => {
  const { evaluateRound } = await import("../scripts/review-round.mjs");
  const base = {
    round: 1,
    maxRounds: 10,
    requiredReviewers: ["correctness"],
  };
  const validFinding = {
    id: "finding:contract",
    severity: "high",
    confidence: 8,
    file: "src/example.mjs",
    line: 1,
    title: "Contract issue",
    evidence: "Concrete evidence",
    recommendation: "Apply a concrete fix",
    status: "open",
  };

  assert.equal(
    evaluateRound({
      ...base,
      results: [
        { reviewer: "correctness", status: "completed", findings: [] },
      ],
    }).state,
    "converged",
  );
  for (const status of ["failed", "skipped"]) {
    assert.equal(
      evaluateRound({
        ...base,
        results: [{ reviewer: "correctness", status }],
      }).state,
      "incomplete",
    );
  }
  assert.throws(() =>
    evaluateRound({
      ...base,
      results: [{ reviewer: "correctness", status: "errored" }],
    }),
  );
  assert.throws(() =>
    evaluateRound({
      ...base,
      results: [
        {
          reviewer: "correctness",
          status: "completed",
          findings: [{ ...validFinding, status: "fixed" }],
        },
      ],
    }),
  );
  assert.throws(() =>
    evaluateRound({
      ...base,
      results: [
        {
          reviewer: "correctness",
          status: "completed",
          findings: [{ ...validFinding, confidence: 11 }],
        },
      ],
    }),
  );
  assert.throws(() =>
    evaluateRound({
      ...base,
      results: [
        {
          reviewer: "correctness",
          status: "completed",
          findings: [{ ...validFinding, owner: "nobody" }],
        },
      ],
    }),
  );

  const actionable = evaluateRound({
    ...base,
    results: [
      {
        reviewer: "correctness",
        status: "completed",
        findings: [validFinding],
      },
    ],
  });
  assert.deepEqual(actionable.actionable[0].reportedBy, ["correctness"]);
});

test("reviewer-contract.md requires unique IDs and reportedBy on every actionable finding", () => {
  const text = readText(REFERENCES.reviewerContract);
  assert.match(text, /unique within[^.]*reviewer/i);
  assert.match(text, /reportedBy[^.]*every actionable finding/i);
});

test("reviewer-contract.md defines the context supplied to every reviewer", () => {
  const text = readText(REFERENCES.reviewerContract);
  for (const requiredContext of [
    /normalized task/i,
    /acceptance criteria/i,
    /repository instructions/i,
    /current diff/i,
    /relevant files/i,
    /validation output/i,
    /prior-round findings/i,
    /dispositions/i,
  ]) {
    assert.match(text, requiredContext);
  }
});

// --- references/harness-adapters.md ---

test("harness-adapters.md maps Claude to Agent/custom subagent invocation and generated agents", () => {
  const text = readText(REFERENCES.harnessAdapters);
  assert.match(text, /Claude/);
  assert.match(text, /\bAgent\b/);
  assert.match(text, /custom subagent/i);
  assert.match(text, /generated\/claude\/agents/);
});

test("harness-adapters.md maps Copilot to custom-agent tools and root agents/*.agent.md", () => {
  const text = readText(REFERENCES.harnessAdapters);
  assert.match(text, /Copilot/);
  assert.match(text, /custom.agent/i);
  assert.match(text, /agents\/\*\.agent\.md/);
});

test("harness-adapters.md maps Codex to explicit subagent delegation and generated TOML", () => {
  const text = readText(REFERENCES.harnessAdapters);
  assert.match(text, /Codex/);
  assert.match(text, /explicit subagent delegation/i);
  assert.match(text, /generated\/codex\/agents/);
  assert.match(text, /\.toml/);
});

test("harness-adapters.md maps Gemini to custom subagent tools and generated agents", () => {
  const text = readText(REFERENCES.harnessAdapters);
  assert.match(text, /Gemini/);
  assert.match(text, /custom subagent/i);
  assert.match(text, /generated\/gemini\/agents/);
});

test("harness-adapters.md requires capability checks and forbids imitating another harness's syntax", () => {
  const text = readText(REFERENCES.harnessAdapters);
  assert.match(text, /capabilit/i);
  assert.match(text, /fallback/i);
  assert.match(text, /must not (?:imitate|pretend)/i);
  assert.match(text, /normaliz[^.]*result envelope/i);
  assert.match(text, /reviewer-spawning[^.]*fallback/is);
  assert.match(text, /validation, Git, or pull request capability[^.]*stop/is);
  assert.match(text, /passing[^.]*task[^.]*diff[^.]*file[^.]*validation context/is);
  assert.match(text, /capturing screenshots[\s\S]*?materially required/i);
  assert.match(text, /screenshot capability[^.]*unavailable[^.]*stop/is);
});

test("harness-adapters.md distinguishes installed skill paths from source artifacts", () => {
  const text = readText(REFERENCES.harnessAdapters);
  assert.match(text, /installed\s+skill directory/i);
  assert.match(text, /reviewers\/<role>\.md/);
  assert.match(text, /source (?:checkout|tree|package)/i);
  assert.match(
    text,
    /scripts\/review-round\.mjs[^.]*installed\s+skill directory/is,
  );
  assert.match(text, /source-package wrapper/i);
  assert.match(text, /evaluator helper[^.]*unavailable[^.]*stop/is);
});

// --- references/documentation-and-pr.md ---

test("documentation-and-pr.md defines the impact test across all documentation surfaces", () => {
  const text = readText(REFERENCES.documentationAndPr);
  for (const surface of [
    /README/,
    /usage/i,
    /(?:config|API)/i,
    /example/i,
    /diagram/i,
    /screenshot/i,
  ]) {
    assert.match(text, surface);
  }
  assert.match(text, /only when material/i);
});

test("documentation-and-pr.md defines the final PR gates, sequence, and body requirements", () => {
  const text = readText(REFERENCES.documentationAndPr);
  assert.match(text, /every required review/i);
  assert.match(text, /no actionable findings remain/i);
  assert.match(text, /draft pull request/i);
  assert.match(text, /assets\/pr-body-template\.md/);
});

// --- assets/pr-body-template.md ---

test("pr-body-template.md declares the required PR body sections", () => {
  const text = readText(PR_TEMPLATE_PATH);
  for (const heading of [
    "## Summary",
    "## Validation",
    "## Review rounds",
    "## Documentation",
  ]) {
    assert.match(text, new RegExp(`^${heading}$`, "m"), `missing: ${heading}`);
  }
});

test("pr-body-template.md's review rounds section reports fixed and rejected findings", () => {
  const text = readText(PR_TEMPLATE_PATH);
  assert.match(text, /fixed_findings|Findings fixed/i);
  assert.match(text, /rejected_findings|Findings rejected/i);
});

// --- exact harness mapping cross-check against scripts/render-agents.mjs ---

test("harness-adapters.md agrees with the actual generated output directories", () => {
  const renderResult = spawnSync(
    process.execPath,
    ["scripts/render-agents.mjs", "--check"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(renderResult.status, 0, renderResult.stderr);

  const generatedManifest = JSON.parse(
    readText(new URL("../.generated-agents.json", import.meta.url)),
  );
  const generatedDirectories = new Set(
    generatedManifest.files.map((file) => file.slice(0, file.lastIndexOf("/") + 1)),
  );
  const text = readText(REFERENCES.harnessAdapters);
  for (const directory of generatedDirectories) {
    assert.ok(
      text.includes(directory),
      `missing generated directory from manifest: ${directory}`,
    );
  }
  assert.match(
    text,
    /root-level generated agent definitions at `agents\/\*\.agent\.md`/,
  );
});

test("the installed skill ships the same self-contained round evaluator", async () => {
  const rootEvaluator = await import("../scripts/review-round.mjs");
  const skillEvaluator = await import(SKILL_EVALUATOR_PATH);

  assert.strictEqual(rootEvaluator.evaluateRound, skillEvaluator.evaluateRound);

  const isolatedDirectory = mkdtempSync(join(tmpdir(), "knights-evaluator-"));
  const isolatedEvaluator = join(isolatedDirectory, "review-round.mjs");
  const isolatedFixture = join(isolatedDirectory, "round.json");
  copyFileSync(fileURLToPath(SKILL_EVALUATOR_PATH), isolatedEvaluator);
  copyFileSync(
    fileURLToPath(
      new URL("./fixtures/review-rounds/converged.json", import.meta.url),
    ),
    isolatedFixture,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [isolatedEvaluator, isolatedFixture],
      { cwd: isolatedDirectory, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, "converged");
  } finally {
    rmSync(isolatedDirectory, { recursive: true, force: true });
  }
});
