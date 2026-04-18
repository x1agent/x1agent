export type Role = "member" | "admin" | "owner";

export interface WorkspaceMembership {
  workspace_id: string;
  slug: string;
  name: string;
  role: Role;
}

export interface JWTPayload {
  sub: string;
  email: string;
  name: string;
  memberships: WorkspaceMembership[];
  is_platform_admin: boolean;
  iat?: number;
  exp?: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

export interface AuthMeResponse {
  user: User;
  memberships: WorkspaceMembership[];
  is_platform_admin: boolean;
}

export interface InvitationDTO {
  id: string;
  workspace_id: string;
  email: string;
  role: Role;
  token: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface InvitationListResponse {
  invitations: InvitationDTO[];
}

export interface PublicInvitationView {
  email: string;
  role: Role;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  workspace: { slug: string; name: string };
}
