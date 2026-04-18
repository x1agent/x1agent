import type postgres from "postgres";
import { PersonId } from "../../domain/person.js";
import type { LinkAttemptStore } from "../../ports/link-attempt-store.js";
import { LinkState, type LinkAttempt } from "../../domain/link-attempt.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  state: string;
  initiating_person_id: string;
  created_at: Date | string;
  expires_at: Date | string;
}

function toAttempt(r: Row): LinkAttempt {
  return {
    state: LinkState(r.state),
    initiatingPersonId: PersonId(r.initiating_person_id),
    createdAt: new Date(r.created_at),
    expiresAt: new Date(r.expires_at),
  };
}

export class PostgresLinkAttemptStore implements LinkAttemptStore {
  constructor(private readonly sql: Sql) {}

  async put(attempt: LinkAttempt): Promise<void> {
    await this.sql`
      INSERT INTO link_attempts (state, initiating_person_id, created_at, expires_at)
      VALUES (${attempt.state}, ${attempt.initiatingPersonId},
              ${attempt.createdAt}, ${attempt.expiresAt})
    `;
  }

  async consume(state: LinkState): Promise<LinkAttempt | null> {
    const rows = await this.sql<Row[]>`
      DELETE FROM link_attempts WHERE state = ${state}
      RETURNING state, initiating_person_id, created_at, expires_at
    `;
    return rows[0] ? toAttempt(rows[0]) : null;
  }
}
