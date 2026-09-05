function yamlError(sourceName, lineNumber, message) {
  return new Error(`${sourceName}:${lineNumber}: ${message}`);
}

function stripComment(value, sourceName, lineNumber) {
  const firstContentIndex = value.search(/\S/u);
  let quote =
    firstContentIndex >= 0 &&
    (value[firstContentIndex] === '"' || value[firstContentIndex] === "'")
      ? value[firstContentIndex]
      : null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (index === firstContentIndex && quote !== null) {
      continue;
    }
    if (quote === '"') {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'" && value[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (
      character === "#" &&
      (index === 0 || /\s/u.test(value[index - 1]))
    ) {
      return value.slice(0, index).trimEnd();
    }
  }

  if (quote !== null) {
    throw yamlError(sourceName, lineNumber, "unterminated quoted scalar");
  }
  return value.trimEnd();
}

function tokenize(document, sourceName) {
  const lines = [];
  const sourceLines = document.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  let documentStarted = false;
  let documentTerminated = false;
  let hasContent = false;

  for (let index = 0; index < sourceLines.length; index += 1) {
    const sourceLine = sourceLines[index];
    const lineNumber = index + 1;
    const indentation = sourceLine.match(/^ */u)[0].length;
    if (sourceLine[indentation] === "\t") {
      throw yamlError(sourceName, lineNumber, "tabs cannot indent YAML");
    }

    const content = stripComment(
      sourceLine.slice(indentation),
      sourceName,
      lineNumber,
    );
    if (content.trim() === "") {
      continue;
    }
    if (indentation === 0 && content === "---") {
      if (documentStarted || documentTerminated || hasContent) {
        throw yamlError(
          sourceName,
          lineNumber,
          "multiple YAML documents are not supported",
        );
      }
      documentStarted = true;
      continue;
    }
    if (indentation === 0 && content === "...") {
      if (documentTerminated) {
        throw yamlError(
          sourceName,
          lineNumber,
          "duplicate YAML document terminator",
        );
      }
      documentTerminated = true;
      continue;
    }
    if (documentTerminated) {
      throw yamlError(
        sourceName,
        lineNumber,
        "content after YAML document terminator is not supported",
      );
    }

    lines.push({
      content,
      indentation,
      lineNumber,
    });
    hasContent = true;
  }

  return lines;
}

function findMappingSeparator(content) {
  let quote = null;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quote === '"') {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'" && content[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (
      character === ":" &&
      (index === content.length - 1 || /\s/u.test(content[index + 1]))
    ) {
      return index;
    }
  }

  return -1;
}

function parseMappingEntry(content, sourceName, lineNumber) {
  const separator = findMappingSeparator(content);
  if (separator === -1) {
    throw yamlError(sourceName, lineNumber, "expected a mapping entry");
  }

  const key = content.slice(0, separator).trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key)) {
    throw yamlError(sourceName, lineNumber, `unsupported mapping key: ${key}`);
  }

  return {
    key,
    value: content.slice(separator + 1).trim(),
  };
}

function parseScalar(value, sourceName, lineNumber) {
  if (value === "[]") {
    return [];
  }
  if (value === "{}") {
    return {};
  }
  if (value === "null" || value === "~") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^[-+]?(?:0|[1-9]\d*)$/u.test(value)) {
    return Number(value);
  }
  if (
    /^[-+]?(?:(?:0|[1-9]\d*)\.\d+|(?:0|[1-9]\d*)[eE][-+]?\d+)$/u.test(
      value,
    )
  ) {
    return Number(value);
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") {
        throw new Error("not a string");
      }
      return parsed;
    } catch {
      throw yamlError(sourceName, lineNumber, "invalid double-quoted scalar");
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw yamlError(sourceName, lineNumber, "invalid single-quoted scalar");
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[&*!|>@`[\]{}]/u.test(value)) {
    throw yamlError(sourceName, lineNumber, "unsupported YAML scalar syntax");
  }
  if (findMappingSeparator(value) !== -1) {
    throw yamlError(sourceName, lineNumber, "unsupported inline mapping");
  }
  return value;
}

function isSequenceLine(content) {
  return content === "-" || content.startsWith("- ");
}

function setMappingValue(mapping, key, value, sourceName, lineNumber) {
  if (Object.hasOwn(mapping, key)) {
    throw yamlError(sourceName, lineNumber, `duplicate mapping key: ${key}`);
  }
  mapping[key] = value;
}

function parseMapping(lines, startIndex, indentation, sourceName) {
  const mapping = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line.indentation < indentation) {
      break;
    }
    if (line.indentation > indentation) {
      throw yamlError(
        sourceName,
        line.lineNumber,
        "unexpected nested block",
      );
    }
    if (isSequenceLine(line.content)) {
      break;
    }

    const entry = parseMappingEntry(
      line.content,
      sourceName,
      line.lineNumber,
    );
    index += 1;

    if (entry.value !== "") {
      setMappingValue(
        mapping,
        entry.key,
        parseScalar(entry.value, sourceName, line.lineNumber),
        sourceName,
        line.lineNumber,
      );
      if (
        index < lines.length &&
        lines[index].indentation > indentation
      ) {
        throw yamlError(
          sourceName,
          lines[index].lineNumber,
          `mapping key ${entry.key} cannot have both a scalar and a nested block`,
        );
      }
      continue;
    }

    if (index >= lines.length || lines[index].indentation <= indentation) {
      setMappingValue(
        mapping,
        entry.key,
        null,
        sourceName,
        line.lineNumber,
      );
      continue;
    }

    const nested = parseNode(
      lines,
      index,
      lines[index].indentation,
      sourceName,
    );
    setMappingValue(
      mapping,
      entry.key,
      nested.value,
      sourceName,
      line.lineNumber,
    );
    index = nested.nextIndex;
  }

  return { nextIndex: index, value: mapping };
}

function mergeSequenceMapping(
  mapping,
  extension,
  sourceName,
  lineNumber,
) {
  for (const [key, value] of Object.entries(extension)) {
    setMappingValue(mapping, key, value, sourceName, lineNumber);
  }
}

function parseSequence(lines, startIndex, indentation, sourceName) {
  const sequence = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line.indentation < indentation) {
      break;
    }
    if (line.indentation > indentation) {
      throw yamlError(
        sourceName,
        line.lineNumber,
        "unexpected nested sequence block",
      );
    }
    if (!isSequenceLine(line.content)) {
      break;
    }

    const item = line.content.slice(1).trim();
    index += 1;
    if (item === "") {
      if (index >= lines.length || lines[index].indentation <= indentation) {
        sequence.push(null);
        continue;
      }
      const nested = parseNode(
        lines,
        index,
        lines[index].indentation,
        sourceName,
      );
      sequence.push(nested.value);
      index = nested.nextIndex;
      continue;
    }

    const separator = findMappingSeparator(item);
    if (separator === -1) {
      sequence.push(parseScalar(item, sourceName, line.lineNumber));
      if (
        index < lines.length &&
        lines[index].indentation > indentation
      ) {
        throw yamlError(
          sourceName,
          lines[index].lineNumber,
          "scalar sequence item cannot have a nested block",
        );
      }
      continue;
    }

    const firstEntry = parseMappingEntry(
      item,
      sourceName,
      line.lineNumber,
    );
    const mapping = {};
    const mappingIndentation = indentation + 2;
    if (
      firstEntry.value === "" &&
      index < lines.length &&
      lines[index].indentation > mappingIndentation
    ) {
      const nested = parseNode(
        lines,
        index,
        lines[index].indentation,
        sourceName,
      );
      setMappingValue(
        mapping,
        firstEntry.key,
        nested.value,
        sourceName,
        line.lineNumber,
      );
      index = nested.nextIndex;
    } else {
      setMappingValue(
        mapping,
        firstEntry.key,
        firstEntry.value === ""
          ? null
          : parseScalar(firstEntry.value, sourceName, line.lineNumber),
        sourceName,
        line.lineNumber,
      );
    }

    if (index < lines.length && lines[index].indentation > indentation) {
      if (lines[index].indentation !== mappingIndentation) {
        throw yamlError(
          sourceName,
          lines[index].lineNumber,
          "sequence mapping keys must have consistent indentation",
        );
      }
      const continuationLineNumber = lines[index].lineNumber;
      const extension = parseNode(
        lines,
        index,
        mappingIndentation,
        sourceName,
      );
      if (
        extension.value === null ||
        Array.isArray(extension.value) ||
        typeof extension.value !== "object"
      ) {
        throw yamlError(
          sourceName,
          lines[index].lineNumber,
          "sequence mapping continuation must be a mapping",
        );
      }
      mergeSequenceMapping(
        mapping,
        extension.value,
        sourceName,
        continuationLineNumber,
      );
      index = extension.nextIndex;
    }
    sequence.push(mapping);
  }

  return { nextIndex: index, value: sequence };
}

function parseNode(lines, startIndex, indentation, sourceName) {
  if (isSequenceLine(lines[startIndex].content)) {
    return parseSequence(lines, startIndex, indentation, sourceName);
  }
  return parseMapping(lines, startIndex, indentation, sourceName);
}

export function parseYamlDocument(
  document,
  sourceName = "YAML document",
) {
  if (typeof document !== "string") {
    throw new TypeError("YAML document must be a string");
  }

  const lines = tokenize(document, sourceName);
  if (lines.length === 0) {
    return null;
  }
  if (lines[0].indentation !== 0) {
    throw yamlError(
      sourceName,
      lines[0].lineNumber,
      "root content must not be indented",
    );
  }

  const parsed = parseNode(lines, 0, 0, sourceName);
  if (parsed.nextIndex !== lines.length) {
    const line = lines[parsed.nextIndex];
    throw yamlError(sourceName, line.lineNumber, "unexpected indentation");
  }
  return parsed.value;
}
