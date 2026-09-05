import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = path => readFileSync(new URL(`../skills/knights-of-the-round-table/${path}`, import.meta.url), "utf8");

test("skill teaches whole-panel models and an implementation then documented-state review sequence", () => {
  const skill = read("SKILL.md");
  assert.match(skill, /ONE reviewer per configured model/);
  assert.match(skill, /implementation.*converg/i);
  assert.match(skill, /final fresh.*review/i);
  assert.match(skill, /positive.*integer/);
  assert.doesNotMatch(skill, /six canonical roles|hard maximum of 10|may only.*lower|up to 10 extra/);
});
test("skill preserves local-task, repository, dirty-work and publication safety under pressure", () => {
  const skill = read("SKILL.md");
  for (const pattern of [/local file.*inside.*repository/i, /preserve.*dirty/i, /repository instructions/i,
    /retry.*once/i, /full.*panel/i, /draft/i, /never force/i, /Time pressure/i, /normal.*commit.*push.*PR/i,
    /untrusted/i, /no actionable/i, /at the cap/i]) assert.match(skill, pattern);
});
test("machine checks are distinguished from execution attestation and bound to a current snapshot", () => {
  const contract = read("references/reviewer-contract.md");
  for (const pattern of [/cannot prove/i, /host.*attest/i, /snapshotDigest/, /configDigest/,
    /requestedModel/, /execution/, /coverage/, /requiredReviewers.*not/i]) assert.match(contract, pattern);
});
test("every generated reviewer prompt covers all six dimensions independently", () => {
  const prompt = read("reviewers/whole-panel.md");
  for (const area of ["correctness", "tests", "security", "documentation", "architecture", "performance"]) assert.match(prompt, new RegExp(area, "i"));
  assert.match(prompt, /independent/i);
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /untrusted/i);
  assert.match(prompt, /JSON/);
});
test("adapter reference defines concrete namespace, preflight and unsupported integration boundaries", () => {
  const adapters = read("references/harness-adapters.md");
  for (const pattern of [/knights-of-the-round-table:knights-opus/, /preflight/, /--harness codex/,
    /does not register/i, /Antigravity.*unsupported/i, /availability.*unverified/i, /modelSelectionVerified/]) assert.match(adapters, pattern);
});
test("review loop never hides fallback identity or discards colliding finding IDs", () => {
  const loop = read("references/review-loop.md");
  for (const pattern of [/reason/, /fallback/, /file.*line.*id.*title/i, /evidence.*provenance/i,
    /incomplete/, /limit-reached/, /full.*panel/i]) assert.match(loop, pattern);
});
for (const path of ["SKILL.md", "references/review-loop.md", "references/documentation-and-pr.md"]) {
  test(`${path} documents an inclusive cap without blocking clean final reviews`, () => {
    const text = read(path);
    assert.ok(/inclusive/i.test(text), `${path} must describe an inclusive cap`);
    assert.doesNotMatch(text, /At the cap, stop blocked|At the cap, even with an empty report|including a clean final report|no findings; below cap|at configured cap, even if no findings|final-phase snapshot below the cap|incomplete or capped runs never publish/i);
  });
}
test("review budget defaults to 10 and permits 1 despite the two-phase workflow", () => {
  assert.match(read("SKILL.md"), /Default cap is 10/);
  const loop = read("references/review-loop.md");
  assert.ok(/minimum of 1/.test(loop), "the configured cap permits a minimum of 1");
  assert.ok(/at least 2 rounds/.test(loop), "the two-phase workflow needs at least 2 rounds");
});
