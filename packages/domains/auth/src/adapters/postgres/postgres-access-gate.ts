import type postgres from "postgres";
import { Email } from "@x1agent/kernel";
import type { AccessGate } from "../../ports/access-gate.js";

type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * AccessGate impl: an email is pre-authorized if any of:
 *   - a user already exists for that email (they were once invited
 *     and accepted, or are the platform-admin bootstrap user)
 *   - a still-pending invitation exists for that email in any
 *     workspace
 *   - a workspace_access_grant matches the email (exact `email` kind)
 *     or its domain (`domain` kind) and hasn't expired
 *
 * Email comparison is case-insensitive on both sides — the users
 * table normalizes to lowercase but invitations + grants may not, so
 * we coerce on both sides.
 */
export class PostgresAccessGate implements AccessGate {
  constructor(private readonly sql: Sql) {}

  async isPreAuthorized(email: Email): Promise<boolean> {
    const lower = String(email).toLowerCase();
    const at = lower.indexOf("@");
    const domain = at >= 0 ? lower.slice(at + 1) : "";
    const rows = await this.sql<{ allowed: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM users WHERE lower(email) = ${lower}
        UNION ALL
        SELECT 1 FROM invitations
          WHERE lower(email) = ${lower}
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > now()
        UNION ALL
        SELECT 1 FROM workspace_access_grants
          WHERE (expires_at IS NULL OR expires_at > now())
            AND (
              (kind = 'email'  AND value = ${lower})
              OR (kind = 'domain' AND value = ${domain})
            )
      ) AS allowed
    `;
    return rows[0]?.allowed === true;
  }
}
