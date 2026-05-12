import type { Email, UserId } from "@x1agent/kernel";
import type { GitIdentity } from "./git-identity.js";

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
  /**
   * Optional account-level git identity (X1A-42). When set, the api
   * forwards these into a worker pod's env so commits attribute to the
   * human, not `x1agent[bot]`. When null on either side, the env vars
   * are left unset and the existing bot-attribution fallback stands.
   */
  gitIdentity: GitIdentity | null;
}
