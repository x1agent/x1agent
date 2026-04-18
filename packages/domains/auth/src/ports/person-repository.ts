import type { Email, UserId } from "@x1agent/kernel";
import type { Person, PersonId } from "../domain/person.js";

export interface PersonRepository {
  findById(id: PersonId): Promise<Person | null>;

  /** Create a new Person row (used when a first-time user has no person). */
  create(input: { displayName: string }): Promise<Person>;

  /** Return the user's person_id, or null if the user row has none. */
  findPersonIdForUser(userId: UserId): Promise<PersonId | null>;

  /** Return the user's person_id for an email, or null if the user doesn't exist. */
  findPersonIdForEmail(email: Email): Promise<PersonId | null>;

  /** Attach a user row to a person. Idempotent. */
  attachUser(userId: UserId, personId: PersonId): Promise<void>;

  /**
   * Detach a user from a person (during unlink). If the person ends up
   * with zero users, implementations MAY delete the person row — but
   * the domain doesn't require it.
   */
  detachUser(userId: UserId): Promise<void>;

  /** List all user ids attached to a person (for the account switcher). */
  listUsersForPerson(personId: PersonId): Promise<readonly UserId[]>;
}
