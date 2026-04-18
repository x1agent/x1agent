import { ValidationError } from "./errors.js";

declare const emailBrand: unique symbol;
export type Email = string & { readonly [emailBrand]: true };

// Minimal RFC-5322-compatible check. We trust the OAuth provider's
// validation; this exists to reject obvious garbage before DB writes.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Email(raw: string): Email {
  const trimmed = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) {
    throw new ValidationError("email", "must be a valid email address");
  }
  return trimmed as Email;
}

export function domainOf(email: Email): string {
  return email.split("@")[1]!;
}
