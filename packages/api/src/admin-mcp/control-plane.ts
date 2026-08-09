import {
  AgentKind,
  AgentId,
  CronSchedule,
  RuntimeType,
  parseAgentSkillSources,
  resolveAgentAccess,
  type Agent,
  type AgentGrantRepository,
  type AgentRepository,
} from "@x1agent/domain-agents";
import type {
  Attachment,
  AttachmentRepository,
  AttachmentService,
  CatalogEntry,
  CatalogService,
} from "@x1agent/domain-mcp-catalog";
import type {
  GroupRepository,
  MembershipRepository,
} from "@x1agent/domain-workspaces";
import {
  InstallationId,
  attachRepoToAgent,
  detachRepoFromAgent,
  type AgentRepoStore,
  type GitHubAppClient,
  type InstallationRepository,
} from "@x1agent/domain-github";
import {
  GrantId,
  GrantScope,
  GrantType,
  createGrant,
  revokeGrant,
  type Grant,
  type PermissionGrantRepository,
} from "@x1agent/domain-permissions";
import {
  type AgentImage,
  type ImageCatalogService,
} from "@x1agent/domain-image-catalog";
import {
  PreviewEnvironmentId,
  type PreviewEnvironment,
  type PreviewEnvironmentRepository,
} from "@x1agent/domain-preview-environments";
import {
  CollectionId,
  type CollectionRepository,
} from "@x1agent/domain-collections";
import type { AdminMcpCollectionControl } from "./collection-control.js";
import type { AdminMcpContextFileControl } from "./context-file-control.js";
import type { AdminMcpOciImageControl } from "./oci-image-control.js";
import {
  downloadShareFromGcs,
  getMimeType,
  readShareFile,
} from "../shares/storage.js";
import {
  SessionId,
  resolveSessionVisibility,
  type PlatformAdminGuard,
  type Session,
  type SessionEventRepository,
  type SessionRepository,
  type SessionShareRepository,
  type TokenUsageRepository,
  type TokenUsageTotals,
  type JobTerminator,
} from "@x1agent/domain-sessions";
import {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import type { OAuthPrincipal } from "./oauth-store.js";
import type {
  AdminMcpWorkspace,
  AdminMcpWorkspaceReader,
} from "./workspace-reader.js";
import {
  adminMcpRequestHash,
  type AdminMcpOperationStore,
} from "./operation-store.js";

export class AdminMcpOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface AgentListInput {
  workspace: string;
  kind?: "worker" | "orchestrator" | "scheduled";
  runtime?: string;
  active?: boolean;
  owner?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

export interface AgentReferenceInput {
  workspace: string;
  agent: string;
}

export interface AgentCreateInput {
  workspace: string;
  idempotency_key: string;
  slug: string;
  name: string;
  runtime_type?: string;
  kind?: "worker" | "orchestrator" | "scheduled";
  system_prompt?: string;
  heartbeat_md?: string;
  schedule?: string | null;
  image_id?: string | null;
  model?: string | null;
  visibility?: "private" | "workspace" | "via_grants";
  scheduled_run_as_user_id?: string | null;
  idle_timeout_seconds?: number | null;
  skill_sources?: unknown;
}

export interface AgentUpdateInput extends AgentReferenceInput {
  expected_updated_at: string;
  name?: string;
  runtime_type?: string;
  kind?: "worker" | "orchestrator" | "scheduled";
  system_prompt?: string;
  heartbeat_md?: string;
  schedule?: string | null;
  is_active?: boolean;
  image_id?: string | null;
  model?: string | null;
  owner_user_id?: string | null;
  visibility?: "private" | "workspace" | "via_grants";
  scheduled_run_as_user_id?: string | null;
  idle_timeout_seconds?: number | null;
  skill_sources?: unknown;
}

export interface AgentDeleteInput extends AgentReferenceInput {
  confirm_id: string;
}

export interface McpConfigurationReferenceInput {
  workspace: string;
  mcp_configuration: string;
}

export interface McpConfigurationSetInput {
  workspace: string;
  mcp_configuration?: string;
  name?: string;
  display_name?: string | null;
  kind?: "stdio" | "remote_oauth";
  image?: string | null;
  command?: string | null;
  args?: string[];
  url?: string | null;
  manifest?: unknown;
  description?: string;
  expected_updated_at?: string;
}

export interface McpAttachmentSetInput extends AgentReferenceInput {
  mcp_configuration: string;
  environment?: Record<string, unknown>;
  tool_scopes?: string[];
}

export interface McpAttachmentRemoveInput extends AgentReferenceInput {
  attachment: string;
}

export interface RepositoryInstallationInput {
  workspace: string;
  installation_id: number;
}

export interface AgentRepositoryAttachInput extends AgentReferenceInput {
  installation_id: number;
  repo_full_name: string;
  branch?: string;
  mount_path?: string;
  auto_push?: boolean;
  allow_push?: boolean;
}

export interface AgentRepositoryUpdateInput extends AgentReferenceInput {
  repo_full_name: string;
  branch?: string;
  mount_path?: string;
  auto_push?: boolean;
  allow_push?: boolean;
}

export interface AgentRepositoryDetachInput extends AgentReferenceInput {
  repo_full_name: string;
}

export interface SpawnGrantCreateInput extends AgentReferenceInput {
  child_agent: string;
  allowed_runtime_types?: string[];
  allowed_models?: string[];
  reason?: string | null;
}

export interface SpawnGrantRevokeInput extends AgentReferenceInput {
  grant: string;
}

export interface WorkerImageCreateInput {
  workspace: string;
  idempotency_key: string;
  name: string;
  display_name: string;
  description?: string | null;
  dockerfile_source: string;
}

export interface WorkerImageUpdateInput {
  workspace: string;
  image: string;
  display_name?: string;
  description?: string | null;
  dockerfile_source?: string;
}

export interface WorkerImageRegisterOciInput {
  workspace: string;
  idempotency_key: string;
  name: string;
  display_name: string;
  description?: string | null;
  oci_reference: string;
}

export interface CollectionCreateInput {
  workspace: string;
  idempotency_key: string;
  name: string;
  slug: string;
  description?: string | null;
  provider_type?: string;
  settings?: Record<string, unknown>;
}

export interface CollectionUpdateInput {
  workspace: string;
  collection: string;
  expected_updated_at: string;
  name?: string;
  description?: string | null;
  settings?: Record<string, unknown>;
}

export interface AgentCollectionsSetInput extends AgentReferenceInput {
  expected_agent_updated_at: string;
  collection_ids: string[];
  default_collection_id?: string | null;
}

export interface SessionListInput extends AgentReferenceInput {
  limit?: number;
  cursor?: string;
}

export interface ContextFilePutInput extends AgentReferenceInput {
  path: string;
  mime_type: string;
  content: string;
  expected_revision?: number | null;
}

export interface SessionTriggerInput extends AgentReferenceInput {
  idempotency_key: string;
  task: string;
  runtime_type?: string;
  model?: string;
}

export interface AdminMcpControlPlane {
  listAgents(
    principal: OAuthPrincipal,
    input: AgentListInput,
  ): Promise<Record<string, unknown>>;
  getAgent(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ): Promise<Record<string, unknown>>;
  createAgent(
    principal: OAuthPrincipal,
    input: AgentCreateInput,
  ): Promise<Record<string, unknown>>;
  updateAgent(
    principal: OAuthPrincipal,
    input: AgentUpdateInput,
  ): Promise<Record<string, unknown>>;
  deleteAgent(
    principal: OAuthPrincipal,
    input: AgentDeleteInput,
  ): Promise<Record<string, unknown>>;
  listMcpConfigurations(
    principal: OAuthPrincipal,
    input: { workspace: string },
  ): Promise<Record<string, unknown>>;
  getMcpConfiguration(
    principal: OAuthPrincipal,
    input: McpConfigurationReferenceInput,
  ): Promise<Record<string, unknown>>;
  setMcpConfiguration(
    principal: OAuthPrincipal,
    input: McpConfigurationSetInput,
  ): Promise<Record<string, unknown>>;
  deleteMcpConfiguration(
    principal: OAuthPrincipal,
    input: McpConfigurationReferenceInput,
  ): Promise<Record<string, unknown>>;
  listMcpAttachments(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ): Promise<Record<string, unknown>>;
  setMcpAttachment(
    principal: OAuthPrincipal,
    input: McpAttachmentSetInput,
  ): Promise<Record<string, unknown>>;
  removeMcpAttachment(
    principal: OAuthPrincipal,
    input: McpAttachmentRemoveInput,
  ): Promise<Record<string, unknown>>;
  listRepositoryInstallations(
    principal: OAuthPrincipal,
    input: { workspace: string },
  ): Promise<Record<string, unknown>>;
  listAvailableRepositories(
    principal: OAuthPrincipal,
    input: RepositoryInstallationInput,
  ): Promise<Record<string, unknown>>;
  listAgentRepositories(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ): Promise<Record<string, unknown>>;
  attachAgentRepository(
    principal: OAuthPrincipal,
    input: AgentRepositoryAttachInput,
  ): Promise<Record<string, unknown>>;
  updateAgentRepository(
    principal: OAuthPrincipal,
    input: AgentRepositoryUpdateInput,
  ): Promise<Record<string, unknown>>;
  detachAgentRepository(
    principal: OAuthPrincipal,
    input: AgentRepositoryDetachInput,
  ): Promise<Record<string, unknown>>;
  listSpawnGrants(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ): Promise<Record<string, unknown>>;
  createSpawnGrant(
    principal: OAuthPrincipal,
    input: SpawnGrantCreateInput,
  ): Promise<Record<string, unknown>>;
  revokeSpawnGrant(
    principal: OAuthPrincipal,
    input: SpawnGrantRevokeInput,
  ): Promise<Record<string, unknown>>;
  listWorkerImages(
    principal: OAuthPrincipal,
    input: { workspace: string },
  ): Promise<Record<string, unknown>>;
  getWorkerImage(
    principal: OAuthPrincipal,
    input: { workspace: string; image: string },
  ): Promise<Record<string, unknown>>;
  createWorkerImage(
    principal: OAuthPrincipal,
    input: WorkerImageCreateInput,
  ): Promise<Record<string, unknown>>;
  registerOciWorkerImage(
    principal: OAuthPrincipal,
    input: WorkerImageRegisterOciInput,
  ): Promise<Record<string, unknown>>;
  updateWorkerImage(
    principal: OAuthPrincipal,
    input: WorkerImageUpdateInput,
  ): Promise<Record<string, unknown>>;
  rebuildWorkerImage(
    principal: OAuthPrincipal,
    input: { workspace: string; image: string },
  ): Promise<Record<string, unknown>>;
  deleteWorkerImage(
    principal: OAuthPrincipal,
    input: { workspace: string; image: string; confirm_id: string },
  ): Promise<Record<string, unknown>>;
  listPreviewEnvironments(
    principal: OAuthPrincipal,
    input: { workspace: string },
  ): Promise<Record<string, unknown>>;
  getPreviewEnvironment(
    principal: OAuthPrincipal,
    input: { workspace: string; preview_environment: string },
  ): Promise<Record<string, unknown>>;
  listCollections(
    principal: OAuthPrincipal,
    input: { workspace: string },
  ): Promise<Record<string, unknown>>;
  getCollection(
    principal: OAuthPrincipal,
    input: { workspace: string; collection: string },
  ): Promise<Record<string, unknown>>;
  createCollection(
    principal: OAuthPrincipal,
    input: CollectionCreateInput,
  ): Promise<Record<string, unknown>>;
  updateCollection(
    principal: OAuthPrincipal,
    input: CollectionUpdateInput,
  ): Promise<Record<string, unknown>>;
  deleteCollection(
    principal: OAuthPrincipal,
    input: { workspace: string; collection: string; confirm_id: string },
  ): Promise<Record<string, unknown>>;
  retryCollectionProvision(
    principal: OAuthPrincipal,
    input: { workspace: string; collection: string },
  ): Promise<Record<string, unknown>>;
  listAgentCollections(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ): Promise<Record<string, unknown>>;
  setAgentCollections(
    principal: OAuthPrincipal,
    input: AgentCollectionsSetInput,
  ): Promise<Record<string, unknown>>;
  listSessions(
    principal: OAuthPrincipal,
    input: SessionListInput,
  ): Promise<Record<string, unknown>>;
  getSession(
    principal: OAuthPrincipal,
    input: { workspace: string; session: string },
  ): Promise<Record<string, unknown>>;
  listSessionEvents(
    principal: OAuthPrincipal,
    input: {
      workspace: string;
      session: string;
      after_seq?: number;
      limit?: number;
    },
  ): Promise<Record<string, unknown>>;
  getSessionCost(
    principal: OAuthPrincipal,
    input: { workspace: string; session: string },
  ): Promise<Record<string, unknown>>;
  getSessionTreeCost(
    principal: OAuthPrincipal,
    input: { workspace: string; session: string },
  ): Promise<Record<string, unknown>>;
  getAgentCost(
    principal: OAuthPrincipal,
    input: {
      workspace: string;
      agent: string;
      window?: "24h" | "7d" | "30d" | "all";
    },
  ): Promise<Record<string, unknown>>;
  getWorkspaceCost(
    principal: OAuthPrincipal,
    input: { workspace: string; since: string; until: string },
  ): Promise<Record<string, unknown>>;
  listArtifacts(
    principal: OAuthPrincipal,
    input: { workspace: string; session: string; limit?: number },
  ): Promise<Record<string, unknown>>;
  readArtifact(
    principal: OAuthPrincipal,
    input: {
      workspace: string;
      session: string;
      share: string;
      path?: string;
    },
  ): Promise<Record<string, unknown>>;
  inspectAgentContext(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ): Promise<Record<string, unknown>>;
  listContextFiles(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ): Promise<Record<string, unknown>>;
  getContextFile(
    principal: OAuthPrincipal,
    input: AgentReferenceInput & { path: string },
  ): Promise<Record<string, unknown>>;
  putContextFile(
    principal: OAuthPrincipal,
    input: ContextFilePutInput,
  ): Promise<Record<string, unknown>>;
  deleteContextFile(
    principal: OAuthPrincipal,
    input: AgentReferenceInput & { path: string },
  ): Promise<Record<string, unknown>>;
  validateAgentConfiguration(
    principal: OAuthPrincipal,
    input: AgentReferenceInput & { proposed?: Record<string, unknown> },
  ): Promise<Record<string, unknown>>;
  triggerValidationSession(
    principal: OAuthPrincipal,
    input: SessionTriggerInput,
  ): Promise<Record<string, unknown>>;
  cancelValidationSession(
    principal: OAuthPrincipal,
    input: { workspace: string; session: string },
  ): Promise<Record<string, unknown>>;
}

export interface AdminMcpControlPlaneDeps {
  workspaces: AdminMcpWorkspaceReader;
  agents: AgentRepository;
  agentGrants: AgentGrantRepository;
  groups: GroupRepository;
  memberships: MembershipRepository;
  catalog: CatalogService;
  attachments: AttachmentService;
  attachmentRepository: AttachmentRepository;
  installations: InstallationRepository;
  githubClient: GitHubAppClient | null;
  agentRepos: AgentRepoStore;
  permissionGrants: PermissionGrantRepository;
  operationStore: AdminMcpOperationStore;
  imageCatalog: ImageCatalogService;
  previewEnvironments: PreviewEnvironmentRepository;
  collectionControl: AdminMcpCollectionControl;
  collections: CollectionRepository;
  sessions: SessionRepository;
  sessionEvents: SessionEventRepository;
  sessionShares: SessionShareRepository;
  platformAdminGuard: PlatformAdminGuard;
  agentCollaborateResolver: (
    actor: UserId,
    agentId: string,
  ) => Promise<boolean>;
  tokenUsage: TokenUsageRepository;
  artifactsBucket?: string;
  contextFiles: AdminMcpContextFileControl;
  jobTerminator?: JobTerminator;
  ociImages: AdminMcpOciImageControl;
}

function serializeGrant(grant: Grant): Record<string, unknown> {
  return {
    id: grant.id,
    workspace_id: grant.workspaceId,
    subject: grant.subject,
    grant_type: grant.grantType,
    details: grant.details,
    scope: grant.scope,
    session_id: grant.sessionId,
    consumed_at: grant.consumedAt?.toISOString() ?? null,
    revoked_at: grant.revokedAt?.toISOString() ?? null,
    granted_by_user_id: grant.grantedByUserId,
    granted_at: grant.grantedAt.toISOString(),
    reason: grant.reason,
  };
}

function serializeWorkerImage(image: AgentImage): Record<string, unknown> {
  return {
    id: image.id,
    workspace_id: image.workspaceId,
    name: image.name,
    display_name: image.displayName,
    description: image.description,
    built_ref: image.builtRef,
    is_preset: image.isPreset,
    dockerfile_source: image.dockerfileSource,
    status: image.buildStatus,
    status_reason:
      image.buildStatus === "failed" ? image.buildLog.slice(-2000) : null,
    last_built_at: image.lastBuiltAt?.toISOString() ?? null,
    created_at: image.createdAt.toISOString(),
    updated_at: image.updatedAt.toISOString(),
    poll_after_seconds:
      image.buildStatus === "pending" || image.buildStatus === "building"
        ? 5
        : null,
    source_kind: image.sourceKind ?? (image.isPreset ? "preset" : "workspace_build"),
    requested_ref: image.requestedRef ?? null,
    resolved_digest_ref: image.resolvedDigestRef ?? null,
    created_by: image.createdBy ?? null,
  };
}

function serializePreviewEnvironment(
  preview: PreviewEnvironment,
): Record<string, unknown> {
  return {
    id: preview.id,
    workspace_id: preview.workspaceId,
    slug: preview.slug,
    title: preview.title,
    repo_full_name: preview.repoFullName,
    branch: preview.branch,
    last_deploy_sha: preview.lastDeploySha,
    url: preview.lastDeployUrl,
    image_ref: preview.lastDeployImageRef,
    status: preview.lastDeployStatus,
    status_reason: preview.lastDeployStatusReason,
    last_deploy_at: preview.lastDeployAt?.toISOString() ?? null,
    created_at: preview.createdAt.toISOString(),
    updated_at: preview.updatedAt.toISOString(),
  };
}

function serializeSession(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    agent_id: session.agentId,
    triggered_by: session.triggeredBy,
    triggered_by_user_id: session.triggeredByUserId,
    parent_session_id: session.parentSessionId,
    parent_agent_id: session.parentAgentId,
    resumed_from_session_id: session.resumedFromSessionId,
    triggered_at: session.triggeredAt.toISOString(),
    status: session.status,
    completed_at: session.completedAt?.toISOString() ?? null,
    error_message: session.errorMessage,
    summary: session.summary,
    model_override: session.modelOverride,
    runtime_override: session.runtimeOverride ?? null,
    validation_run: session.validationRun ?? false,
    effective_runtime_type: session.effectiveRuntimeType ?? null,
    effective_model: session.effectiveModel ?? null,
    effective_image_ref: session.effectiveImageRef ?? null,
    agent_configuration_revision:
      session.agentConfigurationRevision?.toISOString() ?? null,
    created_at: session.createdAt.toISOString(),
  };
}

function emptyCostTotals(): TokenUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsdEstimate: 0,
    cacheSavingsUsdEstimate: 0,
  };
}

function addCostTotals(target: TokenUsageTotals, source: TokenUsageTotals) {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.costUsdEstimate += source.costUsdEstimate;
  target.cacheSavingsUsdEstimate =
    (target.cacheSavingsUsdEstimate ?? 0) +
    (source.cacheSavingsUsdEstimate ?? 0);
}

function costEnvelope(payload: Record<string, unknown>) {
  return {
    currency: "USD",
    estimate: true,
    pricing_version: "repository-static-v1",
    infrastructure_cost_included: false,
    third_party_api_cost_included: false,
    data_fresh_through: new Date().toISOString(),
    ...payload,
  };
}

function eventPayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function isWorkspaceAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}

function serializeAgent(agent: Agent): Record<string, unknown> {
  return {
    id: agent.id,
    workspace_id: agent.workspaceId,
    slug: agent.slug,
    name: agent.name,
    runtime_type: agent.runtimeType,
    kind: agent.kind,
    system_prompt: agent.systemPrompt,
    heartbeat_md: agent.heartbeatMd,
    schedule: agent.schedule,
    is_active: agent.isActive,
    image_id: agent.imageId,
    model: agent.model,
    owner_user_id: agent.ownerUserId,
    visibility: agent.visibility,
    scheduled_run_as_user_id: agent.scheduledRunAsUserId,
    idle_timeout_seconds: agent.idleTimeoutSeconds,
    skill_sources: agent.skillSources,
    created_by: agent.createdBy,
    created_at: agent.createdAt.toISOString(),
    updated_at: agent.updatedAt.toISOString(),
    configuration_revision: agent.updatedAt.toISOString(),
  };
}

const SENSITIVE_ARGUMENT = /(token|secret|password|api[-_]?key|authorization|credential)/i;

function redactCommandArgs(args: readonly string[]): string[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return "[redacted]";
    }
    const equalsAt = arg.indexOf("=");
    if (equalsAt > 0 && SENSITIVE_ARGUMENT.test(arg.slice(0, equalsAt))) {
      return `${arg.slice(0, equalsAt + 1)}[redacted]`;
    }
    if (arg.startsWith("-") && SENSITIVE_ARGUMENT.test(arg)) {
      redactNext = true;
    }
    return arg;
  });
}

function redactRemoteUrl(value: string | null): string | null {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.username) url.username = "redacted";
    if (url.password) url.password = "redacted";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_ARGUMENT.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return "[redacted-invalid-url]";
  }
}

function serializeCatalogEntry(entry: CatalogEntry): Record<string, unknown> {
  return {
    id: entry.id,
    workspace_id: entry.workspaceId,
    name: entry.name,
    display_name: entry.displayName,
    kind: entry.kind,
    image: entry.image,
    command: entry.command,
    args: redactCommandArgs(entry.args),
    url: redactRemoteUrl(entry.url),
    manifest: entry.manifest,
    description: entry.description,
    created_by: entry.createdBy,
    created_at: entry.createdAt.toISOString(),
    updated_at: entry.updatedAt.toISOString(),
  };
}

function serializeAttachment(attachment: Attachment): Record<string, unknown> {
  return {
    id: attachment.id,
    agent_id: attachment.agentId,
    catalog_entry_id: attachment.catalogEntryId,
    environment: Object.fromEntries(
      Object.entries(attachment.envJson).map(([name, value]) => [
        name,
        value.kind === "secret"
          ? { kind: "secret", ref: value.ref }
          : { kind: "value", value: "[redacted]" },
      ]),
    ),
    tool_scopes: attachment.toolScopesGranted,
    created_by: attachment.createdBy,
    created_at: attachment.createdAt.toISOString(),
    updated_at: attachment.updatedAt.toISOString(),
  };
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new AdminMcpOperationError(
      "validation_error",
      "limit must be an integer between 1 and 100",
      { field: "limit" },
    );
  }
  return value;
}

export class DefaultAdminMcpControlPlane implements AdminMcpControlPlane {
  constructor(private readonly deps: AdminMcpControlPlaneDeps) {}

  private async workspace(
    principal: OAuthPrincipal,
    slug: string,
  ): Promise<AdminMcpWorkspace> {
    const workspace = await this.deps.workspaces.getForUser(
      principal.userId,
      slug,
    );
    if (!workspace) {
      throw new AdminMcpOperationError(
        "not_found",
        `workspace not found: ${slug}`,
      );
    }
    return workspace;
  }

  private async agentAccess(
    principal: OAuthPrincipal,
    workspace: AdminMcpWorkspace,
    agentId: string,
  ) {
    const candidate = await this.deps.agents.findById(AgentId(agentId));
    if (!candidate || String(candidate.workspaceId) !== workspace.id) {
      throw new AdminMcpOperationError(
        "not_found",
        `agent not found: ${agentId}`,
      );
    }
    const groupIds = await this.deps.groups.listGroupIdsForUser(
      WorkspaceId(workspace.id),
      UserId(principal.userId),
    );
    const access = await resolveAgentAccess(
      { agents: this.deps.agents, grants: this.deps.agentGrants },
      candidate.id,
      UserId(principal.userId),
      {
        userGroupIds: groupIds,
        isWorkspaceMember: true,
        isWorkspaceAdmin: isWorkspaceAdmin(workspace.role),
      },
    );
    return { candidate, access };
  }

  private async sessionAccess(
    principal: OAuthPrincipal,
    workspace: AdminMcpWorkspace,
    sessionId: string,
  ): Promise<Session> {
    const session = await this.deps.sessions.findById(SessionId(sessionId));
    if (!session) {
      throw new AdminMcpOperationError("not_found", "session not found");
    }
    const { candidate, access } = await this.agentAccess(
      principal,
      workspace,
      String(session.agentId),
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "session not found");
    }
    const visibility = await resolveSessionVisibility(
      {
        platformAdminGuard: this.deps.platformAdminGuard,
        shares: this.deps.sessionShares,
        agentCollaborateResolver: this.deps.agentCollaborateResolver,
      },
      UserId(principal.userId),
      session,
      candidate.workspaceId,
    );
    if (!visibility.visible) {
      throw new AdminMcpOperationError("not_found", "session not found");
    }
    return session;
  }

  private assertWorkspaceAdmin(workspace: AdminMcpWorkspace): void {
    if (!isWorkspaceAdmin(workspace.role)) {
      throw new AdminMcpOperationError(
        "forbidden",
        "workspace owner or administrator access is required",
      );
    }
  }

  private async assertWorkerImageInWorkspace(
    workspace: AdminMcpWorkspace,
    imageId: string | null | undefined,
  ): Promise<void> {
    if (!imageId) return;
    try {
      await this.deps.imageCatalog.get(workspace.id, imageId);
    } catch {
      throw new AdminMcpOperationError(
        "not_found",
        "worker image not found",
      );
    }
  }

  async listAgents(principal: OAuthPrincipal, input: AgentListInput) {
    const workspace = await this.workspace(principal, input.workspace);
    const groupIds = await this.deps.groups.listGroupIdsForUser(
      WorkspaceId(workspace.id),
      UserId(principal.userId),
    );
    const visible = await this.deps.agents.listAccessibleByWorkspace({
      workspaceId: WorkspaceId(workspace.id),
      userId: UserId(principal.userId),
      userGroupIds: groupIds,
      isWorkspaceAdmin: isWorkspaceAdmin(workspace.role),
    });
    const search = input.search?.trim().toLowerCase();
    const filtered = visible
      .filter((agent) => !input.kind || agent.kind === input.kind)
      .filter((agent) => !input.runtime || agent.runtimeType === input.runtime)
      .filter(
        (agent) => input.active === undefined || agent.isActive === input.active,
      )
      .filter(
        (agent) => !input.owner || String(agent.ownerUserId) === input.owner,
      )
      .filter(
        (agent) =>
          !search ||
          agent.name.toLowerCase().includes(search) ||
          String(agent.slug).toLowerCase().includes(search),
      )
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const after = input.cursor
      ? filtered.findIndex((agent) => String(agent.id) === input.cursor) + 1
      : 0;
    const limit = pageLimit(input.limit);
    const page = filtered.slice(after, after + limit);
    return {
      agents: page.map(serializeAgent),
      next_cursor:
        after + page.length < filtered.length
          ? String(page.at(-1)?.id ?? "")
          : null,
    };
  }

  async getAgent(principal: OAuthPrincipal, input: AgentReferenceInput) {
    const workspace = await this.workspace(principal, input.workspace);
    const { candidate, access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "agent not found");
    }
    return { agent: serializeAgent(candidate) };
  }

  async createAgent(principal: OAuthPrincipal, input: AgentCreateInput) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    if (!input.idempotency_key.trim() || input.idempotency_key.length > 200) {
      throw new AdminMcpOperationError(
        "validation_error",
        "idempotency_key is required and must be at most 200 characters",
        { field: "idempotency_key" },
      );
    }
    const claim = await this.deps.operationStore.claim({
      principal,
      toolName: "agents.create",
      idempotencyKey: input.idempotency_key,
      requestHash: adminMcpRequestHash(input),
    });
    if (claim.kind === "conflict") {
      throw new AdminMcpOperationError(
        "idempotency_conflict",
        "idempotency_key was already used with different input",
      );
    }
    if (claim.kind === "in_progress") {
      throw new AdminMcpOperationError(
        "conflict",
        "an operation with this idempotency_key is still in progress",
        { retryable: true },
      );
    }
    if (claim.kind === "replay") return { ...claim.result, replayed: true };
    try {
      const created = await this.createAgentAfterClaim(principal, workspace, input);
      const agent = created.agent as Record<string, unknown>;
      await this.deps.operationStore.complete({
        principal,
        toolName: "agents.create",
        idempotencyKey: input.idempotency_key,
        resourceId: typeof agent.id === "string" ? agent.id : undefined,
        result: created,
      });
      return created;
    } catch (error) {
      await this.deps.operationStore.fail({
        principal,
        toolName: "agents.create",
        idempotencyKey: input.idempotency_key,
      });
      throw error;
    }
  }

  private async createAgentAfterClaim(
    principal: OAuthPrincipal,
    workspace: AdminMcpWorkspace,
    input: AgentCreateInput,
  ) {
    const workspaceId = WorkspaceId(workspace.id);
    await this.assertWorkerImageInWorkspace(workspace, input.image_id);
    const slug = WorkspaceSlug(input.slug);
    const existing = await this.deps.agents.findBySlug(workspaceId, slug);
    if (existing) {
      throw new AdminMcpOperationError(
        "agent_slug_taken",
        `an agent with slug ${input.slug} already exists in this workspace`,
      );
    }
    const runAs =
      input.scheduled_run_as_user_id === undefined
        ? principal.userId
        : input.scheduled_run_as_user_id;
    if (runAs !== null) {
      const membership = await this.deps.memberships.findByUserAndWorkspace(
        UserId(runAs),
        workspaceId,
      );
      if (!membership) {
        throw new AdminMcpOperationError(
          "scheduled_run_as_user_not_in_workspace",
          "scheduled_run_as_user_id must be a current workspace member",
        );
      }
    }
    const idleTimeout = input.idle_timeout_seconds;
    if (
      idleTimeout !== undefined &&
      idleTimeout !== null &&
      (!Number.isInteger(idleTimeout) || idleTimeout < 30 || idleTimeout > 604800)
    ) {
      throw new AdminMcpOperationError(
        "validation_error",
        "idle_timeout_seconds must be between 30 and 604800",
        { field: "idle_timeout_seconds" },
      );
    }
    const agent = await this.deps.agents.create({
      workspaceId,
      slug,
      name: input.name.trim(),
      runtimeType: RuntimeType(input.runtime_type ?? "claude_code"),
      kind: AgentKind(input.kind ?? "worker"),
      systemPrompt: input.system_prompt ?? "",
      heartbeatMd: input.heartbeat_md ?? "",
      schedule:
        input.schedule === undefined || input.schedule === null
          ? null
          : CronSchedule(input.schedule),
      imageId: input.image_id ?? null,
      model: input.model ?? null,
      visibility: input.visibility ?? "workspace",
      scheduledRunAsUserId: runAs ? UserId(runAs) : null,
      idleTimeoutSeconds: idleTimeout ?? null,
      skillSources: parseAgentSkillSources(input.skill_sources),
      createdBy: UserId(principal.userId),
    });
    return { agent: serializeAgent(agent), replayed: false };
  }

  async updateAgent(principal: OAuthPrincipal, input: AgentUpdateInput) {
    const workspace = await this.workspace(principal, input.workspace);
    const { candidate, access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canEdit) {
      throw new AdminMcpOperationError(
        "forbidden",
        "edit access to this agent is required",
      );
    }
    if (candidate.updatedAt.toISOString() !== input.expected_updated_at) {
      throw new AdminMcpOperationError(
        "revision_conflict",
        "agent configuration changed after it was read",
        { current_updated_at: candidate.updatedAt.toISOString() },
      );
    }
    await this.assertWorkerImageInWorkspace(workspace, input.image_id);
    if (
      input.owner_user_id !== undefined &&
      !isWorkspaceAdmin(workspace.role)
    ) {
      throw new AdminMcpOperationError(
        "forbidden",
        "only workspace owners and administrators can change agent ownership",
      );
    }
    const memberIds = [input.owner_user_id, input.scheduled_run_as_user_id].filter(
      (value): value is string => typeof value === "string",
    );
    for (const userId of memberIds) {
      const membership = await this.deps.memberships.findByUserAndWorkspace(
        UserId(userId),
        WorkspaceId(workspace.id),
      );
      if (!membership) {
        throw new AdminMcpOperationError(
          "user_not_in_workspace",
          `user is not a member of workspace: ${userId}`,
        );
      }
    }
    const idleTimeout = input.idle_timeout_seconds;
    if (
      idleTimeout !== undefined &&
      idleTimeout !== null &&
      (!Number.isInteger(idleTimeout) || idleTimeout < 30 || idleTimeout > 604800)
    ) {
      throw new AdminMcpOperationError(
        "validation_error",
        "idle_timeout_seconds must be between 30 and 604800",
        { field: "idle_timeout_seconds" },
      );
    }
    const updated = await this.deps.agents.update(candidate.id, {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.runtime_type !== undefined && {
        runtimeType: RuntimeType(input.runtime_type),
      }),
      ...(input.kind !== undefined && { kind: AgentKind(input.kind) }),
      ...(input.system_prompt !== undefined && {
        systemPrompt: input.system_prompt,
      }),
      ...(input.heartbeat_md !== undefined && {
        heartbeatMd: input.heartbeat_md,
      }),
      ...(input.schedule !== undefined && {
        schedule: input.schedule === null ? null : CronSchedule(input.schedule),
      }),
      ...(input.is_active !== undefined && { isActive: input.is_active }),
      ...(input.image_id !== undefined && { imageId: input.image_id }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.owner_user_id !== undefined && {
        ownerUserId: input.owner_user_id ? UserId(input.owner_user_id) : null,
      }),
      ...(input.visibility !== undefined && { visibility: input.visibility }),
      ...(input.scheduled_run_as_user_id !== undefined && {
        scheduledRunAsUserId: input.scheduled_run_as_user_id
          ? UserId(input.scheduled_run_as_user_id)
          : null,
      }),
      ...(idleTimeout !== undefined && { idleTimeoutSeconds: idleTimeout }),
      ...(input.skill_sources !== undefined && {
        skillSources: parseAgentSkillSources(input.skill_sources),
      }),
    });
    return { agent: serializeAgent(updated) };
  }

  async deleteAgent(principal: OAuthPrincipal, input: AgentDeleteInput) {
    const workspace = await this.workspace(principal, input.workspace);
    const { candidate, access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canEdit) {
      throw new AdminMcpOperationError(
        "forbidden",
        "edit access to this agent is required",
      );
    }
    if (input.confirm_id !== input.agent) {
      throw new AdminMcpOperationError(
        "confirmation_required",
        "confirm_id must exactly match the agent ID",
      );
    }
    await this.deps.agents.delete(candidate.id);
    return { deleted: true, agent_id: input.agent };
  }

  async listMcpConfigurations(
    principal: OAuthPrincipal,
    input: { workspace: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const rows = await this.deps.catalog.list(workspace.id);
    return { mcp_configurations: rows.map(serializeCatalogEntry) };
  }

  async getMcpConfiguration(
    principal: OAuthPrincipal,
    input: McpConfigurationReferenceInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const entry = await this.deps.catalog.get(
      workspace.id,
      input.mcp_configuration,
    );
    if (!entry) {
      throw new AdminMcpOperationError(
        "not_found",
        `MCP configuration not found: ${input.mcp_configuration}`,
      );
    }
    return { mcp_configuration: serializeCatalogEntry(entry) };
  }

  async setMcpConfiguration(
    principal: OAuthPrincipal,
    input: McpConfigurationSetInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const current = input.mcp_configuration
      ? await this.deps.catalog.get(workspace.id, input.mcp_configuration)
      : null;
    if (input.mcp_configuration && !current) {
      throw new AdminMcpOperationError(
        "not_found",
        `MCP configuration not found: ${input.mcp_configuration}`,
      );
    }
    if (
      current &&
      input.expected_updated_at !== current.updatedAt.toISOString()
    ) {
      throw new AdminMcpOperationError(
        "revision_conflict",
        "MCP configuration changed after it was read",
        { current_updated_at: current.updatedAt.toISOString() },
      );
    }
    const entry = await this.deps.catalog.set({
      workspaceId: workspace.id,
      name: current ? String(current.name) : String(input.name ?? ""),
      displayName:
        input.display_name === undefined
          ? current?.displayName
          : input.display_name,
      kind: input.kind ?? current?.kind,
      image: input.image === undefined ? current?.image : input.image,
      command: input.command === undefined ? current?.command : input.command,
      args: input.args ?? current?.args,
      url: input.url === undefined ? current?.url : input.url,
      manifest: input.manifest ?? current?.manifest ?? {},
      description: input.description ?? current?.description ?? "",
      createdBy: principal.userId,
    });
    return { mcp_configuration: serializeCatalogEntry(entry) };
  }

  async deleteMcpConfiguration(
    principal: OAuthPrincipal,
    input: McpConfigurationReferenceInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const entry = await this.deps.catalog.get(
      workspace.id,
      input.mcp_configuration,
    );
    if (!entry) return { deleted: false };
    const references = await this.deps.attachmentRepository.countByCatalogEntry(
      entry.id,
    );
    if (references > 0) {
      throw new AdminMcpOperationError(
        "mcp_configuration_in_use",
        "MCP configuration is attached to one or more agents",
        { attachment_count: references },
      );
    }
    return {
      deleted: await this.deps.catalog.delete(workspace.id, entry.id),
    };
  }

  async listMcpAttachments(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "agent not found");
    }
    const rows = await this.deps.attachments.list(input.agent);
    return { attachments: rows.map(serializeAttachment) };
  }

  async setMcpAttachment(
    principal: OAuthPrincipal,
    input: McpAttachmentSetInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { candidate, access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canEdit) {
      throw new AdminMcpOperationError(
        "forbidden",
        "edit access to this agent is required",
      );
    }
    const attachment = await this.deps.attachments.attach({
      agentId: String(candidate.id),
      workspaceId: workspace.id,
      catalogEntryId: input.mcp_configuration,
      envJson: input.environment ?? {},
      toolScopesGranted: input.tool_scopes,
      createdBy: principal.userId,
      agentKind: candidate.kind,
      workspaceAllowsOauthOnNonWorkers:
        workspace.oauthMcpsOnOrchestrators !== "off",
    });
    return { attachment: serializeAttachment(attachment) };
  }

  async removeMcpAttachment(
    principal: OAuthPrincipal,
    input: McpAttachmentRemoveInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canEdit) {
      throw new AdminMcpOperationError(
        "forbidden",
        "edit access to this agent is required",
      );
    }
    return {
      removed: await this.deps.attachments.detach(
        input.agent,
        input.attachment,
      ),
    };
  }

  async listRepositoryInstallations(
    principal: OAuthPrincipal,
    input: { workspace: string },
  ) {
    await this.workspace(principal, input.workspace);
    const rows = await this.deps.installations.listByUser(
      UserId(principal.userId),
    );
    return {
      installations: rows.map((row) => ({
        id: row.id,
        installation_id: row.installationId,
        account_login: row.accountLogin,
        account_type: row.accountType,
        repository_selection: row.repositorySelection,
        created_at: row.createdAt.toISOString(),
      })),
    };
  }

  async listAvailableRepositories(
    principal: OAuthPrincipal,
    input: RepositoryInstallationInput,
  ) {
    await this.workspace(principal, input.workspace);
    if (!this.deps.githubClient) {
      throw new AdminMcpOperationError(
        "dependency_unavailable",
        "GitHub App integration is not configured",
      );
    }
    const installationId = InstallationId(input.installation_id);
    const installation =
      await this.deps.installations.findByInstallationId(installationId);
    if (
      !installation ||
      installation.revokedAt ||
      String(installation.installedByUserId) !== principal.userId
    ) {
      throw new AdminMcpOperationError("not_found", "installation not found");
    }
    const rows = await this.deps.githubClient.listInstallationRepos(
      installationId,
    );
    return {
      repositories: rows.map((row) => ({
        full_name: row.fullName,
        id: row.id,
        default_branch: row.defaultBranch,
        private: row.private,
      })),
    };
  }

  async listAgentRepositories(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "agent not found");
    }
    const [installationId, rows] = await Promise.all([
      this.deps.agentRepos.getLinkedInstallation(input.agent),
      this.deps.agentRepos.listRepos(input.agent),
    ]);
    return {
      installation_id: installationId,
      repositories: rows.map((row) => ({
        repo_full_name: row.repoFullName,
        branch: row.branch,
        mount_path: row.mountPath,
        auto_push: row.autoPush,
        allow_push: row.allowPush,
      })),
    };
  }

  async attachAgentRepository(
    principal: OAuthPrincipal,
    input: AgentRepositoryAttachInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canEdit) {
      throw new AdminMcpOperationError(
        "forbidden",
        "edit access to this agent is required",
      );
    }
    if (!this.deps.githubClient) {
      throw new AdminMcpOperationError(
        "dependency_unavailable",
        "GitHub App integration is not configured",
      );
    }
    await attachRepoToAgent(
      {
        client: this.deps.githubClient,
        installations: this.deps.installations,
        agentRepos: this.deps.agentRepos,
      },
      {
        actor: UserId(principal.userId),
        agentId: input.agent,
        installationId: InstallationId(input.installation_id),
        repoFullName: input.repo_full_name,
        branch: input.branch,
        mountPath: input.mount_path,
        autoPush: input.auto_push,
        allowPush: input.allow_push,
      },
    );
    return this.listAgentRepositories(principal, input);
  }

  async updateAgentRepository(
    principal: OAuthPrincipal,
    input: AgentRepositoryUpdateInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canEdit) {
      throw new AdminMcpOperationError(
        "forbidden",
        "edit access to this agent is required",
      );
    }
    await this.deps.agentRepos.updateRepo(input.agent, input.repo_full_name, {
      branch: input.branch,
      mountPath: input.mount_path,
      autoPush: input.auto_push,
      allowPush: input.allow_push,
    });
    return this.listAgentRepositories(principal, input);
  }

  async detachAgentRepository(
    principal: OAuthPrincipal,
    input: AgentRepositoryDetachInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canEdit) {
      throw new AdminMcpOperationError(
        "forbidden",
        "edit access to this agent is required",
      );
    }
    const existed = (await this.deps.agentRepos.listRepos(input.agent)).some(
      (row) => row.repoFullName === input.repo_full_name,
    );
    await detachRepoFromAgent(
      { agentRepos: this.deps.agentRepos },
      {
        actor: UserId(principal.userId),
        agentId: input.agent,
        repoFullName: input.repo_full_name,
      },
    );
    return { detached: existed, repo_full_name: input.repo_full_name };
  }

  async listSpawnGrants(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "agent not found");
    }
    const rows = await this.deps.permissionGrants.list({
      workspaceId: WorkspaceId(workspace.id),
      subject: { kind: "agent", agentId: AgentId(input.agent) },
      grantType: GrantType("spawn"),
      includeRevoked: true,
    });
    return { spawn_grants: rows.map(serializeGrant) };
  }

  async createSpawnGrant(
    principal: OAuthPrincipal,
    input: SpawnGrantCreateInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const { candidate: parent } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (parent.kind !== "orchestrator") {
      throw new AdminMcpOperationError(
        "validation_error",
        "spawn grants can only be assigned to orchestrator agents",
        { field: "agent" },
      );
    }
    await this.agentAccess(principal, workspace, input.child_agent);
    const existing = await this.deps.permissionGrants.listActive({
      workspaceId: WorkspaceId(workspace.id),
      subject: { kind: "agent", agentId: parent.id },
      grantType: GrantType("spawn"),
    });
    const replay = existing.find(
      (grant) => grant.details["child_agent_id"] === input.child_agent,
    );
    if (replay) return { spawn_grant: serializeGrant(replay), replayed: true };
    const grant = await createGrant(
      {
        grants: this.deps.permissionGrants,
        adminGuard: { assertAdmin: async () => undefined },
      },
      {
        actor: UserId(principal.userId),
        workspaceId: WorkspaceId(workspace.id),
        subject: { kind: "agent", agentId: parent.id },
        grantType: GrantType("spawn"),
        details: {
          child_agent_id: input.child_agent,
          ...(input.allowed_runtime_types !== undefined && {
            allowed_runtime_types: input.allowed_runtime_types,
          }),
          ...(input.allowed_models !== undefined && {
            allowed_models: input.allowed_models,
          }),
        },
        scope: GrantScope("persistent"),
        sessionId: null,
        reason: input.reason ?? null,
      },
    );
    return { spawn_grant: serializeGrant(grant), replayed: false };
  }

  async revokeSpawnGrant(
    principal: OAuthPrincipal,
    input: SpawnGrantRevokeInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    await this.agentAccess(principal, workspace, input.agent);
    const existing = await this.deps.permissionGrants.findById(
      GrantId(input.grant),
    );
    if (
      !existing ||
      String(existing.workspaceId) !== workspace.id ||
      existing.subject.kind !== "agent" ||
      String(existing.subject.agentId) !== input.agent ||
      String(existing.grantType) !== "spawn"
    ) {
      throw new AdminMcpOperationError("not_found", "spawn grant not found");
    }
    const grant = await revokeGrant(
      {
        grants: this.deps.permissionGrants,
        adminGuard: { assertAdmin: async () => undefined },
      },
      {
        actor: UserId(principal.userId),
        workspaceId: WorkspaceId(workspace.id),
        grantId: existing.id,
      },
    );
    return { spawn_grant: serializeGrant(grant), revoked: true };
  }

  async listWorkerImages(
    principal: OAuthPrincipal,
    input: { workspace: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const rows = await this.deps.imageCatalog.list(workspace.id);
    return { worker_images: rows.map(serializeWorkerImage) };
  }

  async getWorkerImage(
    principal: OAuthPrincipal,
    input: { workspace: string; image: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const image = await this.deps.imageCatalog.get(workspace.id, input.image);
    return { worker_image: serializeWorkerImage(image) };
  }

  async createWorkerImage(
    principal: OAuthPrincipal,
    input: WorkerImageCreateInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const claim = await this.deps.operationStore.claim({
      principal,
      toolName: "worker_images.create_from_dockerfile",
      idempotencyKey: input.idempotency_key,
      requestHash: adminMcpRequestHash(input),
    });
    if (claim.kind === "conflict") {
      throw new AdminMcpOperationError(
        "idempotency_conflict",
        "idempotency_key was already used with different input",
      );
    }
    if (claim.kind === "in_progress") {
      throw new AdminMcpOperationError(
        "conflict",
        "an operation with this idempotency_key is still in progress",
        { retryable: true },
      );
    }
    if (claim.kind === "replay") return { ...claim.result, replayed: true };
    try {
      const image = await this.deps.imageCatalog.create({
        workspaceId: workspace.id,
        name: input.name,
        displayName: input.display_name,
        description: input.description,
        dockerfileSource: input.dockerfile_source,
      });
      const result = {
        worker_image: serializeWorkerImage(image),
        replayed: false,
      };
      await this.deps.operationStore.complete({
        principal,
        toolName: "worker_images.create_from_dockerfile",
        idempotencyKey: input.idempotency_key,
        resourceId: image.id,
        result,
      });
      return result;
    } catch (error) {
      await this.deps.operationStore.fail({
        principal,
        toolName: "worker_images.create_from_dockerfile",
        idempotencyKey: input.idempotency_key,
      });
      throw error;
    }
  }

  async registerOciWorkerImage(
    principal: OAuthPrincipal,
    input: WorkerImageRegisterOciInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const claim = await this.deps.operationStore.claim({
      principal,
      toolName: "worker_images.register_oci",
      idempotencyKey: input.idempotency_key,
      requestHash: adminMcpRequestHash(input),
    });
    if (claim.kind === "conflict") {
      throw new AdminMcpOperationError(
        "idempotency_conflict",
        "idempotency_key was already used with different input",
      );
    }
    if (claim.kind === "in_progress") {
      throw new AdminMcpOperationError(
        "conflict",
        "an operation with this idempotency_key is still in progress",
        { retryable: true },
      );
    }
    if (claim.kind === "replay") return { ...claim.result, replayed: true };
    try {
      const registered = await this.deps.ociImages.register({
        workspaceId: workspace.id,
        actorUserId: principal.userId,
        name: input.name,
        displayName: input.display_name,
        description: input.description,
        ociReference: input.oci_reference,
      });
      const image = await this.deps.imageCatalog.get(
        workspace.id,
        registered.id,
      );
      const result = {
        worker_image: serializeWorkerImage(image),
        replayed: false,
      };
      await this.deps.operationStore.complete({
        principal,
        toolName: "worker_images.register_oci",
        idempotencyKey: input.idempotency_key,
        resourceId: registered.id,
        result,
      });
      return result;
    } catch (error) {
      await this.deps.operationStore.fail({
        principal,
        toolName: "worker_images.register_oci",
        idempotencyKey: input.idempotency_key,
      });
      throw error;
    }
  }

  async updateWorkerImage(
    principal: OAuthPrincipal,
    input: WorkerImageUpdateInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const current = await this.deps.imageCatalog.get(
      workspace.id,
      input.image,
    );
    if (
      current.sourceKind === "external_oci" &&
      input.dockerfile_source !== undefined
    ) {
      throw new AdminMcpOperationError(
        "validation_error",
        "an OCI image cannot be changed into a Dockerfile build",
        { field: "dockerfile_source" },
      );
    }
    const image = await this.deps.imageCatalog.update({
      workspaceId: workspace.id,
      id: input.image,
      displayName: input.display_name,
      description: input.description,
      dockerfileSource: input.dockerfile_source,
    });
    return { worker_image: serializeWorkerImage(image) };
  }

  async rebuildWorkerImage(
    principal: OAuthPrincipal,
    input: { workspace: string; image: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const current = await this.deps.imageCatalog.get(
      workspace.id,
      input.image,
    );
    if (current.sourceKind === "external_oci") {
      if (!current.requestedRef) {
        throw new AdminMcpOperationError(
          "conflict",
          "OCI image is missing its requested reference",
        );
      }
      await this.deps.ociImages.retry(
        workspace.id,
        input.image,
        current.requestedRef,
      );
      const image = await this.deps.imageCatalog.get(
        workspace.id,
        input.image,
      );
      return { worker_image: serializeWorkerImage(image) };
    }
    const image = await this.deps.imageCatalog.requestRebuild(
      workspace.id,
      input.image,
    );
    return { worker_image: serializeWorkerImage(image) };
  }

  async deleteWorkerImage(
    principal: OAuthPrincipal,
    input: { workspace: string; image: string; confirm_id: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    if (input.confirm_id !== input.image) {
      throw new AdminMcpOperationError(
        "confirmation_required",
        "confirm_id must exactly match the worker image ID",
      );
    }
    await this.deps.imageCatalog.delete(workspace.id, input.image);
    return { deleted: true, image_id: input.image };
  }

  async listPreviewEnvironments(
    principal: OAuthPrincipal,
    input: { workspace: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    // Preview rows do not yet retain producing agent/session provenance.
    // Apply the SDD's conservative legacy policy until that migration lands.
    this.assertWorkspaceAdmin(workspace);
    const rows = await this.deps.previewEnvironments.listForWorkspace(
      WorkspaceId(workspace.id),
    );
    return { preview_environments: rows.map(serializePreviewEnvironment) };
  }

  async getPreviewEnvironment(
    principal: OAuthPrincipal,
    input: { workspace: string; preview_environment: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const row = await this.deps.previewEnvironments.findById(
      PreviewEnvironmentId(input.preview_environment),
    );
    if (!row || String(row.workspaceId) !== workspace.id) {
      throw new AdminMcpOperationError(
        "not_found",
        "preview environment not found",
      );
    }
    return { preview_environment: serializePreviewEnvironment(row) };
  }

  async listCollections(
    principal: OAuthPrincipal,
    input: { workspace: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    return {
      collections: await this.deps.collectionControl.list(workspace.id),
    };
  }

  async getCollection(
    principal: OAuthPrincipal,
    input: { workspace: string; collection: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const collection = await this.deps.collectionControl.get(
      workspace.id,
      input.collection,
    );
    if (!collection) {
      throw new AdminMcpOperationError("not_found", "collection not found");
    }
    return { collection };
  }

  async createCollection(
    principal: OAuthPrincipal,
    input: CollectionCreateInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const claim = await this.deps.operationStore.claim({
      principal,
      toolName: "collections.create",
      idempotencyKey: input.idempotency_key,
      requestHash: adminMcpRequestHash(input),
    });
    if (claim.kind === "conflict") {
      throw new AdminMcpOperationError(
        "idempotency_conflict",
        "idempotency_key was already used with different input",
      );
    }
    if (claim.kind === "in_progress") {
      throw new AdminMcpOperationError(
        "conflict",
        "an operation with this idempotency_key is still in progress",
        { retryable: true },
      );
    }
    if (claim.kind === "replay") return { ...claim.result, replayed: true };
    try {
      const collection = await this.deps.collectionControl.create({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        actorUserId: principal.userId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        providerType: input.provider_type,
        settings: input.settings,
      });
      const result = { collection, replayed: false };
      await this.deps.operationStore.complete({
        principal,
        toolName: "collections.create",
        idempotencyKey: input.idempotency_key,
        resourceId: String(collection.id),
        result,
      });
      return result;
    } catch (error) {
      await this.deps.operationStore.fail({
        principal,
        toolName: "collections.create",
        idempotencyKey: input.idempotency_key,
      });
      throw error;
    }
  }

  async updateCollection(
    principal: OAuthPrincipal,
    input: CollectionUpdateInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const existing = await this.deps.collectionControl.get(
      workspace.id,
      input.collection,
    );
    if (!existing) {
      throw new AdminMcpOperationError("not_found", "collection not found");
    }
    const collection = await this.deps.collectionControl.update({
      workspaceId: workspace.id,
      collectionId: input.collection,
      expectedUpdatedAt: input.expected_updated_at,
      name: input.name,
      description: input.description,
      settings: input.settings,
    });
    if (!collection) {
      throw new AdminMcpOperationError(
        "revision_conflict",
        "collection changed after it was read",
        { current_updated_at: existing.updated_at },
      );
    }
    return { collection };
  }

  async deleteCollection(
    principal: OAuthPrincipal,
    input: { workspace: string; collection: string; confirm_id: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    if (input.confirm_id !== input.collection) {
      throw new AdminMcpOperationError(
        "confirmation_required",
        "confirm_id must exactly match the collection ID",
      );
    }
    const requested = await this.deps.collectionControl.requestDelete(
      workspace.id,
      input.collection,
    );
    if (!requested) return { deleted: false, collection_id: input.collection };
    if (requested.attachmentCount > 0) {
      throw new AdminMcpOperationError(
        "conflict",
        "collection is attached to one or more agents",
        { attachment_count: requested.attachmentCount },
      );
    }
    return {
      deleted: false,
      deletion_requested: true,
      collection: requested.collection,
    };
  }

  async retryCollectionProvision(
    principal: OAuthPrincipal,
    input: { workspace: string; collection: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const collection = await this.deps.collectionControl.retry(
      workspace.id,
      input.collection,
    );
    if (!collection) {
      const existing = await this.deps.collectionControl.get(
        workspace.id,
        input.collection,
      );
      if (!existing) {
        throw new AdminMcpOperationError("not_found", "collection not found");
      }
      throw new AdminMcpOperationError(
        "conflict",
        "only failed collections can be retried",
        { current_status: existing.status },
      );
    }
    return { collection };
  }

  async listAgentCollections(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "agent not found");
    }
    const rows = await this.deps.collections.listForAgent(AgentId(input.agent));
    const collections = await Promise.all(
      rows.map(async (attachment) => ({
        ...(await this.deps.collectionControl.get(
          workspace.id,
          String(attachment.collectionId),
        )),
        is_default: attachment.isDefault,
        attached_at: attachment.attachedAt.toISOString(),
      })),
    );
    return { collections };
  }

  async setAgentCollections(
    principal: OAuthPrincipal,
    input: AgentCollectionsSetInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { candidate, access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canEdit) {
      throw new AdminMcpOperationError(
        "forbidden",
        "edit access to this agent is required",
      );
    }
    if (candidate.updatedAt.toISOString() !== input.expected_agent_updated_at) {
      throw new AdminMcpOperationError(
        "revision_conflict",
        "agent configuration changed after it was read",
        { current_updated_at: candidate.updatedAt.toISOString() },
      );
    }
    const uniqueIds = [...new Set(input.collection_ids)];
    if (
      input.default_collection_id &&
      !uniqueIds.includes(input.default_collection_id)
    ) {
      throw new AdminMcpOperationError(
        "validation_error",
        "default_collection_id must be included in collection_ids",
        { field: "default_collection_id" },
      );
    }
    for (const id of uniqueIds) {
      const collection = await this.deps.collectionControl.get(workspace.id, id);
      if (!collection) {
        throw new AdminMcpOperationError("not_found", "collection not found");
      }
      if (collection.status !== "ready") {
        throw new AdminMcpOperationError(
          "dependency_unavailable",
          `collection is not ready: ${id}`,
          { collection_id: id, status: collection.status },
        );
      }
    }
    await this.deps.collections.syncAttachments(
      candidate.id,
      WorkspaceId(workspace.id),
      uniqueIds.map(CollectionId),
      input.default_collection_id
        ? CollectionId(input.default_collection_id)
        : null,
    );
    return this.listAgentCollections(principal, input);
  }

  async listSessions(principal: OAuthPrincipal, input: SessionListInput) {
    const workspace = await this.workspace(principal, input.workspace);
    const { candidate, access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "agent not found");
    }
    const limit = pageLimit(input.limit);
    const rows = await this.deps.sessions.listByAgent(candidate.id, 500);
    const visible: Session[] = [];
    for (const session of rows) {
      const decision = await resolveSessionVisibility(
        {
          platformAdminGuard: this.deps.platformAdminGuard,
          shares: this.deps.sessionShares,
          agentCollaborateResolver: this.deps.agentCollaborateResolver,
        },
        UserId(principal.userId),
        session,
        candidate.workspaceId,
      );
      if (decision.visible) visible.push(session);
    }
    const after = input.cursor
      ? visible.findIndex((session) => String(session.id) === input.cursor) + 1
      : 0;
    const page = visible.slice(after, after + limit);
    return {
      sessions: page.map(serializeSession),
      next_cursor:
        after + page.length < visible.length
          ? String(page.at(-1)?.id ?? "")
          : null,
    };
  }

  async getSession(
    principal: OAuthPrincipal,
    input: { workspace: string; session: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const session = await this.sessionAccess(
      principal,
      workspace,
      input.session,
    );
    return { session: serializeSession(session) };
  }

  async listSessionEvents(
    principal: OAuthPrincipal,
    input: {
      workspace: string;
      session: string;
      after_seq?: number;
      limit?: number;
    },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const session = await this.sessionAccess(
      principal,
      workspace,
      input.session,
    );
    const limit = pageLimit(input.limit);
    if (
      input.after_seq !== undefined &&
      (!Number.isInteger(input.after_seq) || input.after_seq < 0)
    ) {
      throw new AdminMcpOperationError(
        "validation_error",
        "after_seq must be a non-negative integer",
        { field: "after_seq" },
      );
    }
    const rows = await this.deps.sessionEvents.listBySession(session.id, {
      afterSeq: input.after_seq,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      session_id: session.id,
      events: page.map((event) => ({
        id: event.id,
        session_id: event.sessionId,
        seq: event.seq,
        type: event.type,
        payload: event.payload,
        timestamp: event.timestamp.toISOString(),
        created_at: event.createdAt.toISOString(),
      })),
      next_cursor:
        rows.length > limit ? String(page.at(-1)?.seq ?? "") : null,
    };
  }

  async getSessionCost(
    principal: OAuthPrincipal,
    input: { workspace: string; session: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const session = await this.sessionAccess(
      principal,
      workspace,
      input.session,
    );
    const rollup = await this.deps.tokenUsage.rollupForSession({
      workspaceId: workspace.id,
      sessionId: String(session.id),
    });
    return costEnvelope({ session: rollup, visibility_filtered: false });
  }

  async getSessionTreeCost(
    principal: OAuthPrincipal,
    input: { workspace: string; session: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const root = await this.sessionAccess(
      principal,
      workspace,
      input.session,
    );
    const rollup = await this.deps.tokenUsage.rollupForSessionTree({
      workspaceId: workspace.id,
      sessionId: String(root.id),
    });
    const visibleChildren = [];
    let visibilityFiltered = false;
    for (const child of rollup.children) {
      const session = await this.deps.sessions.findById(
        SessionId(child.sessionId),
      );
      if (!session) {
        visibilityFiltered = true;
        continue;
      }
      const decision = await resolveSessionVisibility(
        {
          platformAdminGuard: this.deps.platformAdminGuard,
          shares: this.deps.sessionShares,
          agentCollaborateResolver: this.deps.agentCollaborateResolver,
        },
        UserId(principal.userId),
        session,
        WorkspaceId(workspace.id),
      );
      if (decision.visible) visibleChildren.push(child);
      else visibilityFiltered = true;
    }
    const totals = { ...rollup.parent.totals };
    for (const child of visibleChildren) addCostTotals(totals, child);
    return costEnvelope({
      session_tree: {
        ...rollup,
        children: visibleChildren,
        totals,
      },
      visibility_filtered: visibilityFiltered,
    });
  }

  async getAgentCost(
    principal: OAuthPrincipal,
    input: {
      workspace: string;
      agent: string;
      window?: "24h" | "7d" | "30d" | "all";
    },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { candidate, access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "agent not found");
    }
    const window = input.window ?? "7d";
    if (isWorkspaceAdmin(workspace.role)) {
      const rollup = await this.deps.tokenUsage.rollupForAgent({
        workspaceId: workspace.id,
        agentId: input.agent,
        window,
        now: new Date(),
      });
      return costEnvelope({ agent: rollup, visibility_filtered: false });
    }
    const now = new Date();
    const since =
      window === "24h"
        ? new Date(now.getTime() - 86_400_000)
        : window === "7d"
          ? new Date(now.getTime() - 7 * 86_400_000)
          : window === "30d"
            ? new Date(now.getTime() - 30 * 86_400_000)
            : null;
    const sessions = await this.deps.sessions.listByAgent(candidate.id, 500);
    const totals = emptyCostTotals();
    const byModel = new Map<string, TokenUsageTotals & { model: string }>();
    const byDay = new Map<string, TokenUsageTotals & { day: string }>();
    const topSessions: Array<TokenUsageTotals & {
      sessionId: string;
      startedAt: string;
      summary: string | null;
    }> = [];
    let hidden = false;
    for (const session of sessions) {
      if (since && session.triggeredAt < since) continue;
      const decision = await resolveSessionVisibility(
        {
          platformAdminGuard: this.deps.platformAdminGuard,
          shares: this.deps.sessionShares,
          agentCollaborateResolver: this.deps.agentCollaborateResolver,
        },
        UserId(principal.userId),
        session,
        candidate.workspaceId,
      );
      if (!decision.visible) {
        hidden = true;
        continue;
      }
      const rollup = await this.deps.tokenUsage.rollupForSession({
        workspaceId: workspace.id,
        sessionId: String(session.id),
      });
      addCostTotals(totals, rollup.totals);
      for (const model of rollup.byModel) {
        const row = byModel.get(model.model) ?? {
          model: model.model,
          ...emptyCostTotals(),
        };
        addCostTotals(row, model);
        byModel.set(model.model, row);
      }
      const day = session.triggeredAt.toISOString().slice(0, 10);
      const dayRow = byDay.get(day) ?? { day, ...emptyCostTotals() };
      addCostTotals(dayRow, rollup.totals);
      byDay.set(day, dayRow);
      topSessions.push({
        sessionId: String(session.id),
        startedAt: session.triggeredAt.toISOString(),
        summary: session.summary,
        ...rollup.totals,
      });
    }
    topSessions.sort((a, b) => b.costUsdEstimate - a.costUsdEstimate);
    return costEnvelope({
      agent: {
        agentId: input.agent,
        window,
        totals,
        byModel: [...byModel.values()].sort(
          (a, b) => b.costUsdEstimate - a.costUsdEstimate,
        ),
        byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
        topSessions: topSessions.slice(0, 10),
      },
      visibility_filtered: hidden || sessions.length === 500,
    });
  }

  async getWorkspaceCost(
    principal: OAuthPrincipal,
    input: { workspace: string; since: string; until: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    this.assertWorkspaceAdmin(workspace);
    const since = new Date(input.since);
    const until = new Date(input.until);
    if (
      !Number.isFinite(since.getTime()) ||
      !Number.isFinite(until.getTime()) ||
      since >= until ||
      until.getTime() - since.getTime() > 366 * 86_400_000
    ) {
      throw new AdminMcpOperationError(
        "validation_error",
        "since/until must be a valid increasing range of at most 366 days",
      );
    }
    const rollup = await this.deps.tokenUsage.rollupForWorkspace({
      workspaceId: workspace.id,
      since,
      until,
    });
    return costEnvelope({
      workspace_id: workspace.id,
      range: { since: since.toISOString(), until: until.toISOString() },
      rollup,
      visibility_filtered: false,
    });
  }

  async listArtifacts(
    principal: OAuthPrincipal,
    input: { workspace: string; session: string; limit?: number },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const session = await this.sessionAccess(
      principal,
      workspace,
      input.session,
    );
    const limit = pageLimit(input.limit);
    const events = await this.deps.sessionEvents.listBySession(session.id, {
      limit: 5000,
    });
    return {
      artifacts: events
        .filter((event) => event.type === "agent.share")
        .slice(-limit)
        .map((event) => {
          const payload = eventPayload(event.payload);
          return {
            share_id: payload.share_id,
            session_id: session.id,
            agent_id: session.agentId,
            title: payload.title ?? null,
            share_type: payload.share_type ?? null,
            path: payload.path ?? payload.entry_point ?? null,
            entry_point: payload.entry_point ?? null,
            created_at: event.timestamp.toISOString(),
          };
        }),
    };
  }

  async readArtifact(
    principal: OAuthPrincipal,
    input: {
      workspace: string;
      session: string;
      share: string;
      path?: string;
    },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const session = await this.sessionAccess(
      principal,
      workspace,
      input.session,
    );
    const events = await this.deps.sessionEvents.listBySession(session.id, {
      limit: 5000,
    });
    const event = events.find((candidate) => {
      if (candidate.type !== "agent.share") return false;
      return eventPayload(candidate.payload).share_id === input.share;
    });
    if (!event) {
      throw new AdminMcpOperationError("not_found", "artifact not found");
    }
    const payload = eventPayload(event.payload);
    const path =
      input.path ||
      (typeof payload.entry_point === "string" ? payload.entry_point : "") ||
      (typeof payload.path === "string" ? payload.path : "") ||
      "index.html";
    if (
      path.startsWith("/") ||
      path.split(/[\\/]+/).some((segment) => segment === "..")
    ) {
      throw new AdminMcpOperationError(
        "validation_error",
        "artifact path must be a normalized relative path",
        { field: "path" },
      );
    }
    const bytes = this.deps.artifactsBucket
      ? await downloadShareFromGcs(
          this.deps.artifactsBucket,
          input.share,
          path,
        )
      : readShareFile(input.share, path);
    if (!bytes) {
      throw new AdminMcpOperationError("not_found", "artifact file not found");
    }
    if (bytes.length > 1024 * 1024) {
      throw new AdminMcpOperationError(
        "validation_error",
        "artifact exceeds the 1 MiB inline read limit",
        { size: bytes.length, max_inline_size: 1024 * 1024 },
      );
    }
    const mimeType = getMimeType(path);
    const textLike =
      mimeType.startsWith("text/") ||
      mimeType === "application/json" ||
      mimeType === "application/jsonl" ||
      mimeType === "application/javascript";
    return {
      artifact: {
        share_id: input.share,
        session_id: session.id,
        path,
        mime_type: mimeType,
        size: bytes.length,
        ...(textLike
          ? { text: bytes.toString("utf8") }
          : { content_base64: bytes.toString("base64") }),
      },
    };
  }

  async inspectAgentContext(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { candidate, access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "agent not found");
    }
    const [repositories, collections, mcps, spawnGrants, contextFiles] =
      await Promise.all([
        this.listAgentRepositories(principal, input),
        this.listAgentCollections(principal, input),
        this.listMcpAttachments(principal, input),
        this.listSpawnGrants(principal, input),
        this.deps.contextFiles.list(workspace.id, input.agent),
      ]);
    let workerImage: Record<string, unknown> | null = null;
    if (candidate.imageId) {
      try {
        workerImage = (
          await this.getWorkerImage(principal, {
            workspace: input.workspace,
            image: candidate.imageId,
          })
        ).worker_image as Record<string, unknown>;
      } catch {
        workerImage = { id: candidate.imageId, status: "missing" };
      }
    }
    return {
      context: {
        agent: serializeAgent(candidate),
        prompt_revision: candidate.updatedAt.toISOString(),
        heartbeat_revision: candidate.updatedAt.toISOString(),
        repositories: repositories.repositories,
        collections: collections.collections,
        mcp_attachments: mcps.attachments,
        spawn_grants: spawnGrants.spawn_grants,
        context_files: contextFiles,
        worker_image: workerImage,
        configuration_revision: candidate.updatedAt.toISOString(),
      },
    };
  }

  async listContextFiles(
    principal: OAuthPrincipal,
    input: AgentReferenceInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "agent not found");
    }
    return {
      context_files: await this.deps.contextFiles.list(
        workspace.id,
        input.agent,
      ),
    };
  }

  async getContextFile(
    principal: OAuthPrincipal,
    input: AgentReferenceInput & { path: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "agent not found");
    }
    const file = await this.deps.contextFiles.get(
      workspace.id,
      input.agent,
      input.path,
    );
    if (!file) {
      throw new AdminMcpOperationError("not_found", "context file not found");
    }
    return { context_file: file };
  }

  async putContextFile(
    principal: OAuthPrincipal,
    input: ContextFilePutInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canEdit) {
      throw new AdminMcpOperationError(
        "forbidden",
        "edit access to this agent is required",
      );
    }
    const file = await this.deps.contextFiles.put({
      workspaceId: workspace.id,
      agentId: input.agent,
      actorUserId: principal.userId,
      path: input.path,
      mimeType: input.mime_type,
      content: input.content,
      expectedRevision: input.expected_revision,
    });
    return { context_file: file };
  }

  async deleteContextFile(
    principal: OAuthPrincipal,
    input: AgentReferenceInput & { path: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canEdit) {
      throw new AdminMcpOperationError(
        "forbidden",
        "edit access to this agent is required",
      );
    }
    return {
      deleted: await this.deps.contextFiles.delete(
        workspace.id,
        input.agent,
        input.path,
      ),
      path: input.path,
    };
  }

  async validateAgentConfiguration(
    principal: OAuthPrincipal,
    input: AgentReferenceInput & { proposed?: Record<string, unknown> },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { candidate, access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canView) {
      throw new AdminMcpOperationError("not_found", "agent not found");
    }
    if (
      input.proposed &&
      (!access.canEdit || !principal.scopes.includes("x1.agents.write"))
    ) {
      throw new AdminMcpOperationError(
        "forbidden",
        "agent write scope and edit access are required to validate proposed changes",
      );
    }
    const effective = { ...serializeAgent(candidate), ...(input.proposed ?? {}) };
    const errors: Array<Record<string, unknown>> = [];
    const warnings: Array<Record<string, unknown>> = [];
    const kind = String(effective.kind ?? candidate.kind);
    const heartbeat = String(effective.heartbeat_md ?? "").trim();
    if ((kind === "orchestrator" || kind === "scheduled") && !heartbeat) {
      warnings.push({
        code: "heartbeat_missing",
        field: "heartbeat_md",
        message: `${kind} agents should have measurable wake instructions`,
      });
    }
    if (kind === "scheduled" && !effective.schedule) {
      errors.push({
        code: "schedule_missing",
        field: "schedule",
        message: "scheduled agents require a schedule",
      });
    }
    const imageId = effective.image_id;
    if (typeof imageId === "string" && imageId) {
      try {
        const image = await this.deps.imageCatalog.get(workspace.id, imageId);
        if (image.buildStatus !== "ready" && image.buildStatus !== "succeeded") {
          errors.push({
            code: "image_not_ready",
            field: "image_id",
            status: image.buildStatus,
          });
        }
      } catch {
        errors.push({ code: "image_not_found", field: "image_id" });
      }
    }
    const attached = await this.listAgentCollections(principal, input);
    for (const collection of attached.collections as Array<
      Record<string, unknown>
    >) {
      if (collection.status !== "ready") {
        errors.push({
          code: "collection_not_ready",
          collection_id: collection.id,
          status: collection.status,
        });
      }
    }
    const files = await this.deps.contextFiles.list(workspace.id, input.agent);
    const totalContextBytes = files.reduce(
      (sum, file) => sum + Number(file.size_bytes ?? 0),
      0,
    );
    const repositories = await this.deps.agentRepos.listRepos(input.agent);
    if (repositories.length === 0 && files.length === 0) {
      warnings.push({
        code: "durable_context_empty",
        message: "agent has no repository or managed context files",
      });
    }
    return {
      validation: {
        launch_ready: errors.length === 0,
        errors,
        warnings,
        effective_runtime: effective.runtime_type,
        effective_model: effective.model,
        effective_image_id: effective.image_id,
        context_file_count: files.length,
        context_bytes: totalContextBytes,
        configuration_revision: candidate.updatedAt.toISOString(),
      },
    };
  }

  async triggerValidationSession(
    principal: OAuthPrincipal,
    input: SessionTriggerInput,
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const { candidate, access } = await this.agentAccess(
      principal,
      workspace,
      input.agent,
    );
    if (!access.canInvoke) {
      throw new AdminMcpOperationError(
        "forbidden",
        "invoke access to this agent is required",
      );
    }
    const task = input.task.trim();
    if (!task || task.length > 32_768) {
      throw new AdminMcpOperationError(
        "validation_error",
        "task is required and must be at most 32768 characters",
        { field: "task" },
      );
    }
    const claim = await this.deps.operationStore.claim({
      principal,
      toolName: "sessions.trigger",
      idempotencyKey: input.idempotency_key,
      requestHash: adminMcpRequestHash(input),
    });
    if (claim.kind === "conflict") {
      throw new AdminMcpOperationError(
        "idempotency_conflict",
        "idempotency_key was already used with different input",
      );
    }
    if (claim.kind === "in_progress") {
      throw new AdminMcpOperationError(
        "conflict",
        "an operation with this idempotency_key is still in progress",
        { retryable: true },
      );
    }
    if (claim.kind === "replay") return { ...claim.result, replayed: true };
    try {
      if (candidate.kind === "orchestrator") {
        const live = await this.deps.sessions.findLiveSessionForAgent(
          candidate.id,
        );
        if (live) {
          throw new AdminMcpOperationError(
            "conflict",
            "orchestrator already has a live session",
            { session_id: live.id },
          );
        }
      }
      const effectiveRuntime = RuntimeType(
        input.runtime_type ?? String(candidate.runtimeType),
      );
      const effectiveModel = input.model ?? candidate.model ?? null;
      let effectiveImageRef: string | null = null;
      if (candidate.imageId) {
        const image = await this.deps.imageCatalog.get(
          workspace.id,
          candidate.imageId,
        );
        if (image.buildStatus !== "ready" && image.buildStatus !== "succeeded") {
          throw new AdminMcpOperationError(
            "image_not_ready",
            "configured worker image is not ready",
            { image_id: image.id, status: image.buildStatus },
          );
        }
        effectiveImageRef = image.builtRef;
      }
      const session = await this.deps.sessions.create({
        agentId: candidate.id,
        triggeredBy: "user",
        triggeredByUserId: UserId(principal.userId),
        parentSessionId: null,
        parentAgentId: null,
        resumedFromSessionId: null,
        triggeredAt: new Date(),
        runtimeOverride: input.runtime_type ? effectiveRuntime : null,
        modelOverride: input.model ?? null,
        validationRun: true,
        validationTask: task,
        effectiveRuntimeType: effectiveRuntime,
        effectiveModel,
        effectiveImageRef,
        agentConfigurationRevision: candidate.updatedAt,
      });
      const result = { session: serializeSession(session), replayed: false };
      await this.deps.operationStore.complete({
        principal,
        toolName: "sessions.trigger",
        idempotencyKey: input.idempotency_key,
        resourceId: String(session.id),
        result,
      });
      return result;
    } catch (error) {
      await this.deps.operationStore.fail({
        principal,
        toolName: "sessions.trigger",
        idempotencyKey: input.idempotency_key,
      });
      throw error;
    }
  }

  async cancelValidationSession(
    principal: OAuthPrincipal,
    input: { workspace: string; session: string },
  ) {
    const workspace = await this.workspace(principal, input.workspace);
    const session = await this.sessionAccess(
      principal,
      workspace,
      input.session,
    );
    if (
      !session.validationRun ||
      String(session.triggeredByUserId) !== principal.userId
    ) {
      throw new AdminMcpOperationError(
        "forbidden",
        "only the caller's own MCP validation run can be cancelled",
      );
    }
    if (session.status === "complete" || session.status === "failed") {
      return { cancelled: false, session: serializeSession(session) };
    }
    const wasRunning = session.status === "running";
    const updated = await this.deps.sessions.updateStatus(session.id, {
      status: "complete",
      completedAt: new Date(),
      errorMessage: "cancelled",
    });
    if (wasRunning && this.deps.jobTerminator) {
      await this.deps.jobTerminator
        .terminateForSession(session.id)
        .catch(() => undefined);
    }
    return { cancelled: true, session: serializeSession(updated) };
  }
}
