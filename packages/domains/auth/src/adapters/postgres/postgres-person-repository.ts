import type postgres from "postgres";
import { Email, UserId } from "@x1agent/kernel";
import type { PersonRepository } from "../../ports/person-repository.js";
import { PersonId, type Person } from "../../domain/person.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  display_name: string;
  created_at: Date | string;
}

function toPerson(r: Row): Person {
  return {
    id: PersonId(r.id),
    displayName: r.display_name,
    createdAt: new Date(r.created_at),
  };
}

export class PostgresPersonRepository implements PersonRepository {
  constructor(private readonly sql: Sql) {}

  async findById(id: PersonId): Promise<Person | null> {
    const rows = await this.sql<Row[]>`
      SELECT id, display_name, created_at FROM persons WHERE id = ${id}
    `;
    return rows[0] ? toPerson(rows[0]) : null;
  }

  async create(input: { displayName: string }): Promise<Person> {
    const rows = await this.sql<Row[]>`
      INSERT INTO persons (display_name) VALUES (${input.displayName})
      RETURNING id, display_name, created_at
    `;
    return toPerson(rows[0]!);
  }

  async findPersonIdForUser(userId: UserId): Promise<PersonId | null> {
    const rows = await this.sql<{ person_id: string | null }[]>`
      SELECT person_id FROM users WHERE id = ${userId}
    `;
    const pid = rows[0]?.person_id;
    return pid ? PersonId(pid) : null;
  }

  async findPersonIdForEmail(email: Email): Promise<PersonId | null> {
    const rows = await this.sql<{ person_id: string | null }[]>`
      SELECT person_id FROM users WHERE lower(email) = ${email}
    `;
    const pid = rows[0]?.person_id;
    return pid ? PersonId(pid) : null;
  }

  async attachUser(userId: UserId, personId: PersonId): Promise<void> {
    await this.sql`
      UPDATE users SET person_id = ${personId} WHERE id = ${userId}
    `;
  }

  async detachUser(userId: UserId): Promise<void> {
    await this.sql`
      UPDATE users SET person_id = NULL WHERE id = ${userId}
    `;
  }

  async listUsersForPerson(personId: PersonId): Promise<readonly UserId[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM users WHERE person_id = ${personId}
    `;
    return rows.map((r) => UserId(r.id));
  }
}
