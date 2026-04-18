import type { Email, UserId } from "@x1agent/kernel";

/**
 * User is the aggregate root of the auth domain. Identity is a UserId;
 * authentication fact is (providerId, providerUserId). A user can have at
 * most one (providerId, providerUserId) pair in this bounded context —
 * multi-account linking is its own domain (persons) and lives separately.
 */
export interface User {
  id: UserId;
  email: Email;
  name: string;
  avatarUrl: string | null;
  isActive: boolean;
}
