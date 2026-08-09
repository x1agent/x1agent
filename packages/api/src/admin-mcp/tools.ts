import type { OAuthPrincipal } from "./oauth-store.js";
import {
  AdminMcpOperationError,
  type AdminMcpControlPlane,
} from "./control-plane.js";
import type { AdminMcpWorkspaceReader } from "./workspace-reader.js";
import {
  adminMcpRequestHash,
  type AdminMcpOperationStore,
} from "./operation-store.js";
import { readGuidance, searchGuidance } from "./guidance.js";
import { randomUUID } from "node:crypto";
import { DomainError } from "@x1agent/kernel";

export const ADMIN_MCP_SCOPES = [
  "x1.workspaces.read",
  "x1.agents.read",
  "x1.agents.write",
  "x1.repositories.read",
  "x1.repositories.write",
  "x1.spawn_grants.read",
  "x1.spawn_grants.write",
  "x1.mcp_configurations.read",
  "x1.mcp_configurations.write",
  "x1.collections.read",
  "x1.collections.write",
  "x1.worker_images.read",
  "x1.worker_images.write",
  "x1.sessions.read",
  "x1.sessions.write",
  "x1.artifacts.read",
  "x1.preview_environments.read",
  "x1.costs.read",
] as const;

export const DEFAULT_ADMIN_MCP_SCOPE = ADMIN_MCP_SCOPES.join(" ");

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  requiredScopes: readonly string[];
}

const workspaceProperty = {
  workspace: {
    type: "string",
    description: "Enabled X1Agent workspace slug",
  },
};

const agentProperty = {
  agent: { type: "string", description: "Agent ID" },
};

const mcpConfigurationProperty = {
  mcp_configuration: {
    type: "string",
    description: "Workspace MCP configuration ID",
  },
};

const agentConfigurationProperties = {
  name: { type: "string", minLength: 1, maxLength: 200 },
  runtime_type: { type: "string" },
  kind: { type: "string", enum: ["worker", "orchestrator", "scheduled"] },
  system_prompt: { type: "string" },
  heartbeat_md: { type: "string" },
  schedule: { type: ["string", "null"] },
  is_active: { type: "boolean" },
  image_id: { type: ["string", "null"] },
  model: { type: ["string", "null"] },
  owner_user_id: { type: ["string", "null"] },
  visibility: {
    type: "string",
    enum: ["private", "workspace", "via_grants"],
  },
  scheduled_run_as_user_id: { type: ["string", "null"] },
  idle_timeout_seconds: {
    type: ["integer", "null"],
    minimum: 30,
    maximum: 604800,
  },
  skill_sources: { type: "array", maxItems: 20 },
};

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

const tools: ToolDefinition[] = [
  {
    name: "documentation.search",
    title: "Search X1Agent documentation",
    description: "Search the built-in canonical X1Agent administrative guidance.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 300 } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.workspaces.read"],
  },
  {
    name: "documentation.read",
    title: "Read X1Agent documentation",
    description: "Read one canonical x1agent://docs guidance page by URI.",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string", minLength: 1, maxLength: 300 } },
      required: ["uri"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.workspaces.read"],
  },
  {
    name: "workspaces.list",
    title: "List X1Agent workspaces",
    description:
      "List workspaces visible to the authenticated user with administrative MCP enabled.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readAnnotations,
    requiredScopes: ["x1.workspaces.read"],
  },
  {
    name: "workspaces.get",
    title: "Get an X1Agent workspace",
    description:
      "Get one enabled workspace by slug using current membership.",
    inputSchema: {
      type: "object",
      properties: workspaceProperty,
      required: ["workspace"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.workspaces.read"],
  },
  {
    name: "agents.list",
    title: "List agents",
    description:
      "List accessible agents in one workspace with optional kind, runtime, active, owner, and text filters.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        kind: { type: "string", enum: ["worker", "orchestrator", "scheduled"] },
        runtime: { type: "string" },
        active: { type: "boolean" },
        owner: { type: "string" },
        search: { type: "string", maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string" },
      },
      required: ["workspace"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.agents.read"],
  },
  {
    name: "agents.get",
    title: "Get an agent",
    description:
      "Get the complete accessible agent configuration with secret-bearing references redacted.",
    inputSchema: {
      type: "object",
      properties: { ...workspaceProperty, ...agentProperty },
      required: ["workspace", "agent"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.agents.read"],
  },
  {
    name: "agents.create",
    title: "Create an agent",
    description:
      "Create an agent as the authenticated user. Reusing the same slug by the same creator returns the existing agent.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
        slug: { type: "string", minLength: 1, maxLength: 100 },
        ...agentConfigurationProperties,
      },
      required: ["workspace", "idempotency_key", "slug", "name"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.agents.write"],
  },
  {
    name: "agents.update",
    title: "Update an agent",
    description:
      "Partially update an editable agent using the updated_at value from agents.get as an optimistic revision.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        expected_updated_at: { type: "string", format: "date-time" },
        ...agentConfigurationProperties,
      },
      required: ["workspace", "agent", "expected_updated_at"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.agents.write"],
  },
  {
    name: "agents.delete",
    title: "Delete an agent",
    description:
      "Delete an editable agent after confirm_id exactly matches the agent ID.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        confirm_id: { type: "string" },
      },
      required: ["workspace", "agent", "confirm_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    requiredScopes: ["x1.agents.write"],
  },
  {
    name: "agents.context.inspect",
    title: "Inspect effective agent context",
    description: "Inspect the permission-filtered effective context manifest for an accessible agent.",
    inputSchema: agentReferenceSchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.agents.read"],
  },
  {
    name: "agents.context_files.list",
    title: "List agent context files",
    description: "List versioned X1Agent-managed context files for an accessible agent.",
    inputSchema: agentReferenceSchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.agents.read"],
  },
  {
    name: "agents.context_files.get",
    title: "Get an agent context file",
    description: "Read one authorized managed context file.",
    inputSchema: contextFileReferenceSchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.agents.read"],
  },
  {
    name: "agents.context_files.put",
    title: "Put an agent context file",
    description: "Create or revision-update a bounded non-secret managed context file.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        path: { type: "string", minLength: 1, maxLength: 240 },
        mime_type: {
          type: "string",
          enum: [
            "text/plain",
            "text/markdown",
            "application/json",
            "text/yaml",
            "text/csv",
          ],
        },
        content: { type: "string", maxLength: 262144, writeOnly: true },
        expected_revision: { type: ["integer", "null"], minimum: 1 },
      },
      required: ["workspace", "agent", "path", "mime_type", "content"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.agents.write"],
  },
  {
    name: "agents.context_files.delete",
    title: "Delete an agent context file",
    description: "Idempotently remove one managed context file from an editable agent.",
    inputSchema: contextFileReferenceSchema(),
    annotations: { ...writeAnnotations, destructiveHint: true },
    requiredScopes: ["x1.agents.write"],
  },
  {
    name: "agents.validate_configuration",
    title: "Validate agent configuration",
    description: "Dry-run current or proposed effective configuration and return a launch-ready verdict.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        proposed: { type: "object", additionalProperties: true },
      },
      required: ["workspace", "agent"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.agents.read"],
  },
  {
    name: "repositories.installations.list",
    title: "List GitHub installations",
    description: "List active GitHub App installations owned by the authenticated user.",
    inputSchema: workspaceOnlySchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.repositories.read"],
  },
  {
    name: "repositories.available.list",
    title: "List available repositories",
    description: "List repositories currently available through one user-owned GitHub installation.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        installation_id: { type: "integer", minimum: 1 },
      },
      required: ["workspace", "installation_id"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.repositories.read"],
  },
  {
    name: "agents.repositories.list",
    title: "List agent repositories",
    description: "List repository attachments for an accessible agent.",
    inputSchema: agentReferenceSchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.repositories.read", "x1.agents.read"],
  },
  {
    name: "agents.repositories.attach",
    title: "Attach an agent repository",
    description: "Attach a repository from a user-owned GitHub installation to an editable agent.",
    inputSchema: agentRepositorySchema(true),
    annotations: writeAnnotations,
    requiredScopes: ["x1.repositories.write", "x1.agents.write"],
  },
  {
    name: "agents.repositories.update",
    title: "Update an agent repository",
    description: "Update branch, mount path, or push settings for an agent repository attachment.",
    inputSchema: agentRepositorySchema(false),
    annotations: writeAnnotations,
    requiredScopes: ["x1.repositories.write", "x1.agents.write"],
  },
  {
    name: "agents.repositories.detach",
    title: "Detach an agent repository",
    description: "Idempotently detach a repository from an editable agent.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        repo_full_name: { type: "string", minLength: 3, maxLength: 255 },
      },
      required: ["workspace", "agent", "repo_full_name"],
      additionalProperties: false,
    },
    annotations: { ...writeAnnotations, destructiveHint: true },
    requiredScopes: ["x1.repositories.write", "x1.agents.write"],
  },
  {
    name: "agents.spawn_grants.list",
    title: "List orchestrator spawn grants",
    description: "List active and revoked child-agent spawn grants for an accessible orchestrator.",
    inputSchema: agentReferenceSchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.spawn_grants.read", "x1.agents.read"],
  },
  {
    name: "agents.spawn_grants.create",
    title: "Create an orchestrator spawn grant",
    description: "Grant a same-workspace orchestrator permission to spawn one child agent.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        child_agent: { type: "string" },
        allowed_runtime_types: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          maxItems: 20,
        },
        allowed_models: {
          type: "array",
          items: { type: "string", minLength: 1 },
          uniqueItems: true,
          maxItems: 50,
        },
        reason: { type: ["string", "null"], maxLength: 1000 },
      },
      required: ["workspace", "agent", "child_agent"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.spawn_grants.write", "x1.agents.write"],
  },
  {
    name: "agents.spawn_grants.revoke",
    title: "Revoke an orchestrator spawn grant",
    description: "Idempotently revoke one spawn grant belonging to an orchestrator.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        grant: { type: "string" },
      },
      required: ["workspace", "agent", "grant"],
      additionalProperties: false,
    },
    annotations: { ...writeAnnotations, destructiveHint: true },
    requiredScopes: ["x1.spawn_grants.write", "x1.agents.write"],
  },
  {
    name: "collections.list",
    title: "List collections",
    description: "List workspace collections with asynchronous provisioning lifecycle state.",
    inputSchema: workspaceOnlySchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.collections.read"],
  },
  {
    name: "collections.get",
    title: "Get a collection",
    description: "Get one same-workspace collection including safe provider metadata and lifecycle state.",
    inputSchema: collectionReferenceSchema(false),
    annotations: readAnnotations,
    requiredScopes: ["x1.collections.read"],
  },
  {
    name: "collections.create",
    title: "Create a collection",
    description: "Create a pending collection and enqueue durable provider provisioning.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
        name: { type: "string", minLength: 1, maxLength: 200 },
        slug: { type: "string", minLength: 1, maxLength: 63 },
        description: { type: ["string", "null"], maxLength: 2000 },
        provider_type: { type: "string", enum: ["surrealdb"] },
        settings: { type: "object", additionalProperties: true },
      },
      required: ["workspace", "idempotency_key", "name", "slug"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.collections.write"],
  },
  {
    name: "collections.update",
    title: "Update a collection",
    description: "Update collection display metadata and settings using optimistic concurrency.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        collection: { type: "string" },
        expected_updated_at: { type: "string", format: "date-time" },
        name: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: ["string", "null"], maxLength: 2000 },
        settings: { type: "object", additionalProperties: true },
      },
      required: ["workspace", "collection", "expected_updated_at"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.collections.write"],
  },
  {
    name: "collections.delete",
    title: "Delete a collection",
    description: "Request durable collection deletion; attached collections return a conflict.",
    inputSchema: collectionReferenceSchema(true),
    annotations: { ...writeAnnotations, destructiveHint: true },
    requiredScopes: ["x1.collections.write"],
  },
  {
    name: "collections.retry_provision",
    title: "Retry collection provisioning",
    description: "Retry provider provisioning for a failed collection without changing its identity.",
    inputSchema: collectionReferenceSchema(false),
    annotations: writeAnnotations,
    requiredScopes: ["x1.collections.write"],
  },
  {
    name: "agents.collections.list",
    title: "List agent collections",
    description: "List collections attached to an accessible agent with lifecycle state.",
    inputSchema: agentReferenceSchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.collections.read", "x1.agents.read"],
  },
  {
    name: "agents.collections.set",
    title: "Set agent collections",
    description: "Atomically replace an editable agent's ready collection attachments.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        expected_agent_updated_at: { type: "string", format: "date-time" },
        collection_ids: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          maxItems: 100,
        },
        default_collection_id: { type: ["string", "null"] },
      },
      required: [
        "workspace",
        "agent",
        "expected_agent_updated_at",
        "collection_ids",
      ],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.collections.write", "x1.agents.write"],
  },
  {
    name: "worker_images.list",
    title: "List worker images",
    description: "List platform presets and workspace-owned worker images with build lifecycle state.",
    inputSchema: workspaceOnlySchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.worker_images.read"],
  },
  {
    name: "worker_images.get",
    title: "Get a worker image",
    description: "Poll one worker image for build and validation state.",
    inputSchema: imageReferenceSchema(false),
    annotations: readAnnotations,
    requiredScopes: ["x1.worker_images.read"],
  },
  {
    name: "worker_images.create_from_dockerfile",
    title: "Create a worker image from a Dockerfile",
    description: "Create a workspace worker image and enqueue its asynchronous build.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
        name: { type: "string", minLength: 1, maxLength: 63 },
        display_name: { type: "string", minLength: 1, maxLength: 128 },
        description: { type: ["string", "null"], maxLength: 1024 },
        dockerfile_source: {
          type: "string",
          minLength: 1,
          maxLength: 65536,
          writeOnly: true,
        },
      },
      required: [
        "workspace",
        "idempotency_key",
        "name",
        "display_name",
        "dockerfile_source",
      ],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.worker_images.write"],
  },
  {
    name: "worker_images.register_oci",
    title: "Register an OCI worker image",
    description: "Register a digest-pinned image from an allowlisted OCI registry and enqueue manifest validation.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
        name: { type: "string", minLength: 1, maxLength: 63 },
        display_name: { type: "string", minLength: 1, maxLength: 128 },
        description: { type: ["string", "null"], maxLength: 1024 },
        oci_reference: {
          type: "string",
          minLength: 80,
          maxLength: 512,
          description: "Digest-pinned registry/repository@sha256:<digest> reference",
        },
      },
      required: [
        "workspace",
        "idempotency_key",
        "name",
        "display_name",
        "oci_reference",
      ],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.worker_images.write"],
  },
  {
    name: "worker_images.update",
    title: "Update a worker image",
    description: "Update display metadata or Dockerfile source; source changes enqueue a new build.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        image: { type: "string" },
        display_name: { type: "string", minLength: 1, maxLength: 128 },
        description: { type: ["string", "null"], maxLength: 1024 },
        dockerfile_source: {
          type: "string",
          minLength: 1,
          maxLength: 65536,
          writeOnly: true,
        },
      },
      required: ["workspace", "image"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.worker_images.write"],
  },
  {
    name: "worker_images.rebuild",
    title: "Rebuild a worker image",
    description: "Idempotently enqueue a rebuild unless one is already in progress.",
    inputSchema: imageReferenceSchema(false),
    annotations: writeAnnotations,
    requiredScopes: ["x1.worker_images.write"],
  },
  {
    name: "worker_images.delete",
    title: "Delete a worker image",
    description: "Delete an unused workspace worker image after explicit ID confirmation.",
    inputSchema: imageReferenceSchema(true),
    annotations: { ...writeAnnotations, destructiveHint: true },
    requiredScopes: ["x1.worker_images.write"],
  },
  {
    name: "artifacts.list",
    title: "List artifacts",
    description: "List share artifact metadata from one visible session.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        session: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["workspace", "session"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.artifacts.read", "x1.sessions.read"],
  },
  {
    name: "artifacts.read",
    title: "Read an artifact",
    description: "Read one authorized artifact file inline up to 1 MiB with path traversal protection.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        session: { type: "string" },
        share: { type: "string" },
        path: { type: "string", maxLength: 1024 },
      },
      required: ["workspace", "session", "share"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.artifacts.read", "x1.sessions.read"],
  },
  {
    name: "costs.session.get",
    title: "Get session cost",
    description: "Get token usage and estimated model cost for one visible session.",
    inputSchema: sessionReferenceSchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.costs.read", "x1.sessions.read"],
  },
  {
    name: "costs.session_tree.get",
    title: "Get session-tree cost",
    description: "Get visibility-filtered cost for a root session and its spawned descendants.",
    inputSchema: sessionReferenceSchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.costs.read", "x1.sessions.read"],
  },
  {
    name: "costs.agent.get",
    title: "Get agent cost",
    description: "Get a visibility-filtered cost rollup for an accessible agent.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        window: { type: "string", enum: ["24h", "7d", "30d", "all"] },
      },
      required: ["workspace", "agent"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.costs.read", "x1.agents.read"],
  },
  {
    name: "costs.workspace.get",
    title: "Get workspace cost",
    description: "Get an owner/admin workspace cost rollup for a bounded date range.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        since: { type: "string", format: "date-time" },
        until: { type: "string", format: "date-time" },
      },
      required: ["workspace", "since", "until"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.costs.read"],
  },
  {
    name: "sessions.list",
    title: "List agent sessions",
    description: "List only sessions visible to the caller for one accessible agent.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string" },
      },
      required: ["workspace", "agent"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.sessions.read", "x1.agents.read"],
  },
  {
    name: "sessions.get",
    title: "Get a session",
    description: "Get one visible same-workspace session with parent, status, summary, runtime, and model metadata.",
    inputSchema: sessionReferenceSchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.sessions.read", "x1.agents.read"],
  },
  {
    name: "sessions.events",
    title: "List session events",
    description: "Read a bounded forward page of events for one visible session.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        session: { type: "string" },
        after_seq: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["workspace", "session"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.sessions.read", "x1.agents.read"],
  },
  {
    name: "sessions.trigger",
    title: "Trigger an agent validation run",
    description: "Start one bounded validation run as the authenticated user with immutable effective configuration snapshots.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
        task: { type: "string", minLength: 1, maxLength: 32768 },
        runtime_type: { type: "string" },
        model: { type: "string", minLength: 1, maxLength: 255 },
      },
      required: ["workspace", "agent", "idempotency_key", "task"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.sessions.write", "x1.agents.read"],
  },
  {
    name: "sessions.cancel",
    title: "Cancel an agent validation run",
    description: "Idempotently cancel a visible validation run started by the authenticated caller.",
    inputSchema: sessionReferenceSchema(),
    annotations: { ...writeAnnotations, destructiveHint: true },
    requiredScopes: ["x1.sessions.write", "x1.sessions.read"],
  },
  {
    name: "preview_environments.list",
    title: "List preview environments",
    description: "List safe fields for durable preview environments. Legacy records require workspace admin access.",
    inputSchema: workspaceOnlySchema(),
    annotations: readAnnotations,
    requiredScopes: ["x1.preview_environments.read"],
  },
  {
    name: "preview_environments.get",
    title: "Get a preview environment",
    description: "Get one same-workspace preview environment by immutable ID.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        preview_environment: { type: "string" },
      },
      required: ["workspace", "preview_environment"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.preview_environments.read"],
  },
  {
    name: "mcp_configurations.list",
    title: "List workspace MCP configurations",
    description:
      "List redacted MCP catalog entries configured in one workspace.",
    inputSchema: {
      type: "object",
      properties: workspaceProperty,
      required: ["workspace"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.mcp_configurations.read"],
  },
  {
    name: "mcp_configurations.get",
    title: "Get an MCP configuration",
    description: "Get one redacted workspace MCP configuration.",
    inputSchema: {
      type: "object",
      properties: { ...workspaceProperty, ...mcpConfigurationProperty },
      required: ["workspace", "mcp_configuration"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.mcp_configurations.read"],
  },
  {
    name: "mcp_configurations.create",
    title: "Create an MCP configuration",
    description:
      "Create a validated stdio or remote OAuth MCP configuration in a workspace.",
    inputSchema: mcpConfigurationSetSchema(false),
    annotations: writeAnnotations,
    requiredScopes: ["x1.mcp_configurations.write"],
  },
  {
    name: "mcp_configurations.update",
    title: "Update an MCP configuration",
    description:
      "Update one workspace MCP configuration while preserving its stable name.",
    inputSchema: mcpConfigurationSetSchema(true),
    annotations: writeAnnotations,
    requiredScopes: ["x1.mcp_configurations.write"],
  },
  {
    name: "mcp_configurations.delete",
    title: "Delete an MCP configuration",
    description:
      "Delete an unused MCP configuration. Attached configurations return mcp_configuration_in_use.",
    inputSchema: {
      type: "object",
      properties: { ...workspaceProperty, ...mcpConfigurationProperty },
      required: ["workspace", "mcp_configuration"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    requiredScopes: ["x1.mcp_configurations.write"],
  },
  {
    name: "agents.mcp_attachments.list",
    title: "List agent MCP attachments",
    description:
      "List MCP attachments for one accessible agent. Literal environment values are redacted.",
    inputSchema: {
      type: "object",
      properties: { ...workspaceProperty, ...agentProperty },
      required: ["workspace", "agent"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
    requiredScopes: ["x1.agents.read", "x1.mcp_configurations.read"],
  },
  {
    name: "agents.mcp_attachments.set",
    title: "Attach or update an MCP on an agent",
    description:
      "Idempotently attach a workspace MCP configuration to an editable agent or update its environment and tool scopes.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        ...mcpConfigurationProperty,
        environment: { type: "object", additionalProperties: true },
        tool_scopes: { type: "array", items: { type: "string" }, maxItems: 200 },
      },
      required: ["workspace", "agent", "mcp_configuration"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.agents.write", "x1.mcp_configurations.write"],
  },
  {
    name: "agents.mcp_attachments.remove",
    title: "Remove an MCP from an agent",
    description: "Idempotently remove one MCP attachment from an editable agent.",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        ...agentProperty,
        attachment: { type: "string", description: "Attachment ID" },
      },
      required: ["workspace", "agent", "attachment"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
    requiredScopes: ["x1.agents.write", "x1.mcp_configurations.write"],
  },
];

function mcpConfigurationSetSchema(update: boolean) {
  return {
    type: "object",
    properties: {
      ...workspaceProperty,
      ...(update ? mcpConfigurationProperty : {}),
      name: { type: "string", maxLength: 64 },
      display_name: { type: ["string", "null"], maxLength: 200 },
      kind: { type: "string", enum: ["stdio", "remote_oauth"] },
      image: { type: ["string", "null"], maxLength: 512 },
      command: { type: ["string", "null"], maxLength: 64 },
      args: { type: "array", items: { type: "string" }, maxItems: 32 },
      url: { type: ["string", "null"], maxLength: 2048 },
      manifest: { type: "object", additionalProperties: true },
      description: { type: "string", maxLength: 2000 },
      ...(update
        ? { expected_updated_at: { type: "string", format: "date-time" } }
        : {}),
    },
    required: update
      ? ["workspace", "mcp_configuration", "expected_updated_at"]
      : ["workspace", "name", "kind", "manifest"],
    additionalProperties: false,
  };
}

function workspaceOnlySchema() {
  return {
    type: "object",
    properties: workspaceProperty,
    required: ["workspace"],
    additionalProperties: false,
  };
}

function agentReferenceSchema() {
  return {
    type: "object",
    properties: { ...workspaceProperty, ...agentProperty },
    required: ["workspace", "agent"],
    additionalProperties: false,
  };
}

function agentRepositorySchema(includeInstallation: boolean) {
  return {
    type: "object",
    properties: {
      ...workspaceProperty,
      ...agentProperty,
      ...(includeInstallation
        ? { installation_id: { type: "integer", minimum: 1 } }
        : {}),
      repo_full_name: { type: "string", minLength: 3, maxLength: 255 },
      branch: { type: "string", minLength: 1, maxLength: 255 },
      mount_path: { type: "string", minLength: 1, maxLength: 255 },
      auto_push: { type: "boolean" },
      allow_push: { type: "boolean" },
    },
    required: [
      "workspace",
      "agent",
      ...(includeInstallation ? ["installation_id"] : []),
      "repo_full_name",
    ],
    additionalProperties: false,
  };
}

function imageReferenceSchema(includeConfirmation: boolean) {
  return {
    type: "object",
    properties: {
      ...workspaceProperty,
      image: { type: "string" },
      ...(includeConfirmation ? { confirm_id: { type: "string" } } : {}),
    },
    required: [
      "workspace",
      "image",
      ...(includeConfirmation ? ["confirm_id"] : []),
    ],
    additionalProperties: false,
  };
}

function collectionReferenceSchema(includeConfirmation: boolean) {
  return {
    type: "object",
    properties: {
      ...workspaceProperty,
      collection: { type: "string" },
      ...(includeConfirmation ? { confirm_id: { type: "string" } } : {}),
    },
    required: [
      "workspace",
      "collection",
      ...(includeConfirmation ? ["confirm_id"] : []),
    ],
    additionalProperties: false,
  };
}

function sessionReferenceSchema() {
  return {
    type: "object",
    properties: {
      ...workspaceProperty,
      session: { type: "string" },
    },
    required: ["workspace", "session"],
    additionalProperties: false,
  };
}

function contextFileReferenceSchema() {
  return {
    type: "object",
    properties: {
      ...workspaceProperty,
      ...agentProperty,
      path: { type: "string", minLength: 1, maxLength: 240 },
    },
    required: ["workspace", "agent", "path"],
    additionalProperties: false,
  };
}

function hasScopes(principal: OAuthPrincipal, required: readonly string[]) {
  return required.every((scope) => principal.scopes.includes(scope));
}

function value(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const result = typeof args[key] === "string" ? args[key].trim() : "";
  if (!result) {
    throw new AdminMcpOperationError(
      "validation_error",
      `${key} is required`,
      { field: key },
    );
  }
  return result;
}

function requiredPositiveInteger(
  args: Record<string, unknown>,
  key: string,
): number {
  const result = args[key];
  if (typeof result !== "number" || !Number.isInteger(result) || result < 1) {
    throw new AdminMcpOperationError(
      "validation_error",
      `${key} must be a positive integer`,
      { field: key },
    );
  }
  return result;
}

function result(payload: Record<string, unknown>) {
  const envelope = {
    ...payload,
    schema_version: 1,
    request_id: randomUUID(),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}

function errorResult(error: unknown) {
  const known =
    error instanceof AdminMcpOperationError
      ? {
          code: error.code,
          message: error.message,
          details: error.details,
        }
      : error instanceof DomainError
        ? { code: error.code, message: error.message }
        : {
            code: "internal_error",
            message: "Administrative MCP operation failed",
          };
  const payload = {
    error: {
      code: known.code ?? "internal_error",
      message: known.message ?? "Administrative MCP operation failed",
      ...(known.details ? { details: known.details } : {}),
    },
  };
  return {
    ...result(payload),
    isError: true,
  };
}

function findStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") return record[key] as string;
  for (const child of Object.values(record)) {
    const found = findStringField(child, key);
    if (found) return found;
  }
  return undefined;
}

function mutationSchema(schema: Record<string, unknown>) {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  return {
    ...schema,
    properties: {
      ...properties,
      idempotency_key: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Stable retry key scoped to actor, OAuth client, and tool",
      },
    },
    required: [...new Set([...required, "idempotency_key"])],
  };
}

export class AdminMcpTools {
  constructor(
    private readonly workspaces: AdminMcpWorkspaceReader,
    private readonly controlPlane?: AdminMcpControlPlane,
    private readonly operationStore?: AdminMcpOperationStore,
  ) {}

  private operations(): AdminMcpControlPlane {
    if (!this.controlPlane) {
      throw new AdminMcpOperationError(
        "feature_disabled",
        "administrative MCP control-plane tools are not configured",
      );
    }
    return this.controlPlane;
  }

  list(principal: OAuthPrincipal) {
    return tools
      .filter((tool) => hasScopes(principal, tool.requiredScopes))
      .map(({ requiredScopes: _requiredScopes, ...tool }) => ({
        ...tool,
        inputSchema: tool.annotations.readOnlyHint
          ? tool.inputSchema
          : mutationSchema(tool.inputSchema),
      }));
  }

  async call(principal: OAuthPrincipal, name: string, rawArgs: unknown) {
    try {
      return await this.callInternal(principal, name, rawArgs);
    } catch (error) {
      return errorResult(error);
    }
  }

  private async callInternal(
    principal: OAuthPrincipal,
    name: string,
    rawArgs: unknown,
  ) {
    const definition = tools.find((tool) => tool.name === name);
    if (!definition || !hasScopes(principal, definition.requiredScopes)) {
      return errorResult(
        new AdminMcpOperationError("forbidden", `tool is not available: ${name}`),
      );
    }
    const args = value(rawArgs);
    const internallyIdempotent = new Set([
      "agents.create",
      "collections.create",
      "worker_images.create_from_dockerfile",
      "worker_images.register_oci",
      "sessions.trigger",
    ]);
    let genericClaimed = false;
    let response:
      | ReturnType<typeof result>
      | ReturnType<typeof errorResult>
      | undefined;
    if (
      !definition.annotations.readOnlyHint &&
      this.operationStore &&
      !internallyIdempotent.has(name)
    ) {
      const idempotencyKey = requiredString(args, "idempotency_key");
      const claim = await this.operationStore.claim({
        principal,
        toolName: name,
        idempotencyKey,
        requestHash: adminMcpRequestHash(args),
      });
      if (claim.kind === "conflict") {
        response = errorResult(
          new AdminMcpOperationError(
            "idempotency_conflict",
            "idempotency_key was already used with different input",
          ),
        );
      } else if (claim.kind === "in_progress") {
        response = errorResult(
          new AdminMcpOperationError(
            "conflict",
            "an operation with this idempotency_key is still in progress",
            { retryable: true },
          ),
        );
      } else if (claim.kind === "replay") {
        response = result({ ...claim.result, replayed: true });
      } else {
        genericClaimed = true;
      }
    }
    response ??= await this.dispatch(principal, name, rawArgs);
    if (genericClaimed && this.operationStore) {
      const idempotencyKey = String(args.idempotency_key);
      if ("isError" in response && response.isError) {
        await this.operationStore.fail({
          principal,
          toolName: name,
          idempotencyKey,
        });
      } else {
        await this.operationStore.complete({
          principal,
          toolName: name,
          idempotencyKey,
          result: response.structuredContent,
        });
      }
    }
    if (
      !definition.annotations.readOnlyHint &&
      this.operationStore
    ) {
      const structured = response.structuredContent as Record<string, unknown>;
      const error = structured.error as
        | { code?: string }
        | undefined;
      await this.operationStore.audit({
        principal,
        workspaceId: findStringField(structured, "workspace_id"),
        toolName: name,
        resourceType: name.split(".")[0],
        resourceId:
          findStringField(structured, "id") ??
          (typeof args.agent === "string" ? args.agent : undefined),
        outcome:
          "isError" in response && response.isError ? "error" : "success",
        errorCode: error?.code,
        requestId:
          typeof structured.request_id === "string"
            ? structured.request_id
            : undefined,
        idempotencyKey:
          typeof args.idempotency_key === "string"
            ? args.idempotency_key
            : undefined,
        metadata: {
          workspace_slug:
            typeof args.workspace === "string" ? args.workspace : null,
          changed_fields: Object.keys(args)
            .filter(
              (key) =>
                ![
                  "workspace",
                  "agent",
                  "idempotency_key",
                  "confirm_id",
                ].includes(key),
            )
            .sort(),
        },
      });
    }
    return response;
  }

  private async dispatch(
    principal: OAuthPrincipal,
    name: string,
    rawArgs: unknown,
  ) {
    const definition = tools.find((tool) => tool.name === name);
    if (!definition || !hasScopes(principal, definition.requiredScopes)) {
      return errorResult(
        new AdminMcpOperationError("forbidden", `tool is not available: ${name}`),
      );
    }
    const args = value(rawArgs);
    try {
      if (name === "documentation.search") {
        return result({
          results: searchGuidance(requiredString(args, "query")),
        });
      }
      if (name === "documentation.read") {
        const page = readGuidance(requiredString(args, "uri"));
        if (!page) {
          throw new AdminMcpOperationError(
            "not_found",
            "documentation page not found",
          );
        }
        return result({ page });
      }
      if (name === "workspaces.list") {
        return result({
          workspaces: await this.workspaces.listForUser(principal.userId),
        });
      }
      if (name === "workspaces.get") {
        const workspace = await this.workspaces.getForUser(
          principal.userId,
          requiredString(args, "workspace"),
        );
        if (!workspace) {
          throw new AdminMcpOperationError("not_found", "workspace not found");
        }
        return result({ workspace });
      }
      if (name === "agents.list") {
        return result(
          await this.operations().listAgents(principal, {
            workspace: requiredString(args, "workspace"),
            kind: args.kind as "worker" | "orchestrator" | "scheduled" | undefined,
            runtime: typeof args.runtime === "string" ? args.runtime : undefined,
            active: typeof args.active === "boolean" ? args.active : undefined,
            owner: typeof args.owner === "string" ? args.owner : undefined,
            search: typeof args.search === "string" ? args.search : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
            cursor: typeof args.cursor === "string" ? args.cursor : undefined,
          }),
        );
      }
      if (name === "agents.get") {
        return result(
          await this.operations().getAgent(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
          }),
        );
      }
      if (name === "agents.create") {
        return result(
          await this.operations().createAgent(principal, {
            workspace: requiredString(args, "workspace"),
            idempotency_key: requiredString(args, "idempotency_key"),
            slug: requiredString(args, "slug"),
            name: requiredString(args, "name"),
            runtime_type:
              typeof args.runtime_type === "string"
                ? args.runtime_type
                : undefined,
            kind: args.kind as "worker" | "orchestrator" | "scheduled" | undefined,
            system_prompt:
              typeof args.system_prompt === "string"
                ? args.system_prompt
                : undefined,
            heartbeat_md:
              typeof args.heartbeat_md === "string"
                ? args.heartbeat_md
                : undefined,
            schedule:
              typeof args.schedule === "string" || args.schedule === null
                ? args.schedule
                : undefined,
            image_id:
              typeof args.image_id === "string" || args.image_id === null
                ? args.image_id
                : undefined,
            model:
              typeof args.model === "string" || args.model === null
                ? args.model
                : undefined,
            visibility: args.visibility as
              | "private"
              | "workspace"
              | "via_grants"
              | undefined,
            scheduled_run_as_user_id:
              typeof args.scheduled_run_as_user_id === "string" ||
              args.scheduled_run_as_user_id === null
                ? args.scheduled_run_as_user_id
                : undefined,
            idle_timeout_seconds:
              typeof args.idle_timeout_seconds === "number" ||
              args.idle_timeout_seconds === null
                ? args.idle_timeout_seconds
                : undefined,
            skill_sources: args.skill_sources,
          }),
        );
      }
      if (name === "agents.update") {
        return result(
          await this.operations().updateAgent(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            expected_updated_at: requiredString(args, "expected_updated_at"),
            name: typeof args.name === "string" ? args.name : undefined,
            runtime_type:
              typeof args.runtime_type === "string"
                ? args.runtime_type
                : undefined,
            kind: args.kind as "worker" | "orchestrator" | "scheduled" | undefined,
            system_prompt:
              typeof args.system_prompt === "string"
                ? args.system_prompt
                : undefined,
            heartbeat_md:
              typeof args.heartbeat_md === "string"
                ? args.heartbeat_md
                : undefined,
            schedule:
              typeof args.schedule === "string" || args.schedule === null
                ? args.schedule
                : undefined,
            is_active:
              typeof args.is_active === "boolean" ? args.is_active : undefined,
            image_id:
              typeof args.image_id === "string" || args.image_id === null
                ? args.image_id
                : undefined,
            model:
              typeof args.model === "string" || args.model === null
                ? args.model
                : undefined,
            owner_user_id:
              typeof args.owner_user_id === "string" ||
              args.owner_user_id === null
                ? args.owner_user_id
                : undefined,
            visibility: args.visibility as
              | "private"
              | "workspace"
              | "via_grants"
              | undefined,
            scheduled_run_as_user_id:
              typeof args.scheduled_run_as_user_id === "string" ||
              args.scheduled_run_as_user_id === null
                ? args.scheduled_run_as_user_id
                : undefined,
            idle_timeout_seconds:
              typeof args.idle_timeout_seconds === "number" ||
              args.idle_timeout_seconds === null
                ? args.idle_timeout_seconds
                : undefined,
            skill_sources: args.skill_sources,
          }),
        );
      }
      if (name === "agents.delete") {
        return result(
          await this.operations().deleteAgent(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            confirm_id: requiredString(args, "confirm_id"),
          }),
        );
      }
      if (name === "agents.context.inspect") {
        return result(
          await this.operations().inspectAgentContext(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
          }),
        );
      }
      if (name === "agents.context_files.list") {
        return result(
          await this.operations().listContextFiles(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
          }),
        );
      }
      if (name === "agents.context_files.get") {
        return result(
          await this.operations().getContextFile(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            path: requiredString(args, "path"),
          }),
        );
      }
      if (name === "agents.context_files.put") {
        return result(
          await this.operations().putContextFile(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            path: requiredString(args, "path"),
            mime_type: requiredString(args, "mime_type"),
            content:
              typeof args.content === "string"
                ? args.content
                : requiredString(args, "content"),
            expected_revision:
              typeof args.expected_revision === "number" ||
              args.expected_revision === null
                ? args.expected_revision
                : undefined,
          }),
        );
      }
      if (name === "agents.context_files.delete") {
        return result(
          await this.operations().deleteContextFile(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            path: requiredString(args, "path"),
          }),
        );
      }
      if (name === "agents.validate_configuration") {
        return result(
          await this.operations().validateAgentConfiguration(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            proposed:
              args.proposed && typeof args.proposed === "object"
                ? (args.proposed as Record<string, unknown>)
                : undefined,
          }),
        );
      }
      if (name === "repositories.installations.list") {
        return result(
          await this.operations().listRepositoryInstallations(principal, {
            workspace: requiredString(args, "workspace"),
          }),
        );
      }
      if (name === "repositories.available.list") {
        return result(
          await this.operations().listAvailableRepositories(principal, {
            workspace: requiredString(args, "workspace"),
            installation_id: requiredPositiveInteger(args, "installation_id"),
          }),
        );
      }
      if (name === "agents.repositories.list") {
        return result(
          await this.operations().listAgentRepositories(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
          }),
        );
      }
      if (name === "agents.repositories.attach") {
        return result(
          await this.operations().attachAgentRepository(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            installation_id: requiredPositiveInteger(args, "installation_id"),
            repo_full_name: requiredString(args, "repo_full_name"),
            branch: typeof args.branch === "string" ? args.branch : undefined,
            mount_path:
              typeof args.mount_path === "string" ? args.mount_path : undefined,
            auto_push:
              typeof args.auto_push === "boolean" ? args.auto_push : undefined,
            allow_push:
              typeof args.allow_push === "boolean" ? args.allow_push : undefined,
          }),
        );
      }
      if (name === "agents.repositories.update") {
        return result(
          await this.operations().updateAgentRepository(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            repo_full_name: requiredString(args, "repo_full_name"),
            branch: typeof args.branch === "string" ? args.branch : undefined,
            mount_path:
              typeof args.mount_path === "string" ? args.mount_path : undefined,
            auto_push:
              typeof args.auto_push === "boolean" ? args.auto_push : undefined,
            allow_push:
              typeof args.allow_push === "boolean" ? args.allow_push : undefined,
          }),
        );
      }
      if (name === "agents.repositories.detach") {
        return result(
          await this.operations().detachAgentRepository(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            repo_full_name: requiredString(args, "repo_full_name"),
          }),
        );
      }
      if (name === "agents.spawn_grants.list") {
        return result(
          await this.operations().listSpawnGrants(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
          }),
        );
      }
      if (name === "agents.spawn_grants.create") {
        return result(
          await this.operations().createSpawnGrant(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            child_agent: requiredString(args, "child_agent"),
            allowed_runtime_types: Array.isArray(args.allowed_runtime_types)
              ? (args.allowed_runtime_types as string[])
              : undefined,
            allowed_models: Array.isArray(args.allowed_models)
              ? (args.allowed_models as string[])
              : undefined,
            reason:
              typeof args.reason === "string" || args.reason === null
                ? args.reason
                : undefined,
          }),
        );
      }
      if (name === "agents.spawn_grants.revoke") {
        return result(
          await this.operations().revokeSpawnGrant(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            grant: requiredString(args, "grant"),
          }),
        );
      }
      if (name === "collections.list") {
        return result(
          await this.operations().listCollections(principal, {
            workspace: requiredString(args, "workspace"),
          }),
        );
      }
      if (name === "collections.get") {
        return result(
          await this.operations().getCollection(principal, {
            workspace: requiredString(args, "workspace"),
            collection: requiredString(args, "collection"),
          }),
        );
      }
      if (name === "collections.create") {
        return result(
          await this.operations().createCollection(principal, {
            workspace: requiredString(args, "workspace"),
            idempotency_key: requiredString(args, "idempotency_key"),
            name: requiredString(args, "name"),
            slug: requiredString(args, "slug"),
            description:
              typeof args.description === "string" || args.description === null
                ? args.description
                : undefined,
            provider_type:
              typeof args.provider_type === "string"
                ? args.provider_type
                : undefined,
            settings:
              args.settings && typeof args.settings === "object"
                ? (args.settings as Record<string, unknown>)
                : undefined,
          }),
        );
      }
      if (name === "collections.update") {
        return result(
          await this.operations().updateCollection(principal, {
            workspace: requiredString(args, "workspace"),
            collection: requiredString(args, "collection"),
            expected_updated_at: requiredString(args, "expected_updated_at"),
            name: typeof args.name === "string" ? args.name : undefined,
            description:
              typeof args.description === "string" || args.description === null
                ? args.description
                : undefined,
            settings:
              args.settings && typeof args.settings === "object"
                ? (args.settings as Record<string, unknown>)
                : undefined,
          }),
        );
      }
      if (name === "collections.delete") {
        return result(
          await this.operations().deleteCollection(principal, {
            workspace: requiredString(args, "workspace"),
            collection: requiredString(args, "collection"),
            confirm_id: requiredString(args, "confirm_id"),
          }),
        );
      }
      if (name === "collections.retry_provision") {
        return result(
          await this.operations().retryCollectionProvision(principal, {
            workspace: requiredString(args, "workspace"),
            collection: requiredString(args, "collection"),
          }),
        );
      }
      if (name === "agents.collections.list") {
        return result(
          await this.operations().listAgentCollections(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
          }),
        );
      }
      if (name === "agents.collections.set") {
        return result(
          await this.operations().setAgentCollections(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            expected_agent_updated_at: requiredString(
              args,
              "expected_agent_updated_at",
            ),
            collection_ids: Array.isArray(args.collection_ids)
              ? (args.collection_ids as string[])
              : [],
            default_collection_id:
              typeof args.default_collection_id === "string" ||
              args.default_collection_id === null
                ? args.default_collection_id
                : undefined,
          }),
        );
      }
      if (name === "worker_images.list") {
        return result(
          await this.operations().listWorkerImages(principal, {
            workspace: requiredString(args, "workspace"),
          }),
        );
      }
      if (name === "worker_images.get") {
        return result(
          await this.operations().getWorkerImage(principal, {
            workspace: requiredString(args, "workspace"),
            image: requiredString(args, "image"),
          }),
        );
      }
      if (name === "worker_images.create_from_dockerfile") {
        return result(
          await this.operations().createWorkerImage(principal, {
            workspace: requiredString(args, "workspace"),
            idempotency_key: requiredString(args, "idempotency_key"),
            name: requiredString(args, "name"),
            display_name: requiredString(args, "display_name"),
            description:
              typeof args.description === "string" || args.description === null
                ? args.description
                : undefined,
            dockerfile_source: requiredString(args, "dockerfile_source"),
          }),
        );
      }
      if (name === "worker_images.register_oci") {
        return result(
          await this.operations().registerOciWorkerImage(principal, {
            workspace: requiredString(args, "workspace"),
            idempotency_key: requiredString(args, "idempotency_key"),
            name: requiredString(args, "name"),
            display_name: requiredString(args, "display_name"),
            description:
              typeof args.description === "string" || args.description === null
                ? args.description
                : undefined,
            oci_reference: requiredString(args, "oci_reference"),
          }),
        );
      }
      if (name === "worker_images.update") {
        return result(
          await this.operations().updateWorkerImage(principal, {
            workspace: requiredString(args, "workspace"),
            image: requiredString(args, "image"),
            display_name:
              typeof args.display_name === "string"
                ? args.display_name
                : undefined,
            description:
              typeof args.description === "string" || args.description === null
                ? args.description
                : undefined,
            dockerfile_source:
              typeof args.dockerfile_source === "string"
                ? args.dockerfile_source
                : undefined,
          }),
        );
      }
      if (name === "worker_images.rebuild") {
        return result(
          await this.operations().rebuildWorkerImage(principal, {
            workspace: requiredString(args, "workspace"),
            image: requiredString(args, "image"),
          }),
        );
      }
      if (name === "worker_images.delete") {
        return result(
          await this.operations().deleteWorkerImage(principal, {
            workspace: requiredString(args, "workspace"),
            image: requiredString(args, "image"),
            confirm_id: requiredString(args, "confirm_id"),
          }),
        );
      }
      if (name === "artifacts.list") {
        return result(
          await this.operations().listArtifacts(principal, {
            workspace: requiredString(args, "workspace"),
            session: requiredString(args, "session"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        );
      }
      if (name === "artifacts.read") {
        return result(
          await this.operations().readArtifact(principal, {
            workspace: requiredString(args, "workspace"),
            session: requiredString(args, "session"),
            share: requiredString(args, "share"),
            path: typeof args.path === "string" ? args.path : undefined,
          }),
        );
      }
      if (name === "costs.session.get") {
        return result(
          await this.operations().getSessionCost(principal, {
            workspace: requiredString(args, "workspace"),
            session: requiredString(args, "session"),
          }),
        );
      }
      if (name === "costs.session_tree.get") {
        return result(
          await this.operations().getSessionTreeCost(principal, {
            workspace: requiredString(args, "workspace"),
            session: requiredString(args, "session"),
          }),
        );
      }
      if (name === "costs.agent.get") {
        return result(
          await this.operations().getAgentCost(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            window: args.window as "24h" | "7d" | "30d" | "all" | undefined,
          }),
        );
      }
      if (name === "costs.workspace.get") {
        return result(
          await this.operations().getWorkspaceCost(principal, {
            workspace: requiredString(args, "workspace"),
            since: requiredString(args, "since"),
            until: requiredString(args, "until"),
          }),
        );
      }
      if (name === "sessions.list") {
        return result(
          await this.operations().listSessions(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
            cursor: typeof args.cursor === "string" ? args.cursor : undefined,
          }),
        );
      }
      if (name === "sessions.get") {
        return result(
          await this.operations().getSession(principal, {
            workspace: requiredString(args, "workspace"),
            session: requiredString(args, "session"),
          }),
        );
      }
      if (name === "sessions.events") {
        return result(
          await this.operations().listSessionEvents(principal, {
            workspace: requiredString(args, "workspace"),
            session: requiredString(args, "session"),
            after_seq:
              typeof args.after_seq === "number" ? args.after_seq : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        );
      }
      if (name === "sessions.trigger") {
        return result(
          await this.operations().triggerValidationSession(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            idempotency_key: requiredString(args, "idempotency_key"),
            task: requiredString(args, "task"),
            runtime_type:
              typeof args.runtime_type === "string"
                ? args.runtime_type
                : undefined,
            model: typeof args.model === "string" ? args.model : undefined,
          }),
        );
      }
      if (name === "sessions.cancel") {
        return result(
          await this.operations().cancelValidationSession(principal, {
            workspace: requiredString(args, "workspace"),
            session: requiredString(args, "session"),
          }),
        );
      }
      if (name === "preview_environments.list") {
        return result(
          await this.operations().listPreviewEnvironments(principal, {
            workspace: requiredString(args, "workspace"),
          }),
        );
      }
      if (name === "preview_environments.get") {
        return result(
          await this.operations().getPreviewEnvironment(principal, {
            workspace: requiredString(args, "workspace"),
            preview_environment: requiredString(
              args,
              "preview_environment",
            ),
          }),
        );
      }
      if (name === "mcp_configurations.list") {
        return result(
          await this.operations().listMcpConfigurations(principal, {
            workspace: requiredString(args, "workspace"),
          }),
        );
      }
      if (name === "mcp_configurations.get") {
        return result(
          await this.operations().getMcpConfiguration(principal, {
            workspace: requiredString(args, "workspace"),
            mcp_configuration: requiredString(args, "mcp_configuration"),
          }),
        );
      }
      if (
        name === "mcp_configurations.create" ||
        name === "mcp_configurations.update"
      ) {
        return result(
          await this.operations().setMcpConfiguration(principal, {
            workspace: requiredString(args, "workspace"),
            mcp_configuration:
              name === "mcp_configurations.update"
                ? requiredString(args, "mcp_configuration")
                : undefined,
            name: typeof args.name === "string" ? args.name : undefined,
            display_name:
              typeof args.display_name === "string" || args.display_name === null
                ? args.display_name
                : undefined,
            kind: args.kind as "stdio" | "remote_oauth" | undefined,
            image:
              typeof args.image === "string" || args.image === null
                ? args.image
                : undefined,
            command:
              typeof args.command === "string" || args.command === null
                ? args.command
                : undefined,
            args: Array.isArray(args.args) ? (args.args as string[]) : undefined,
            url:
              typeof args.url === "string" || args.url === null
                ? args.url
                : undefined,
            manifest: args.manifest,
            description:
              typeof args.description === "string" ? args.description : undefined,
            expected_updated_at:
              name === "mcp_configurations.update"
                ? requiredString(args, "expected_updated_at")
                : undefined,
          }),
        );
      }
      if (name === "mcp_configurations.delete") {
        return result(
          await this.operations().deleteMcpConfiguration(principal, {
            workspace: requiredString(args, "workspace"),
            mcp_configuration: requiredString(args, "mcp_configuration"),
          }),
        );
      }
      if (name === "agents.mcp_attachments.list") {
        return result(
          await this.operations().listMcpAttachments(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
          }),
        );
      }
      if (name === "agents.mcp_attachments.set") {
        return result(
          await this.operations().setMcpAttachment(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            mcp_configuration: requiredString(args, "mcp_configuration"),
            environment:
              args.environment && typeof args.environment === "object"
                ? (args.environment as Record<string, unknown>)
                : undefined,
            tool_scopes: Array.isArray(args.tool_scopes)
              ? (args.tool_scopes as string[])
              : undefined,
          }),
        );
      }
      if (name === "agents.mcp_attachments.remove") {
        return result(
          await this.operations().removeMcpAttachment(principal, {
            workspace: requiredString(args, "workspace"),
            agent: requiredString(args, "agent"),
            attachment: requiredString(args, "attachment"),
          }),
        );
      }
      throw new AdminMcpOperationError("not_found", `unknown tool: ${name}`);
    } catch (error) {
      return errorResult(error);
    }
  }
}
