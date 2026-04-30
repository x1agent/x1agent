import { DomainError } from "./errors.js";

/**
 * The subject of any access grant — "whom is this granted to?". Four
 * kinds, all sharing the same (kind, id?) shape:
 *
 *   user      — a single account identified by user_id
 *   group     — a group, ditto by group_id
 *   workspace — every member of the resource's workspace
 *   public    — anyone with the URL (rare; use with care)
 *
 * `user` and `group` carry an id; `workspace` and `public` don't.
 *
 * This lives in the kernel because every domain that has grants
 * (sessions, agents, future: collections, files, ...) uses it.
 */
export type SubjectKind = "user" | "group" | "workspace" | "public";

const SUBJECT_KINDS: readonly SubjectKind[] = [
  "user",
  "group",
  "workspace",
  "public",
] as const;

export function isSubjectKind(v: string): v is SubjectKind {
  return (SUBJECT_KINDS as readonly string[]).includes(v);
}

/**
 * Validated subject. Either (kind, id) when kind ∈ {user, group}, or
 * (kind, null) when kind ∈ {workspace, public}. Constructors enforce
 * the shape so downstream code can trust it.
 */
export interface UserSubject {
  kind: "user";
  id: string;
}
export interface GroupSubject {
  kind: "group";
  id: string;
}
export interface WorkspaceSubject {
  kind: "workspace";
  id: null;
}
export interface PublicSubject {
  kind: "public";
  id: null;
}
export type Subject =
  | UserSubject
  | GroupSubject
  | WorkspaceSubject
  | PublicSubject;

export class InvalidSubjectError extends DomainError {
  readonly code = "invalid_subject";
  constructor(message: string) {
    super(message);
  }
}

export function makeSubject(kind: string, id: string | null): Subject {
  if (!isSubjectKind(kind)) {
    throw new InvalidSubjectError(
      `unknown subject kind '${kind}' — expected user | group | workspace | public`,
    );
  }
  if (kind === "user" || kind === "group") {
    if (!id) {
      throw new InvalidSubjectError(`subject_kind '${kind}' requires an id`);
    }
    return { kind, id } as Subject;
  }
  if (id) {
    throw new InvalidSubjectError(
      `subject_kind '${kind}' must not carry an id (got '${id}')`,
    );
  }
  return { kind, id: null } as Subject;
}

export function subjectKey(s: Subject): string {
  return s.id ? `${s.kind}:${s.id}` : s.kind;
}
