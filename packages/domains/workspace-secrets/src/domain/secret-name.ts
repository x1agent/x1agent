import { ValidationError } from "@x1agent/kernel";

declare const secretNameBrand: unique symbol;
export type SecretName = string & { readonly [secretNameBrand]: true };

/**
 * Workspace secret name. Matches the bare-reference syntax that every
 * consumer (MCP attachments, sibling env, runtime services) uses:
 *   ^[A-Z_][A-Z0-9_]*$
 * 1..64 characters. Must start with a letter or underscore.
 *
 * The pattern is the same one the runtime uses to validate `${NAME}`
 * references — keeping them aligned at the boundary means a name that
 * passes here is guaranteed to be referenceable everywhere.
 */
const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function SecretName(raw: string): SecretName {
  const trimmed = raw.trim();
  if (!SECRET_NAME_RE.test(trimmed)) {
    throw new ValidationError(
      "name",
      "must be uppercase letters, digits, and underscores; 1–64 chars; start with a letter or underscore",
    );
  }
  return trimmed as SecretName;
}
