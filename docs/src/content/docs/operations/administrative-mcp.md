---
title: Administrative MCP
description: Manage X1Agent workspaces and agents from an authenticated MCP client.
---

X1Agent exposes a remote administrative MCP endpoint at `/mcp`. It is separate
from the session-sidecar MCP used inside running agent pods. Administrative MCP
calls act as the signed-in human user and never bypass workspace membership,
agent grants, or workspace security policy.

## Enable access

Administrative MCP access has two gates:

1. The installation must set `ADMIN_MCP_ENABLED=true`.
2. A workspace owner or administrator must enable administrative MCP access for
   that workspace.

Disabling either gate takes effect on the next request. OAuth scopes do not
grant workspace roles: every tool call reloads current membership and resource
permissions.

## Connect a client

Use the public X1Agent MCP URL for the installation:

```text
https://x1agent.example.com/mcp
```

The client discovers X1Agent's OAuth endpoints, opens the browser authorization
flow, and stores a revocable user token. Tokens can cover multiple enabled
workspaces, but each operation remains scoped to the workspace named in the
tool input.

## Administrative catalog

The catalog covers the complete agent setup and operations loop:

- Workspace discovery and agent lifecycle, configuration inspection, managed
  context files, and dry-run configuration validation.
- GitHub installations and repositories, agent repository attachments, and
  orchestrator spawn grants.
- Asynchronously provisioned collections and atomic agent collection sets.
- Dockerfile-built and digest-pinned OCI worker images, including build or
  validation status, rebuild, and deletion.
- Session list, detail, events, bounded validation triggers, cancellation,
  artifacts, and visibility-filtered cost rollups.
- Preview-environment inspection.
- Workspace MCP configurations and per-agent MCP attachments.
- Searchable built-in guidance, MCP documentation resources, and the
  `x1agent.setup_agent` guided prompt.

Tool discovery is scope-aware. A client only sees tools covered by its granted
OAuth scopes. Mutations require the same workspace and agent permissions as the
web interface. Every mutation also requires an `idempotency_key`; reuse the same
key only when retrying the exact same request. Update operations require the
current revision returned by the corresponding read tool.

Long-running provider work is asynchronous. Collection creation and deletion,
Dockerfile builds, and OCI image validation return promptly with lifecycle
state. Poll the corresponding `get` tool until the resource is ready/succeeded
or failed. Failures return stable machine-readable codes without provider
credentials or internal response bodies.

## Attach one MCP to an agent

First list the workspace's MCP configurations and agents. Then call
`agents.mcp_attachments.set` with the workspace slug, agent ID, and MCP
configuration ID. The operation is idempotent: setting an existing attachment
updates its allowed tool scopes and environment mapping instead of creating a
duplicate.

Remote OAuth credentials are user-scoped, not agent-scoped. Attaching Linear to
ten orchestrators does not require ten OAuth grants. The user who triggers a
session—or the scheduled agent's configured **Run as** user—must have connected
Linear once. If that user has not connected it, the agent starts without Linear
tools rather than receiving another user's credentials.

Literal attachment environment values and OAuth tokens are never returned by
administrative MCP tools. Secret references are returned by name so an operator
can audit the binding without reading the secret value.

## Safety properties

- Resource IDs are resolved inside the named workspace; cross-workspace IDs
  return `not_found`.
- Agent reads and mutations use current visibility, ownership, and grant rules.
- Workspace MCP catalog mutations require workspace owner or administrator
  access.
- OAuth MCP attachment policy for orchestrators and scheduled agents is enforced
  exactly as it is in the web interface.
- Session, artifact, event, and cost reads use exact session visibility; access
  to an agent does not reveal another user's private runs.
- Destructive calls require an explicit matching confirmation identifier where
  accidental deletion would be costly.
- Every response carries a schema version and request identifier. Every
  mutation is idempotency-tracked and audit-recorded.
- Tool errors are structured and do not include tokens, secret values, or
  upstream OAuth response bodies.
