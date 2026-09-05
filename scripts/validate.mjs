import { readFileSync } from "node:fs";

import { isMainModule } from "./is-main-module.mjs";
import {
  parseYamlDocument,
} from "../skills/knights-of-the-round-table/scripts/parse-yaml.mjs";
import {
  assertValidCanonicalConfig,
  assertValidConfig,
  isSafeRelativePath,
  validateCanonicalConfig,
  validateConfig,
} from "../skills/knights-of-the-round-table/scripts/validate-config.mjs";

export {
  assertValidCanonicalConfig,
  assertValidConfig,
  isSafeRelativePath,
  validateCanonicalConfig,
  validateConfig,
};

function runCli() {
  const configPath =
    process.argv[2] ??
    new URL(
      "../skills/knights-of-the-round-table/config/reviewers.yaml",
      import.meta.url,
    );

  let config;
  try {
    config = parseYamlDocument(
      readFileSync(configPath, "utf8"),
      "reviewer configuration",
    );
  } catch (error) {
    console.error(`Unable to load reviewer configuration: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const errors = validateCanonicalConfig(config);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Validated ${config.reviewers.length} reviewer roles across ${
      Object.keys(config.reviewers[0].harnesses).length
    } harnesses.`,
  );
}

if (isMainModule(import.meta.url)) {
  runCli();
}
