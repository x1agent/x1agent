import { ValidationError } from "@x1agent/kernel";

/**
 * The git author identity stamped onto worker commits.
 *
 * When a user fills in this pair on their account page, the api
 * forwards it into the agent container's environment as
 * GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL / GIT_COMMITTER_NAME /
 * GIT_COMMITTER_EMAIL before the worker process starts. Result:
 * commits authored by the human, not by `x1agent[bot]`.
 *
 * Manual-entry path only in this slice — the user types both values
 * and gets a UI hint that the email must be verified on the GitHub
 * account they want commits attributed to. A future slice will add
 * a GitHub-OAuth-driven discovery flow that pre-fills from the
 * user's verified email list and removes the typo surface.
 *
 * Both values are optional. Storing nothing (or only one of the two)
 * leaves env vars unset and the existing `x1agent[bot]` fallback
 * stands — the worker still runs, just commits attribute to the bot.
 */
export interface GitIdentity {
  /** Free-form display name. e.g. "Jane Doe", "dev360". */
  readonly name: string;
  /** Email address — must be verified on GitHub for commit attribution. */
  readonly email: string;
}

// Same shape as kernel/email.ts EMAIL_RE — duplicated locally to keep
// the value-object boundary clean (we don't want a hard dep on Email
// here because git's accepted email shape is broader: noreply@…
// addresses and emails with `+aliases` are all fine).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NAME_MAX = 200;
const EMAIL_MAX = 200;

/**
 * Validate raw user input for the git identity. Throws ValidationError
 * with a stable field name so the API route can map errors back onto
 * form fields. Mirrors the DB-level CHECK constraints in migration 046
 * so an invalid value is caught at the application boundary rather
 * than as an opaque postgres constraint violation.
 */
export function parseGitIdentity(raw: {
  name: string;
  email: string;
}): GitIdentity {
  const name = raw.name.trim();
  if (name.length === 0) {
    throw new ValidationError("git_name", "must not be empty");
  }
  if (name.length > NAME_MAX) {
    throw new ValidationError("git_name", `must be ${NAME_MAX} chars or fewer`);
  }
  // Disallow control characters so the value can't smuggle a CRLF into
  // a generated commit-trailer, env var, or log line.
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new ValidationError(
      "git_name",
      "must not contain control characters",
    );
  }

  const email = raw.email.trim();
  if (email.length === 0) {
    throw new ValidationError("git_email", "must not be empty");
  }
  if (email.length > EMAIL_MAX) {
    throw new ValidationError(
      "git_email",
      `must be ${EMAIL_MAX} chars or fewer`,
    );
  }
  if (!EMAIL_RE.test(email)) {
    throw new ValidationError("git_email", "must be a valid email address");
  }
  if (/[\x00-\x1f\x7f]/.test(email)) {
    throw new ValidationError(
      "git_email",
      "must not contain control characters",
    );
  }

  return { name, email };
}
