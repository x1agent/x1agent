import { ValidationError } from "@x1agent/kernel";

declare const envNameBrand: unique symbol;
export type EnvName = string & { readonly [envNameBrand]: true };

/**
 * Env-var name as the agent's process.env will see it. Same regex as
 * workspace_secrets.name (the bare-reference syntax). Keeping the
 * patterns aligned means a name accepted here is guaranteed to be
 * a valid POSIX env-var name on the target container.
 */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function EnvName(raw: string): EnvName {
  const trimmed = raw.trim();
  if (!ENV_NAME_RE.test(trimmed)) {
    throw new ValidationError(
      "env_name",
      "must be uppercase letters, digits, and underscores; 1–64 chars; start with a letter or underscore",
    );
  }
  return trimmed as EnvName;
}
