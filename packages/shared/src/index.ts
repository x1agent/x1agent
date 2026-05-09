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
  /**
   * When false, the sidecar's git credential helper refuses to hand
   * out credentials for this repo, so `git push` (and any
   * credential-helper-driven `git fetch`) fails. The agent can still
   * read, edit, and commit locally. See migration 020 +
   * docs/security/repo-access.md.
   */
  allow_push: boolean;
}

export interface AgentReposResponse {
  installation_id: number | null;
  repos: AgentRepoAttachment[];
}

export type SessionStatus = "pending" | "running" | "complete" | "failed";
export type SessionTriggerSource = "user" | "scheduler" | "agent";

export interface SessionDTO {
  id: string;
  agent_id: string;
  triggered_by: SessionTriggerSource;
  triggered_by_user_id: string | null;
  parent_session_id: string | null;
  parent_agent_id: string | null;
  /**
   * When this session was created by resuming a terminal session,
   * points at the prior session's id. UI uses this to fetch the
   * prior event log and prepend it to the current session's events
   * with a "Session resumed" divider.
   */
  resumed_from: string | null;
  triggered_at: string;
  status: SessionStatus;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
  /**
   * LLM-generated 1-line description of what this session is doing.
   * Null when the summarizer hasn't run yet (brand-new sessions, or
   * deployments without an Anthropic key wired). UIs that show this
   * MUST fall back to a slice of `id` when null.
   */
  summary: string | null;
  /** When `summary` was last (re)generated. Null while summary is null. */
  summary_updated_at: string | null;
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
  /**
   * Populated only when the session has a parent_session_id. The agent
   * name is resolved so the UI doesn't have to chase another round-trip.
   */
  parent: {
    session_id: string;
    agent: { id: string; slug: string; name: string };
  } | null;
  /** Child sessions this session spawned. May be empty. */
  children: Array<{
    id: string;
    status: SessionStatus;
    triggered_at: string;
    agent: { id: string; slug: string; name: string };
  }>;
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

export type CollectionProviderType = "surrealdb";

export interface CollectionDTO {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  provider_type: CollectionProviderType;
  backend_handle: string;
  settings: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CollectionListResponse {
  collections: CollectionDTO[];
}

export interface CollectionResponse {
  collection: CollectionDTO;
}

export type VectorMetric = "cosine" | "l2" | "dot";

export interface CollectionVectorSettings {
  /** Length of every embedding stored in this collection. Immutable. */
  dimension: number;
  /** Distance metric used at search time. Immutable. */
  metric: VectorMetric;
}

export interface CollectionSettings {
  vector?: CollectionVectorSettings;
  /** Future: per-collection graph options, access overrides, etc. */
  [k: string]: unknown;
}

/**
 * Known embedding-model presets. Dimension is the only hard constraint
 * (has to match the model); metric is usually cosine for text models.
 */
export const EMBEDDING_PRESETS: ReadonlyArray<{
  label: string;
  dimension: number;
  description: string;
}> = [
  {
    label: "OpenAI text-embedding-3-small",
    dimension: 1536,
    description: "Default — fast, cheap, broadly used.",
  },
  {
    label: "OpenAI text-embedding-3-large",
    dimension: 3072,
    description: "Higher recall, 2× the storage.",
  },
  {
    label: "Cohere embed-english-v3",
    dimension: 1024,
    description: "Good for English-only retrieval.",
  },
  {
    label: "Voyage voyage-3",
    dimension: 1024,
    description: "Tuned for enterprise RAG.",
  },
  {
    label: "sentence-transformers/all-MiniLM-L6-v2",
    dimension: 384,
    description: "Local CPU-friendly, low fidelity.",
  },
  {
    label: "BGE base",
    dimension: 768,
    description: "Open-source baseline.",
  },
];

export interface CreateCollectionRequest {
  name: string;
  slug: string;
  description?: string | null;
  provider_type?: CollectionProviderType;
  settings?: CollectionSettings;
}

export interface AgentCollectionAttachmentDTO extends CollectionDTO {
  is_default: boolean;
}

export interface AgentCollectionListResponse {
  attachments: AgentCollectionAttachmentDTO[];
}

export interface SyncAgentCollectionsRequest {
  collection_ids: string[];
  default_collection_id: string | null;
}

export interface RecordTypeDTO {
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  fields: Array<{ name: string; type: string; required: boolean }>;
  relationships: Array<{ name: string; targetType: string; edge: string }>;
}

export interface RecordTypeListResponse {
  record_types: RecordTypeDTO[];
}

export interface RecordProvenanceDTO {
  createdBy: string;
  createdByUserId: string | null;
  confidence: number;
  source: string | null;
  derivedFrom: string[];
  createdAt: string;
}

export interface RecordDTO {
  id: string;
  recordType: string;
  data: Record<string, unknown>;
  provenance: RecordProvenanceDTO;
}

export interface RecordListResponse {
  records: RecordDTO[];
}
