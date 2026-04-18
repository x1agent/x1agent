import { ValidationError } from "./errors.js";

declare const slugBrand: unique symbol;
export type WorkspaceSlug = string & { readonly [slugBrand]: true };

// Lowercase letters, digits, hyphens. Starts with a letter. 2–32 chars.
// Deliberately restrictive — workspace slugs land in URLs.
const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function WorkspaceSlug(raw: string): WorkspaceSlug {
  const trimmed = raw.trim().toLowerCase();
  if (!SLUG_RE.test(trimmed)) {
    throw new ValidationError(
      "slug",
      "must be lowercase letters, digits, hyphens (2–32 chars, start with letter)",
    );
  }
  return trimmed as WorkspaceSlug;
}
