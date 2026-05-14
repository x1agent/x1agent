import type { Email, UserId } from "@x1agent/kernel";
import type { PersonRepository } from "../ports/person-repository.js";
import type { LinkAttemptStore } from "../ports/link-attempt-store.js";
import {
  PersonId,
  type Person,
} from "../domain/person.js";
import type {
  LinkAttempt,
  LinkState,
} from "../domain/link-attempt.js";

let counter = 0xaa;
function nextUuid(): string {
  const n = (++counter).toString(16).padStart(12, "0");
  return `00000000-0000-7000-8000-${n}`;
}

export class InMemoryPersonRepository implements PersonRepository {
  readonly persons = new Map<string, Person>();
  /** user_id -> person_id */
  readonly userLinks = new Map<string, string>();
  /** email -> user_id (set externally to simulate existing users) */
  readonly emailToUser = new Map<string, string>();

  async findById(id: PersonId) {
    return this.persons.get(id) ?? null;
  }

  async create(input: { displayName: string }): Promise<Person> {
    const id = PersonId(nextUuid());
    const p: Person = {
      id,
      displayName: input.displayName,
      createdAt: new Date(),
    };
    this.persons.set(id, p);
    return p;
  }

  async findPersonIdForUser(userId: UserId) {
    const pid = this.userLinks.get(userId);
    return pid ? (pid as unknown as PersonId) : null;
  }

  async findPersonIdForEmail(email: Email): Promise<PersonId | null> {
    const userId = this.emailToUser.get(email.toLowerCase());
    if (!userId) return null;
    return this.findPersonIdForUser(userId as unknown as UserId);
  }

  async attachUser(userId: UserId, personId: PersonId): Promise<void> {
    this.userLinks.set(userId, personId);
  }

  async detachUser(userId: UserId): Promise<void> {
    this.userLinks.delete(userId);
  }

  async listUsersForPerson(personId: PersonId): Promise<readonly UserId[]> {
    const out: UserId[] = [];
    for (const [uid, pid] of this.userLinks)
      if (pid === personId) out.push(uid as unknown as UserId);
    return out;
  }

  /** Test helper: simulate that `email` belongs to a user attached to `personId`. */
  seed(email: Email, userId: UserId, personId: PersonId) {
    this.emailToUser.set(email.toLowerCase(), userId);
    this.userLinks.set(userId, personId);
  }
}

export class InMemoryLinkAttemptStore implements LinkAttemptStore {
  readonly rows = new Map<string, LinkAttempt>();
  async put(attempt: LinkAttempt): Promise<void> {
    this.rows.set(attempt.state, attempt);
  }
  async consume(state: LinkState): Promise<LinkAttempt | null> {
    const a = this.rows.get(state) ?? null;
    if (a) this.rows.delete(state);
    return a;
  }
}

import type { OAuthLoginStateStore } from "../ports/oauth-login-state-store.js";
import {
  type LoginState,
  type OAuthLoginState,
} from "../domain/oauth-login-state.js";

export class InMemoryOAuthLoginStateStore implements OAuthLoginStateStore {
  readonly rows = new Map<string, OAuthLoginState>();
  async put(attempt: OAuthLoginState): Promise<void> {
    this.rows.set(attempt.state, { ...attempt });
  }
  /**
   * Atomically mark the row used and return the original (unused)
   * snapshot. Replays return null.
   */
  async consume(state: LoginState): Promise<OAuthLoginState | null> {
    const row = this.rows.get(state);
    if (!row) return null;
    if (row.usedAt) return null;
    const snapshot = { ...row };
    row.usedAt = new Date();
    return snapshot;
  }
}
