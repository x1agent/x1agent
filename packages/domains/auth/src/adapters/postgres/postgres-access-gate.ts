import type postgres from "postgres";
import { Email } from "@x1agent/kernel";
import type { AccessGate } from "../../ports/access-gate.js";

type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * AccessGate impl: an email is pre-authorized if either
 *   - a user already exists for that email (they were once invited
 *     and accepted, or are the platform-admin bootstrap user), OR
 *   - a still-pending invitation exists for that email in any
 *     workspace.
 *
 * Email comparison is case-insensitive on both sides — the users
 * table normalizes to lowercase but invitations may not, so we coerce.
 */
export class PostgresAccessGate implements AccessGate {
  constructor(private readonly sql: Sql) {}

  async isPreAuthorized(email: Email): Promise<boolean> {
    const lower = String(email).toLowerCase();
    const rows = await this.sql<{ allowed: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM users WHERE lower(email) = ${lower}
        UNION ALL
        SELECT 1 FROM invitations
          WHERE lower(email) = ${lower}
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > now()
      ) AS allowed
    `;
    return rows[0]?.allowed === true;
  }
}
