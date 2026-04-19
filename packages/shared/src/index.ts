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

export interface AgentRepoAttachment {
  repo_full_name: string;
  branch: string;
  mount_path: string;
  auto_push: boolean;
}

export interface AgentReposResponse {
  installation_id: number | null;
  repos: AgentRepoAttachment[];
}

export type SessionStatus = "pending" | "running" | "complete" | "failed";
export type SessionTriggerSource = "user" | "scheduler";

export interface SessionDTO {
  id: string;
  agent_id: string;
  triggered_by: SessionTriggerSource;
  triggered_by_user_id: string | null;
  triggered_at: string;
  status: SessionStatus;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
}

export interface SessionListResponse {
  sessions: SessionDTO[];
}

export interface WorkspaceSessionRow extends SessionDTO {
  agent: { id: string; slug: string; name: string } | null;
}

export interface WorkspaceSessionListResponse {
  sessions: WorkspaceSessionRow[];
}

export interface SessionResponse {
  session: SessionDTO;
}

export interface SessionEventDTO {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  payload: unknown;
  timestamp: string;
}

export interface SessionEventListResponse {
  session: SessionDTO;
  agent: { id: string; slug: string; name: string };
  events: SessionEventDTO[];
}

export type GrantScope = "once" | "session" | "persistent";
export type GrantType = "spawn" | "tool_scope" | string;

export interface GrantDTO {
  id: string;
  workspace_id: string;
  user_subject_id: string | null;
  agent_subject_id: string | null;
  grant_type: GrantType;
  details: Record<string, unknown>;
  scope: GrantScope;
  session_id: string | null;
  consumed_at: string | null;
  revoked_at: string | null;
  granted_by_user_id: string;
  granted_at: string;
  reason: string | null;
}

export interface GrantListResponse {
  grants: GrantDTO[];
}

export interface CreateGrantRequest {
  user_subject_id?: string;
  agent_subject_id?: string;
  grant_type: GrantType;
  details: Record<string, unknown>;
  scope: GrantScope;
  session_id?: string | null;
  reason?: string | null;
}
