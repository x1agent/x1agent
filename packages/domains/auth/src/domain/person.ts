import { ValidationError } from "@x1agent/kernel";

declare const personIdBrand: unique symbol;
export type PersonId = string & { readonly [personIdBrand]: true };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PersonId = (raw: string): PersonId => {
  if (!UUID_RE.test(raw))
    throw new ValidationError("person_id", "must be a UUID");
  return raw.toLowerCase() as PersonId;
};

/**
 * A Person represents one human. It can own one or more User identities
 * (each tied to a different Google account). Authorization is always on
 * User memberships, never on Person — the Person concept exists only to
 * power the account switcher and to prevent a human from having to
 * re-invite themselves when adding a second Google account.
 */
export interface Person {
  id: PersonId;
  displayName: string;
  createdAt: Date;
}
