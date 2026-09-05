import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("package declares the required scripts and skill metadata", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.scripts.test, "node --test tests/*.test.mjs");
  assert.equal(packageJson.scripts.validate, "node scripts/validate.mjs");
  assert.equal(packageJson.scripts.render, "node scripts/render-agents.mjs");
});
