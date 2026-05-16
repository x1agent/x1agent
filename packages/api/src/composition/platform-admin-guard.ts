import type { UserId } from "@x1agent/kernel";
import type { UserRepository } from "@x1agent/domain-auth";
import type { PlatformAdminGuard } from "@x1agent/domain-sessions";

/**
 * PlatformAdminGuard backed by the install-time `platformAdmins` email
 * list. A user is a platform admin when their primary email
 * (case-insensitive) matches one of the configured addresses.
 *
 * Why not store admin status on the user row: the source of truth lives
 * in the deployment config (Helm values / install secrets). Persisting
 * it on the user row would risk drift and require a sync step when the
 * operator changes the list. The list is short (typically 1–3 emails)
 * so a tiny per-call lookup + Set membership is plenty.
 *
 * The repository lookup is cached only by request — there's no module-
 * level cache here. Sessions-list endpoints are infrequent enough that
 * the extra `users` query per call is fine, and a stale cache after a
 * role revocation would be a security problem.
 */
export class EmailListPlatformAdminGuard implements PlatformAdminGuard {
  private readonly admins: ReadonlySet<string>;

  constructor(
    platformAdmins: readonly string[],
    private readonly users: UserRepository,
  ) {
    this.admins = new Set(platformAdmins.map((e) => e.toLowerCase()));
  }

  async isPlatformAdmin(userId: UserId): Promise<boolean> {
    if (this.admins.size === 0) return false;
    const u = await this.users.findById(userId);
    if (!u) return false;
    return this.admins.has(u.email.toLowerCase());
  }
}
