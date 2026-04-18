import { ValidationError } from "./errors.js";

declare const userIdBrand: unique symbol;
declare const workspaceIdBrand: unique symbol;
declare const invitationIdBrand: unique symbol;

export type UserId = string & { readonly [userIdBrand]: true };
export type WorkspaceId = string & { readonly [workspaceIdBrand]: true };
export type InvitationId = string & { readonly [invitationIdBrand]: true };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuid(kind: string, raw: string): string {
  if (!UUID_RE.test(raw)) throw new ValidationError(kind, "must be a UUID");
  return raw.toLowerCase();
}

export const UserId = (raw: string) => asUuid("user_id", raw) as UserId;
export const WorkspaceId = (raw: string) =>
  asUuid("workspace_id", raw) as WorkspaceId;
export const InvitationId = (raw: string) =>
  asUuid("invitation_id", raw) as InvitationId;
