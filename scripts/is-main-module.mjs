import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function isMainModule(moduleUrl, invokedPath = process.argv[1]) {
  if (invokedPath === undefined) {
    return false;
  }

  const invokedRealPath = realpathOrNull(invokedPath);
  const moduleRealPath = realpathOrNull(fileURLToPath(moduleUrl));
  return (
    invokedRealPath !== null &&
    moduleRealPath !== null &&
    invokedRealPath === moduleRealPath
  );
}
