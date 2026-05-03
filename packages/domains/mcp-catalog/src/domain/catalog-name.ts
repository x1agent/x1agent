import { ValidationError } from "@x1agent/kernel";

declare const catalogNameBrand: unique symbol;
export type CatalogName = string & { readonly [catalogNameBrand]: true };

/**
 * MCP catalog entry name. Used as:
 *   * the unique key within a workspace
 *   * the mcpServers key in the agent's claude.json
 *   * the tool name prefix (mcp__<name>__<tool>)
 *
 * Pattern: lowercase letter or digit / underscore / hyphen, must
 * start with a letter. 1..64 chars. The Anthropic MCP runtime treats
 * the prefix as a namespace identifier — keep it shell- and
 * filename-safe.
 */
const CATALOG_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export function CatalogName(raw: string): CatalogName {
  const trimmed = raw.trim();
  if (!CATALOG_NAME_RE.test(trimmed)) {
    throw new ValidationError(
      "name",
      "must be lowercase letters, digits, hyphens, underscores; 1–64 chars; start with a letter",
    );
  }
  return trimmed as CatalogName;
}
