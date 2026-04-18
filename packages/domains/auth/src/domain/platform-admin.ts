import type { Email } from "@x1agent/kernel";

/**
 * Pure-function policy: a caller decides platform admins by email match
 * against a configured allowlist. No I/O, no env reads.
 */
export function isPlatformAdmin(
  email: Email,
  allowlist: readonly string[],
): boolean {
  const normalized = allowlist.map((e) => e.trim().toLowerCase());
  return normalized.includes(email.toLowerCase());
}
