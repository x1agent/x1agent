import { createHash } from "node:crypto";

/**
 * Sanitized + hashed identifier used as the Postgres DB name, Postgres role
 * name, and Redis ACL user for a specific (repo, branch) pair. Two rules:
 *
 * 1. Postgres's 63-byte identifier limit. The sanitized branch name plus an
 *    8-char suffix plus the repo name plus separators fits comfortably.
 * 2. Branches like `feat/x-y` and `feat-x_y` must not collide after
 *    sanitization. The hash suffix guarantees uniqueness.
 *
 * Output shape: `<repo>_<sanitized-branch>_<hash8>`.
 */
export function branchId(repoFullName: string, branchName: string): string {
  const repoShort = sanitize(ownerlessRepo(repoFullName));
  const branchShort = sanitize(branchName);
  const h = hash8(`${repoFullName}\n${branchName}`);
  const combined = `${repoShort}_${branchShort}_${h}`;
  // Final belt-and-suspenders truncate; with realistic inputs this is a
  // no-op. Keep the hash intact on the right.
  if (combined.length <= 63) return combined;
  const overflow = combined.length - 63;
  return `${repoShort.slice(0, Math.max(1, repoShort.length - overflow))}_${branchShort}_${h}`;
}

function ownerlessRepo(repoFullName: string): string {
  const slash = repoFullName.lastIndexOf("/");
  return slash >= 0 ? repoFullName.slice(slash + 1) : repoFullName;
}

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

function hash8(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}
