import YAML from "yaml";

export function parseFrontmatter(text, source = "document") {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) {
    throw new Error(`${source}: missing YAML frontmatter`);
  }

  const value = YAML.parse(match[1]);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: frontmatter must be a mapping`);
  }
  return value;
}
