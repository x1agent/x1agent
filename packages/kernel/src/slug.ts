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

/**
 * Lossy slug generator for UX use (auto-fill from a human-readable name).
 * Transliterates common non-decomposable Latin extensions (ø→o, æ→ae, ß→ss,
 * etc.), NFKD-decomposes accented characters and strips combining marks,
 * lowercases, collapses every non-[a-z0-9] run to a single hyphen, trims
 * leading/trailing hyphens.
 *
 * Output is NOT validated against any strict slug format — caller must run
 * WorkspaceSlug() / etc. on the result if a specific shape is required.
 * Empty input or input with only non-Latin characters yields "".
 */
export function slugify(input: string): string {
  // Transliterate Latin-extension characters that NFKD won't decompose to
  // plain ASCII. These are independent base codepoints, not accented vowels.
  const transliterated = input
    .replace(/ø/g, "o").replace(/Ø/g, "O")
    .replace(/æ/g, "ae").replace(/Æ/g, "AE")
    .replace(/œ/g, "oe").replace(/Œ/g, "OE")
    .replace(/ß/g, "ss")
    .replace(/ð/g, "d").replace(/Ð/g, "D")
    .replace(/þ/g, "th").replace(/Þ/g, "TH")
    .replace(/ł/g, "l").replace(/Ł/g, "L");

  return transliterated
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
