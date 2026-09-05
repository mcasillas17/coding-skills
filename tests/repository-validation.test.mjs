import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

import * as validator from "../scripts/validate.mjs";
import { install } from "../scripts/install.mjs";
import {
  renderAll, renderRepositoryAgents, synchronizeGeneratedAgents,
} from "../scripts/render-agents.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const skillName = "knights-of-the-round-table";
const skillPath = `skills/${skillName}`;
const manifestPaths = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "plugin.json",
  ".github/plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
];
const plugin = {
  name: skillName, version: "0.1.0", description: "Cross-harness coding workflow",
  skills: "./skills/",
};
const manifests = [
  { ...plugin, agents: Object.keys(renderAll().claude).sort().map((file) => `./generated/claude/agents/${file}`) },
  { ...plugin },
  { ...plugin, agents: "./agents/" },
  {
    name: skillName, owner: { name: "coding-skills" },
    plugins: [{ ...plugin, source: "./", agents: "./agents/" }],
  },
  {
    name: skillName,
    plugins: [{
      name: skillName, source: { source: "local", path: "./" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  },
];

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function writeJson(root, path, value) {
  write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function editJson(root, path, edit) {
  const value = JSON.parse(readFileSync(join(root, path), "utf8"));
  edit(value);
  writeJson(root, path, value);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "repository-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["skills", "agents", "generated", ".generated-agents.json", "package.json", "VERSION"]) {
    cpSync(join(projectRoot, path), join(root, path), { recursive: true });
  }
  // Generic dependency validation follows declared local references, not a
  // hard-coded skill name or an assumed runtime layout.
  const entrypoint = `${skillPath}/SKILL.md`;
  write(root, entrypoint, `${readFileSync(join(root, entrypoint), "utf8")}\nSupport parser: \`scripts/parse-yaml.mjs\`.\n`);
  manifestPaths.forEach((path, i) => writeJson(root, path, manifests[i]));
  return root;
}

function validate(root) {
  assert.equal(typeof validator.validateRepository, "function",
    "repository validation must be implemented and exported");
  return validator.validateRepository({ projectRoot: root });
}

function expectInvalid(root, pattern) {
  const { errors } = validate(root);
  assert.ok(errors.length > 0, "fixture must be rejected");
  assert.match(errors.join("\n"), pattern);
}

function addSkill(root, name = "second-skill", body = "") {
  write(root, `skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: Another useful skill.\n---\n\n${body}\n`);
}

function addReviewerSkill(root, name = "second-skill") {
  addSkill(root, name);
  const config = YAML.parse(readFileSync(join(root, skillPath, "config/reviewers.yaml"), "utf8"));
  config.prompt = "reviewers/extra.md";
  config.panels = Object.fromEntries(["claude", "copilot", "codex", "gemini"].map((h) =>
    [h, [{ id: "extra-reviewer", model: "extra-model", fallback: null }]]));
  write(root, `skills/${name}/config/reviewers.yaml`, YAML.stringify(config));
  write(root, `skills/${name}/reviewers/extra.md`, "Review the extra behavior.\n");
  return config;
}

function refreshClaudeManifest(root) {
  editJson(root, manifestPaths[0], (manifest) => {
    manifest.agents = Object.keys(renderRepositoryAgents({ projectRoot: root }).rendered.claude)
      .sort().map((file) => `./generated/claude/agents/${file}`);
  });
}

const canonicalCounts = { claude: 3, copilot: 4, codex: 2, gemini: 2 };
const canonicalAgentCount = Object.values(canonicalCounts).reduce((a, b) => a + b, 0);

function generatedSnapshot(root, encoding = "utf8") {
  const paths = JSON.parse(readFileSync(join(root, ".generated-agents.json"), "utf8")).files;
  return Object.fromEntries(
    [...paths, ".generated-agents.json"].map((path) =>
      [path, readFileSync(join(root, path), encoding)]),
  );
}

test("repository ships all five native distribution manifests", () => {
  for (const path of manifestPaths) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(projectRoot, path), "utf8")), path);
  }
  assert.deepEqual(validate(projectRoot), {
    errors: [], skillCount: 1, reviewerCount: canonicalAgentCount, generatedAgentCount: canonicalAgentCount, manifestCount: 5,
  });
  const rootManifest = JSON.parse(readFileSync(join(projectRoot, "plugin.json"), "utf8"));
  assert.equal(rootManifest.$schema, undefined, "use the Copilot-native shape");
  const codexMarketplace = JSON.parse(readFileSync(join(projectRoot, manifestPaths[4]), "utf8"));
  assert.equal(codexMarketplace.version, undefined);
  assert.equal(codexMarketplace.plugins[0].version, undefined);
});

test("valid fixture needs no repository URLs and reports all component counts", (t) => {
  assert.deepEqual(validate(fixture(t)), {
    errors: [], skillCount: 1, reviewerCount: canonicalAgentCount, generatedAgentCount: canonicalAgentCount, manifestCount: 5,
  });
});

for (const path of manifestPaths) {
  test(`rejects missing manifest: ${path}`, (t) => {
    const root = fixture(t);
    rmSync(join(root, path));
    expectInvalid(root, new RegExp(path.replaceAll(".", "\\.")));
  });
  for (const contents of ["{", "[]", "null"]) {
    test(`rejects invalid manifest ${path}: ${contents}`, (t) => {
      const root = fixture(t);
      write(root, path, contents);
      expectInvalid(root, /manifest|mapping|JSON/i);
    });
  }
}

for (const path of ["VERSION", "package.json", ...manifestPaths.slice(0, 4)]) {
  test(`rejects version drift: ${path}`, (t) => {
    const root = fixture(t);
    if (path === "VERSION") write(root, path, "0.2.0\n");
    else editJson(root, path, (value) => {
      (value.plugins?.[0] ?? value).version = "0.2.0";
    });
    expectInvalid(root, /version/i);
  });
}

const invalidManifests = [
  [0, (m) => { delete m.name; }, /name/],
  [1, (m) => { m.skills = "./skills/missing/"; }, /skills/],
  [0, (m) => { m.agents = "./agents/"; }, /agents/],
  [0, (m) => { m.agents = "./generated/claude/agents/"; }, /agents/],
  [0, (m) => { m.agents = []; }, /agents/],
  [0, (m) => { m.agents.pop(); }, /agents/],
  [0, (m) => { m.agents.push(m.agents[0]); }, /agents/],
  [0, (m) => { m.agents.push("../outside.md"); }, /path|agents/],
  [1, (m) => { m.agents = "./generated/codex/agents/"; }, /agents/],
  [2, (m) => { m.agents = "./generated/claude/agents/"; }, /agents/],
  [2, (m) => { m.skills = ["./skills/", "../outside"]; }, /path|outside/],
  [2, (m) => { m.agents = [42]; }, /agents/],
  [3, (m) => { delete m.owner; }, /owner/],
  [3, (m) => { m.plugins = {}; }, /plugins/],
  [3, (m) => { m.plugins = []; }, /plugin/],
  [3, (m) => { m.plugins[0].source = "./skills/"; }, /source/],
  [3, (m) => { delete m.plugins[0].skills; }, /skills/],
  [3, (m) => { delete m.plugins[0].agents; }, /agents/],
  [3, (m) => { m.plugins.push(structuredClone(m.plugins[0])); }, /duplicate/],
  [4, (m) => { m.plugins[0].source.path = "./skills/"; }, /source/],
  [4, (m) => { m.plugins[0].source.source = "url"; }, /source/],
  [4, (m) => { delete m.plugins[0].policy.authentication; }, /authentication/],
  [4, (m) => { delete m.plugins[0].category; }, /category/],
  [4, (m) => { m.plugins[0].version = "0.1.0"; }, /version/],
  [4, (m) => { m.version = "0.1.0"; }, /version/],
];
for (const [i, mutate, pattern] of invalidManifests) {
  test(`rejects manifest shape: ${manifestPaths[i]} ${mutate}`, (t) => {
    const root = fixture(t);
    editJson(root, manifestPaths[i], mutate);
    expectInvalid(root, pattern);
  });
}

test("marketplaces find the root plugin by name rather than array position or length", (t) => {
  const root = fixture(t);
  // A second local plugin has its own version; it is not this package's version.
  writeJson(root, "extra/plugin.json", { name: "extra", version: "2.0.0" });
  writeJson(root, "extra/.codex-plugin/plugin.json", { name: "extra", version: "2.0.0" });
  editJson(root, manifestPaths[3], (m) => {
    m.plugins.unshift({ name: "extra", source: "./extra/", version: "2.0.0" });
  });
  editJson(root, manifestPaths[4], (m) => {
    m.plugins.unshift({
      name: "extra", source: { source: "local", path: "./extra/" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity",
    });
  });
  assert.deepEqual(validate(root).errors, []);
});

test("supported component arrays may expose additional existing local directories", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "more-skills"));
  for (const path of [manifestPaths[0], manifestPaths[2]]) {
    editJson(root, path, (m) => { m.skills = ["./skills/", "./more-skills/"]; });
  }
  assert.deepEqual(validate(root).errors, []);
});

for (const source of ["../outside", { source: "local", path: "../outside" }, { source: "local" }]) {
  test(`rejects unsafe additional Codex local source: ${JSON.stringify(source)}`, (t) => {
    const root = fixture(t);
    editJson(root, manifestPaths[4], (m) => {
      m.plugins.push({
        name: "extra", source, category: "Productivity",
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      });
    });
    expectInvalid(root, /source.*path|local.*path/);
  });
}

test("validates repository URLs only when supplied", (t) => {
  const root = fixture(t);
  editJson(root, "plugin.json", (m) => {
    m.repository = "https://github.com/mcasillas17/coding-skills";
  });
  assert.deepEqual(validate(root).errors, []);
  editJson(root, "plugin.json", (m) => { m.repository += ".git"; });
  expectInvalid(root, /repository/);
});

test("enumerates two skills including a generic skill with no reviewer configuration", (t) => {
  const root = fixture(t);
  addSkill(root, "second-skill", "See [guide](references/guide.md) and `assets/example.json`.");
  write(root, "skills/second-skill/references/guide.md", "A complete guide.\n");
  write(root, "skills/second-skill/assets/example.json", "{}\n");
  assert.deepEqual(validate(root), {
    errors: [], skillCount: 2, reviewerCount: canonicalAgentCount, generatedAgentCount: canonicalAgentCount, manifestCount: 5,
  });
  rmSync(join(root, "skills/second-skill/SKILL.md"));
  expectInvalid(root, /second-skill.*SKILL\.md/);
});

for (const [label, text, pattern] of [
  ["absent", "# Missing frontmatter\n", /frontmatter/],
  ["invalid YAML", "---\nname: [\n---\n", /YAML|parse|flow/i],
  ["sequence", "---\n- name\n---\n", /mapping/],
  ["null", "---\nnull\n---\n", /mapping/],
  ["duplicate keys", "---\nname: second-skill\nname: second-skill\n---\n", /unique|duplicate/i],
  ["wrong name", "---\nname: another-skill\ndescription: Fine.\n---\n", /name.*directory/],
  ["invalid name", "---\nname: Second--Skill\ndescription: Fine.\n---\n", /name/],
  ["long name", `---\nname: ${"a".repeat(65)}\ndescription: Fine.\n---\n`, /name/],
  ["empty description", "---\nname: second-skill\ndescription: '  '\n---\n", /description/],
  ["non-string description", "---\nname: second-skill\ndescription: 42\n---\n", /description/],
  ["long description", `---\nname: second-skill\ndescription: ${"a".repeat(1025)}\n---\n`, /description/],
]) {
  test(`rejects skill frontmatter: ${label}`, (t) => {
    const root = fixture(t);
    write(root, "skills/second-skill/SKILL.md", text);
    expectInvalid(root, pattern);
  });
}

for (const reference of [
  "[guide](references/missing.md)", "`references/missing.md`",
  "[guide][guide]\n\n[guide]: references/missing.md",
  "[escape](../../package.json)", "`references/../../other.md`",
  "[encoded escape](references/%2e%2e/%2e%2e/other.md)",
  "[absolute](/tmp/outside.md)",
  "`./missing.md`", "`../outside.md`",
]) {
  test(`rejects missing or escaping skill reference: ${reference}`, (t) => {
    const root = fixture(t);
    addSkill(root, "second-skill", reference);
    expectInvalid(root, /reference|inside|path/);
  });
}

for (const [target, filename] of [
  ["50%-plan.md", "50%-plan.md"],
  ["50%2-plan.md", "50%2-plan.md"],
  ["50%GG-plan.md", "50%GG-plan.md"],
  ["50%FF-plan.md", "50%FF-plan.md"],
  ["50%25-plan.md", "50%-plan.md"],
]) {
  test(`validates percent link targets without opaque URI errors: ${target}`, (t) => {
    const root = fixture(t);
    addSkill(root, "second-skill", [
      `[chart](references/${target})`,
      `[chart][chart]\n\n[chart]: references/${target}`,
    ].join("\n"));
    write(root, `skills/second-skill/references/${filename}`, "A complete chart.\n");
    assert.deepEqual(validate(root).errors, []);
  });
}

for (const target of [
  "references/%2e%2e/%2e%2e/outside.md",
  "references/%2E%2E/%2E%2E/outside.md",
]) {
  test(`rejects encoded traversal even when a literal percent path exists: ${target}`, (t) => {
    const root = fixture(t);
    addSkill(root, "second-skill", `[escape](${target})`);
    write(root, "skills/outside.md", "Outside the skill.\n");
    write(root, `skills/second-skill/${target}`, "Literal path must not bypass decoding.\n");
    expectInvalid(root, /local path must stay inside its root/);
  });
}

test("reports a missing literal percent reference instead of an opaque URI error", (t) => {
  const root = fixture(t);
  addSkill(root, "second-skill", "[chart](references/50%-missing.md)");
  expectInvalid(root, /reference references\/50%-missing\.md:.*ENOENT/);
});

test("rejects traversal with a literal percent using the containment diagnostic", (t) => {
  const root = fixture(t);
  addSkill(root, "second-skill", "[escape](references/../../50%-plan.md)");
  write(root, "skills/50%-plan.md", "Outside the skill.\n");
  expectInvalid(root, /local path must stay inside its root/);
});

test("reference scanning accepts anchors, URL links, commands, prose, and concrete local references", (t) => {
  const root = fixture(t);
  addSkill(root, "second-skill", [
    "[guide](references/guide.md#section) [self](#section)",
    "[web](https://example.com/guide.md) [email](mailto:team@example.com)",
    "`npm run check` `node scripts/example.mjs` `git status` `foo/bar`",
    "`references/<topic>.md` `references/*.md` prose/path without code",
    "[guide][guide]\n\n[guide]: references/guide.md",
    "`assets/guide.json`",
    "`./assets/guide.json`",
  ].join("\n"));
  write(root, "skills/second-skill/references/guide.md", "# Section\n");
  write(root, "skills/second-skill/assets/guide.json", "{}\n");
  assert.deepEqual(validate(root).errors, []);
});

for (const fence of ["```", "~~~"]) {
  for (const reference of ["[guide](references/missing.md)", "`references/missing.md`"]) {
    test(`detects prose reference after longer fenced-code close: ${fence} ${reference}`, (t) => {
      const root = fixture(t);
      addSkill(root, "second-skill", [
        `${fence}text`,
        "[example](references/not-a-dependency.md)",
        `${fence}${fence[0]}`,
        reference,
        fence,
        "Another example.",
        fence,
      ].join("\n"));
      expectInvalid(root, /reference references\/missing\.md/);
    });
  }
}

for (const [label, opener, interior, closer] of [
  ["backticks", "```text", "", "```"],
  ["tildes with backtick info", "~~~example `code`", "", "~~~~"],
  ["indented fences with trailing whitespace", "   ```text", "", "  ```` \t"],
  ["shorter non-closing fence", "````", "```", "````"],
  ["different non-closing character", "```", "~~~", "```"],
  ["non-closing suffix", "```", "``` not a close", "```"],
  ["over-indented non-closing fence", "```", "    ```", "```"],
  ["unclosed fence", "```", "", ""],
]) {
  test(`ignores fenced-code references and placeholders: ${label}`, (t) => {
    const root = fixture(t);
    addSkill(root, "second-skill", [
      opener, interior,
      "TODO TBD FIXME XXX",
      "[example](references/missing.md)",
      "[example]: references/missing.md",
      "`assets/missing.json`",
      closer,
    ].join("\r\n"));
    assert.deepEqual(validate(root).errors, []);
  });
}

for (const opener of ["    ```", "\t```", "``", "~~`", "```bad `info`"]) {
  test(`does not treat invalid fenced-code opener as a fence: ${JSON.stringify(opener)}`, (t) => {
    const root = fixture(t);
    addSkill(root, "second-skill", `${opener}\n[guide](references/missing.md)\n\`\`\`\n`);
    expectInvalid(root, /reference references\/missing\.md/);
  });
}

for (const marker of ["TBD", "TODO", "FIXME", "XXX"]) {
  test(`rejects prose placeholder after fenced-code example: ${marker}`, (t) => {
    const root = fixture(t);
    addSkill(root, "second-skill", `\`\`\`\nExample.\n\`\`\`\`\n${marker}: complete this section.\n`);
    expectInvalid(root, /placeholder/);
  });
}

for (const path of ["SKILL.md", "references/guide.md", "assets/template.md", "reviewers/custom.md"]) {
  for (const marker of ["TBD", "TODO", "FIXME", "XXX"]) {
    test(`rejects unfinished prose ${marker} in ${path}`, (t) => {
      const root = fixture(t);
      addSkill(root);
      const target = `skills/second-skill/${path}`;
      const header = path === "SKILL.md" ? readFileSync(join(root, target), "utf8") : "";
      write(root, target, `${header}\n**${marker}**: complete this section.\n`);
      expectInvalid(root, /placeholder/);
    });
  }
}

test("does not scan design plans, generated code, or substrings as prose placeholders", (t) => {
  const root = fixture(t);
  addSkill(root, "second-skill", "METHODTODO and XXXL are not unfinished markers.");
  write(root, "docs/plan.md", "TODO\n");
  write(root, "skills/second-skill/scripts/example.mjs", "// TODO\n");
  assert.deepEqual(validate(root).errors, []);
});

for (const [harness, path] of [
  ["Claude", "generated/claude/agents/knights-opus.md"],
  ["Copilot", "agents/knights-grok.agent.md"],
  ["Codex", "generated/codex/agents/knights-sol.toml"],
  ["Gemini", "generated/gemini/agents/knights-flash.md"],
]) {
  for (const missing of [true, false]) {
    test(`rejects ${missing ? "missing" : "stale"} generated ${harness} agent`, (t) => {
      const root = fixture(t);
      if (missing) rmSync(join(root, path));
      else write(root, path, "Stale generated agent\n");
      expectInvalid(root, /generated.*(stale|current|date)|drift/i);
    });
  }
}

for (const contents of ['{"version":1,"files":[]}', "{", '{"version":1,"files":["../outside"]}']) {
  test(`rejects ownership manifest drift or malformed ownership: ${contents}`, (t) => {
    const root = fixture(t);
    write(root, ".generated-agents.json", contents);
    expectInvalid(root, /ownership|generated/);
  });
}

for (const harness of ["claude", "copilot", "codex", "gemini"]) {
  test(`rejects missing reviewer mapping for ${harness}`, (t) => {
    const root = fixture(t);
    const path = `${skillPath}/config/reviewers.yaml`;
    const config = YAML.parse(readFileSync(join(root, path), "utf8"));
    delete config.panels[harness];
    write(root, path, YAML.stringify(config));
    expectInvalid(root, /panel|harness/i);
  });
}

test("accepts a replacement panel with no fixed canonical role or reviewer count", (t) => {
  const root = fixture(t);
  const path = `${skillPath}/config/reviewers.yaml`;
  const config = YAML.parse(readFileSync(join(root, path), "utf8"));
  config.panels.claude = [{ id: "replacement", model: "replacement-model", fallback: null }];
  write(root, path, YAML.stringify(config));
  synchronizeGeneratedAgents({ projectRoot: root });
  refreshClaudeManifest(root);
  assert.deepEqual(validate(root).errors, []);
});

test("repository discovery and validation do not require a fixed skill directory name", (t) => {
  const root = fixture(t);
  const renamed = "renamed-review-skill";
  renameSync(join(root, skillPath), join(root, "skills", renamed));
  const entrypoint = `skills/${renamed}/SKILL.md`;
  write(root, entrypoint, readFileSync(join(root, entrypoint), "utf8")
    .replace(`name: ${skillName}`, `name: ${renamed}`));
  assert.deepEqual(renderRepositoryAgents({ projectRoot: root }).skills.map(({ name }) => name), [renamed]);
  assert.deepEqual(validate(root).errors, []);
});

test("Claude manifest includes configured fallbacks and rejects unrendered Markdown files", (t) => {
  const root = fixture(t);
  const configPath = `${skillPath}/config/reviewers.yaml`;
  const config = YAML.parse(readFileSync(join(root, configPath), "utf8"));
  config.panels.claude[0].fallback = { id: "backup-reviewer", model: "backup-model" };
  write(root, configPath, YAML.stringify(config));
  synchronizeGeneratedAgents({ projectRoot: root });
  expectInvalid(root, /Claude agents file list/);
  refreshClaudeManifest(root);
  assert.deepEqual(validate(root).errors, []);
  write(root, "generated/claude/agents/manual.md", "---\nname: manual\n---\nManual agent.");
  editJson(root, manifestPaths[0], (manifest) => manifest.agents.push("./generated/claude/agents/manual.md"));
  expectInvalid(root, /Claude agents file list/);
});

for (const missingConfig of ["removed", "renamed"]) {
  for (const check of [false, true]) {
    test(`repository renderer fails closed with only config ${missingConfig} (check=${check})`, (t) => {
      const root = fixture(t);
      assert.equal(synchronizeGeneratedAgents({ projectRoot: root }).fileCount, canonicalAgentCount);
      const before = generatedSnapshot(root, null);
      assert.equal(Object.keys(before).length, canonicalAgentCount + 1, "snapshot includes all agents and ownership");
      const configPath = join(root, skillPath, "config/reviewers.yaml");
      if (missingConfig === "removed") rmSync(configPath);
      else renameSync(configPath, `${configPath}.disabled`);

      assert.throws(() => synchronizeGeneratedAgents({ projectRoot: root, check }),
        /no.*config\/reviewers\.yaml|no.*reviewer agents/i);
      assert.deepEqual(generatedSnapshot(root, null), before,
        "all owned agents and the ownership manifest must remain byte-identical");
    });
  }
}

test("explicit renderAll inputs do not require a discovered reviewer config", (t) => {
  const root = fixture(t);
  const expected = renderAll({ projectRoot: root });
  const configPath = join(root, skillPath, "config/reviewers.yaml");
  const config = YAML.parse(readFileSync(configPath, "utf8"));
  const prompts = { [config.prompt]: readFileSync(join(root, skillPath, config.prompt), "utf8") };
  renameSync(configPath, `${configPath}.disabled`);
  assert.deepEqual(renderAll({ projectRoot: root, config, prompts }), expected);
});

test("renderAll defaults to its skill while repository rendering discovers every skill", (t) => {
  const root = fixture(t);
  const canonical = renderAll({ projectRoot: root });
  addReviewerSkill(root);

  const rendered = renderAll({ projectRoot: root });
  for (const [harness, files] of Object.entries(rendered)) {
    assert.equal(Object.keys(files).length, canonicalCounts[harness], "renderAll must remain single-skill");
  }
  assert.deepEqual(rendered, canonical);
  const repository = renderRepositoryAgents({ projectRoot: root });
  assert.deepEqual(repository.skills.map(({ name }) => name), [skillName, "second-skill"]);
  for (const [harness, files] of Object.entries(repository.rendered)) {
    assert.equal(Object.keys(files).length, canonicalCounts[harness] + 1, "repository rendering must include both skills");
  }
});

test("explicit synchronization inputs render only the supplied config in a multi-skill repository", (t) => {
  const root = fixture(t);
  const config = addReviewerSkill(root);
  const prompts = { "reviewers/extra.md": "Review the extra behavior.\n" };
  const result = synchronizeGeneratedAgents({ projectRoot: root, config, prompts });
  assert.equal(result.fileCount, 4);
  const manifest = JSON.parse(readFileSync(join(root, ".generated-agents.json"), "utf8"));
  assert.deepEqual(manifest.files, [
    "agents/extra-reviewer.agent.md",
    "generated/claude/agents/extra-reviewer.md",
    "generated/codex/agents/extra-reviewer.toml",
    "generated/gemini/agents/extra-reviewer.md",
  ]);
  assert.deepEqual(synchronizeGeneratedAgents({ projectRoot: root, config, prompts, check: true }),
    { drift: [], fileCount: 4 });
});

for (const harness of ["claude", "copilot", "codex", "gemini"]) {
  for (const unrelatedConfig of ["valid", "invalid"]) {
    test(`Knights install owns only its ${harness} panel with ${unrelatedConfig} unrelated config`, (t) => {
      const root = fixture(t);
      const canonical = renderAll({ projectRoot: root })[harness];
      const config = addReviewerSkill(root);
      assert.equal(synchronizeGeneratedAgents({ projectRoot: root }).fileCount, canonicalAgentCount + 4);
      if (unrelatedConfig === "invalid") {
        config.panels.claude = [];
        write(root, "skills/second-skill/config/reviewers.yaml", YAML.stringify(config));
      }
      const before = generatedSnapshot(root, null);
      const home = mkdtempSync(join(tmpdir(), "repository-knights-install-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));

      const result = install({ projectRoot: root, home, skill: skillName, harnesses: [harness] });
      assert.equal(result.skill, skillName);
      const agentsDirectory = join(home, `.${harness}/agents`);
      const ownership = JSON.parse(readFileSync(join(agentsDirectory, ".knights-install.json"), "utf8"));
      assert.equal(ownership.skill, skillName);
      assert.deepEqual(ownership.harnesses, [harness]);
      assert.equal(ownership.files.length, canonicalCounts[harness], "Knights must not own the second skill's agent");
      assert.deepEqual(ownership.files.map(({ path }) => path).sort(), Object.keys(canonical).sort());
      assert.deepEqual(readdirSync(agentsDirectory).sort(),
        [".knights-install.json", ...Object.keys(canonical)].sort());
      for (const [filename, content] of Object.entries(canonical)) {
        assert.equal(readFileSync(join(agentsDirectory, filename), "utf8"), content);
      }
      for (const unselected of ["claude", "copilot", "codex", "gemini"].filter((h) => h !== harness)) {
        assert.equal(existsSync(join(home, `.${unselected}/agents`)), false);
      }
      assert.deepEqual(generatedSnapshot(root, null), before, "install must not change repository outputs");
    });
  }
}

test("repository render CLI writes and checks all agents across two skills", (t) => {
  const root = fixture(t);
  addReviewerSkill(root);
  mkdirSync(join(root, "scripts"));
  for (const filename of ["render-agents.mjs", "is-main-module.mjs"]) {
    cpSync(join(projectRoot, "scripts", filename), join(root, "scripts", filename));
  }
  const run = (...args) => spawnSync(process.execPath,
    [join(root, "scripts/render-agents.mjs"), ...args], { cwd: root, encoding: "utf8" });
  const before = generatedSnapshot(root, null);
  const missing = run("--check");
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /extra-reviewer/);
  assert.deepEqual(generatedSnapshot(root, null), before, "check must not mutate outputs");

  const rendered = run();
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout.trim(), `Rendered ${canonicalAgentCount + 4} reviewer agents.`);
  assert.equal(rendered.stderr, "");
  const after = generatedSnapshot(root, null);
  assert.equal(Object.keys(after).length, canonicalAgentCount + 5, "all agents plus ownership");
  const current = run("--check");
  assert.equal(current.status, 0, current.stderr);
  assert.equal(current.stdout.trim(), "Generated reviewer agents are current.");
  assert.equal(current.stderr, "");
  assert.deepEqual(generatedSnapshot(root, null), after);

  write(root, "agents/extra-reviewer.agent.md", "Stale second-skill agent.\n");
  const stale = generatedSnapshot(root, null);
  const drift = run("--check");
  assert.equal(drift.status, 1, drift.stderr);
  assert.match(drift.stderr, /agents\/extra-reviewer\.agent\.md/);
  assert.deepEqual(generatedSnapshot(root, null), stale);
});

test("validates and renders reviewers belonging to another skill without Knights runtime helpers", (t) => {
  const root = fixture(t);
  addReviewerSkill(root);
  assert.equal(existsSync(join(root, "skills/second-skill/scripts")), false);
  const manifestPath = join(root, ".generated-agents.json");
  const canonicalPaths = JSON.parse(readFileSync(manifestPath, "utf8")).files;
  const extraPaths = [
    "agents/extra-reviewer.agent.md",
    "generated/claude/agents/extra-reviewer.md",
    "generated/codex/agents/extra-reviewer.toml",
    "generated/gemini/agents/extra-reviewer.md",
  ];
  // Start without generated artifacts so this exercises creation, not manual fixtures.
  for (const path of canonicalPaths) rmSync(join(root, path));
  rmSync(manifestPath);

  const result = synchronizeGeneratedAgents({ projectRoot: root });
  assert.equal(result.fileCount, canonicalAgentCount + 4, "renderer must generate both skills' agents");
  refreshClaudeManifest(root);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest, {
    version: 1, files: [...canonicalPaths, ...extraPaths].sort(),
  });
  const before = generatedSnapshot(root);
  for (const path of extraPaths) assert.match(before[path], /Review the extra behavior/);
  assert.deepEqual(synchronizeGeneratedAgents({ projectRoot: root }), {
    drift: [], fileCount: canonicalAgentCount + 4,
  });
  assert.deepEqual(synchronizeGeneratedAgents({ projectRoot: root, check: true }), {
    drift: [], fileCount: canonicalAgentCount + 4,
  });
  assert.deepEqual(generatedSnapshot(root), before, "repeat render/check must not change or delete owned files");
  assert.deepEqual(validate(root), {
    errors: [], skillCount: 2, reviewerCount: canonicalAgentCount + 4, generatedAgentCount: canonicalAgentCount + 4, manifestCount: 5,
  });
  rmSync(join(root, "skills/second-skill/reviewers/extra.md"));
  expectInvalid(root, /prompt/);
});

for (const harness of ["claude", "copilot", "codex", "gemini"]) {
  test(`repository renderer rejects cross-skill ${harness} filename collisions before writes`, (t) => {
    const root = fixture(t);
    const config = addReviewerSkill(root);
    const id = Object.keys(renderAll({ projectRoot: root })[harness])[0].split(".")[0];
    config.panels[harness][0].id = id;
    write(root, "skills/second-skill/config/reviewers.yaml", YAML.stringify(config));
    const before = generatedSnapshot(root);
    for (const check of [false, true]) {
      assert.throws(() => synchronizeGeneratedAgents({ projectRoot: root, check }),
        new RegExp(`duplicate.*${harness}.*${id}`));
      assert.deepEqual(generatedSnapshot(root), before);
    }
    expectInvalid(root, /duplicate/);
  });
}

for (const [label, mutate, pattern] of [
  ["invalid config", (config) => { config.panels.claude = []; }, /claude.*non-empty array/],
  ["invalid round limit", (config) => { config.maxReviewRounds = 0; }, /maxReviewRounds/],
  ["unknown config key", (config) => { config.unrecognized = true; }, /unknown key/],
  ["missing harness panel", (config) => { delete config.panels.codex; }, /panel|harness/i],
  ["traversal prompt", (config) => { config.prompt = "../outside.md"; }, /safe relative path/],
  ["missing prompt", (config) => { config.prompt = "reviewers/missing.md"; }, /ENOENT|prompt/],
]) {
  test(`repository renderer rejects another skill's ${label} before writes`, (t) => {
    const root = fixture(t);
    const config = addReviewerSkill(root);
    mutate(config);
    write(root, "skills/second-skill/config/reviewers.yaml", YAML.stringify(config));
    const before = generatedSnapshot(root);
    for (const check of [false, true]) {
      assert.throws(() => synchronizeGeneratedAgents({ projectRoot: root, check }), pattern);
      assert.deepEqual(generatedSnapshot(root), before);
    }
    expectInvalid(root, pattern);
  });
}

for (const path of [
  "skills", skillPath, `${skillPath}/config/reviewers.yaml`,
  "skills/second-skill", "skills/second-skill/config",
  "skills/second-skill/config/reviewers.yaml", "skills/second-skill/reviewers",
  "skills/second-skill/reviewers/extra.md",
]) {
  test(`repository renderer rejects symlinked input before writes: ${path}`, (t) => {
    const root = fixture(t);
    addReviewerSkill(root);
    const target = join(root, "symlink-target");
    cpSync(join(root, path), target, { recursive: true });
    rmSync(join(root, path), { recursive: true });
    symlinkSync(target, join(root, path));
    const before = generatedSnapshot(root);
    for (const check of [false, true]) {
      assert.throws(() => synchronizeGeneratedAgents({ projectRoot: root, check }), /symlink/);
      assert.deepEqual(generatedSnapshot(root), before);
    }
    expectInvalid(root, /symlink/);
  });
}

for (const path of [
  `${skillPath}/config/reviewers.yaml`,
  `${skillPath}/scripts/parse-yaml.mjs`,
  `${skillPath}/scripts/validate-config.mjs`,
  `${skillPath}/scripts/review-round.mjs`,
  `${skillPath}/reviewers/whole-panel.md`,
]) {
  test(`rejects missing required runtime/config/prompt file: ${path}`, (t) => {
    const root = fixture(t);
    rmSync(join(root, path));
    expectInvalid(root, /file|config|prompt|ENOENT/);
  });
}

for (const path of [
  "plugin.json", ".generated-agents.json", "skills",
  skillPath, `${skillPath}/SKILL.md`, `${skillPath}/config`,
  `${skillPath}/scripts/review-round.mjs`, `${skillPath}/reviewers/whole-panel.md`,
  "agents/knights-grok.agent.md", "generated/claude/agents",
]) {
  test(`rejects symlinked validation input: ${path}`, (t) => {
    const root = fixture(t);
    const copy = join(root, "symlink-target");
    cpSync(join(root, path), copy, { recursive: true });
    rmSync(join(root, path), { recursive: true });
    symlinkSync(copy, join(root, path));
    expectInvalid(root, /symlink/);
  });
}

test("rejects symlinked references without following files outside the skill", (t) => {
  const root = fixture(t);
  addSkill(root, "second-skill", "[guide](references/guide.md)");
  mkdirSync(join(root, "skills/second-skill/references"));
  symlinkSync(join(root, "package.json"), join(root, "skills/second-skill/references/guide.md"));
  expectInvalid(root, /symlink|inside/);
});

test("custom config-path CLI reports whole-panel primary counts", () => {
  const result = spawnSync(process.execPath, [
    join(projectRoot, "scripts/validate.mjs"),
    join(projectRoot, skillPath, "config/reviewers.yaml"),
  ], { encoding: "utf8", cwd: tmpdir() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `Validated ${canonicalAgentCount} whole-panel reviewers across 4 harnesses.`);
  assert.equal(result.stderr, "");
});

test("runtime helpers must be regular files, not directories", (t) => {
  const root = fixture(t);
  const path = join(root, skillPath, "scripts/parse-yaml.mjs");
  rmSync(path);
  mkdirSync(path);
  expectInvalid(root, /regular file/);
});

test("rejects malformed config belonging to a generic skill", (t) => {
  const root = fixture(t);
  addSkill(root);
  write(root, "skills/second-skill/config/reviewers.yaml", "reviewers: [\n");
  expectInvalid(root, /reviewer configuration|YAML|parse/i);
});

test("rejects stale changed harness mapping without changing generated artifacts", (t) => {
  const root = fixture(t);
  const path = `${skillPath}/config/reviewers.yaml`;
  const config = YAML.parse(readFileSync(join(root, path), "utf8"));
  config.panels.codex[0].id = "renamed-reviewer";
  write(root, path, YAML.stringify(config));
  const ownership = readFileSync(join(root, ".generated-agents.json"), "utf8");
  expectInvalid(root, /renamed-reviewer/);
  assert.equal(readFileSync(join(root, ".generated-agents.json"), "utf8"), ownership);
  assert.equal(readFileSync(join(root, "generated/codex/agents/knights-sol.toml"), "utf8"),
    readFileSync(join(projectRoot, "generated/codex/agents/knights-sol.toml"), "utf8"));
});
