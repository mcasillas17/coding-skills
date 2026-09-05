import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_PATH = join(
  PROJECT_ROOT,
  "skills/knights-of-the-round-table/config/reviewers.yaml",
);
const HARNESS_DIRECTORIES = {
  claude: "generated/claude/agents",
  copilot: "agents",
  codex: "generated/codex/agents",
  gemini: "generated/gemini/agents",
};
const HARNESS_EXTENSIONS = {
  claude: ".md",
  copilot: ".agent.md",
  codex: ".toml",
  gemini: ".md",
};
const REVIEWER_DESCRIPTIONS = {
  architecture:
    "Reviews boundaries, coupling, consistency, maintainability, and migration impact.",
  correctness:
    "Reviews requirements, logic, edge cases, regressions, and error paths.",
  documentation:
    "Reviews impacted setup, examples, API documentation, diagrams, and screenshots.",
  performance:
    "Reviews repeated I/O, algorithmic cost, memory, queries, network use, and caching.",
  security:
    "Reviews exploitable trust-boundary, authorization, injection, secret, and dependency risks.",
  tests:
    "Reviews behavioral coverage, false-positive tests, and untested failure paths.",
};

function quote(value) {
  return JSON.stringify(value);
}

function normalizePrompt(prompt) {
  return prompt.replace(/\r\n/g, "\n").trimEnd();
}

const renderers = {
  claude: ({ name, description, prompt }) =>
    `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n` +
    `tools: Read, Grep, Glob\nmodel: inherit\n---\n\n${prompt}\n`,
  copilot: ({ name, description, prompt }) =>
    `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n` +
    `tools: [read, search]\nuser-invocable: false\n---\n\n${prompt}\n`,
  codex: ({ name, description, prompt }) =>
    `name = ${quote(name)}\ndescription = ${quote(description)}\n` +
    `sandbox_mode = "read-only"\ndeveloper_instructions = ${quote(prompt)}\n`,
  gemini: ({ name, description, prompt }) =>
    `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n` +
    "tools:\n  - read_file\n  - grep_search\n  - glob\n  - list_directory\n" +
    `model: inherit\n---\n\n${prompt}\n`,
};

function loadConfig() {
  return YAML.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function loadPrompts(config) {
  return Object.fromEntries(
    config.reviewers.map(({ prompt }) => [
      prompt,
      readFileSync(
        join(PROJECT_ROOT, "skills/knights-of-the-round-table", prompt),
        "utf8",
      ),
    ]),
  );
}

function outputFilename(harness, name) {
  return `${name}${HARNESS_EXTENSIONS[harness]}`;
}

export function renderAll(options = {}) {
  const config = options.config ?? loadConfig();
  const prompts = options.prompts ?? loadPrompts(config);
  const rendered = Object.fromEntries(
    Object.keys(HARNESS_DIRECTORIES).map((harness) => [harness, {}]),
  );

  for (const reviewer of config.reviewers) {
    const prompt = normalizePrompt(prompts[reviewer.prompt]);
    const description =
      REVIEWER_DESCRIPTIONS[reviewer.role] ??
      `Reviews changes from the ${reviewer.role} perspective.`;

    for (const harness of Object.keys(HARNESS_DIRECTORIES)) {
      const name = reviewer.harnesses[harness];
      const filename = outputFilename(harness, name);
      rendered[harness][filename] = renderers[harness]({
        name,
        description,
        prompt,
      });
    }
  }

  return rendered;
}

function generatedPath(harness, relativePath) {
  const directory = resolve(PROJECT_ROOT, HARNESS_DIRECTORIES[harness]);
  const path = resolve(directory, relativePath);
  if (dirname(path) !== directory) {
    throw new Error(`Unsafe generated agent path: ${relativePath}`);
  }
  return path;
}

function findDrift(rendered) {
  const drift = [];

  for (const [harness, files] of Object.entries(rendered)) {
    const directory = resolve(PROJECT_ROOT, HARNESS_DIRECTORIES[harness]);
    const expectedFiles = new Set(Object.keys(files));

    for (const [relativePath, expected] of Object.entries(files)) {
      const path = generatedPath(harness, relativePath);
      let actual;
      try {
        actual = readFileSync(path, "utf8");
      } catch {
        drift.push(relative(PROJECT_ROOT, path));
        continue;
      }
      if (actual !== expected) {
        drift.push(relative(PROJECT_ROOT, path));
      }
    }

    let existingFiles = [];
    try {
      existingFiles = readdirSync(directory);
    } catch {
      continue;
    }
    for (const existingFile of existingFiles) {
      if (
        existingFile.endsWith(HARNESS_EXTENSIONS[harness]) &&
        !expectedFiles.has(existingFile)
      ) {
        drift.push(relative(PROJECT_ROOT, join(directory, existingFile)));
      }
    }
  }

  return [...new Set(drift)].sort();
}

function writeRendered(rendered) {
  for (const [harness, files] of Object.entries(rendered)) {
    const directory = resolve(PROJECT_ROOT, HARNESS_DIRECTORIES[harness]);
    mkdirSync(directory, { recursive: true });

    for (const existingFile of readdirSync(directory)) {
      if (
        existingFile.endsWith(HARNESS_EXTENSIONS[harness]) &&
        !Object.hasOwn(files, existingFile)
      ) {
        rmSync(generatedPath(harness, existingFile));
      }
    }

    for (const [relativePath, content] of Object.entries(files)) {
      writeFileSync(generatedPath(harness, relativePath), content);
    }
  }
}

function runCli() {
  const unknownArguments = process.argv.slice(2).filter((arg) => arg !== "--check");
  if (unknownArguments.length > 0) {
    console.error(`Unknown argument: ${unknownArguments[0]}`);
    process.exitCode = 1;
    return;
  }

  const rendered = renderAll();
  if (process.argv.includes("--check")) {
    const drift = findDrift(rendered);
    if (drift.length > 0) {
      console.error("Generated reviewer agents are out of date:");
      for (const path of drift) {
        console.error(`- ${path}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log("Generated reviewer agents are current.");
    return;
  }

  writeRendered(rendered);
  const fileCount = Object.values(rendered).reduce(
    (count, files) => count + Object.keys(files).length,
    0,
  );
  console.log(`Rendered ${fileCount} reviewer agents.`);
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli();
}
