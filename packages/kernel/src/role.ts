import { ValidationError } from "./errors.js";

export const ROLES = ["member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

const rank: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export function Role(raw: string): Role {
  if ((ROLES as readonly string[]).includes(raw)) return raw as Role;
  throw new ValidationError("role", `must be one of ${ROLES.join(", ")}`);
}

export function satisfies(actual: Role, required: Role): boolean {
  return rank[actual] >= rank[required];
}
