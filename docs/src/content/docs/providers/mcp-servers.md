---
title: MCP servers
description: How agents attach external MCP tool servers, how workspaces register them, and how secrets are injected without ever entering the agent container.
sidebar:
  order: 3
---

x1agent ships with one built-in MCP server -- `x1agent` -- exposing the seven tools every session uses to talk back to the user (`emit_status`, `emit_artifact`, `request_input`, `emit_error`, `share`, `request_permission`, `end_session`). That's the platform surface. Beyond it, agents can be attached to **external MCP servers** -- any process that speaks the Model Context Protocol -- to gain tools for third-party systems (Linear, Slack, Notion, a custom in-house API, anything).

This doc covers three concerns:

1. Agent-level attachment -- which MCPs a given agent can use.
2. Workspace-level registration -- the catalog of MCPs an admin has made available, and the secret values those MCPs need.
3. Credential injection -- how a typed secret gets from the edit screen to the MCP process without ever passing through the agent container.

The trust model is the same one used everywhere else in x1agent: **the agent container is untrusted; the sidecar is the boundary; secrets never cross that boundary.** MCP servers that need credentials run outside the agent container and talk to it over a byte pipe.

## Two levels of configuration

```mermaid
graph LR
    subgraph ws[Workspace]
        cat[MCP catalog<br/>image + manifest]
        secrets[Workspace secrets<br/>named values]
    end

    subgraph agent[Agent]
        attach[Attached MCPs<br/>references into catalog]
        env[Per-attachment env<br/>values and REFS]
    end

    cat -. "reference" .-> attach
    secrets -. "validate refs" .-> env
```

**Workspace level** is the catalog. A workspace admin registers an MCP once -- its image, its manifest (the list of env vars it expects), and any secrets those vars depend on. Every agent in the workspace can pick from this catalog.

**Agent level** is attachment. Each agent's edit screen has an "MCP servers" section that lets the author pick MCPs from the workspace catalog and fill in their env. Non-secret values are typed inline; secret values are typed as `${SECRET_NAME}` references into the workspace secret store.

An agent cannot attach an MCP the workspace hasn't registered. An agent cannot reference a secret that doesn't exist. Both are validated at save time.

## Workspace catalog

### Registering an MCP

A workspace admin goes to **Settings -> MCP servers -> Add** and provides:

- **Name** -- unique within the workspace. Used as the MCP's key in `mcpServers` and as the tool prefix (`mcp__<name>__<tool>`).
- **Shape** -- one of:
  - **Container image** -- OCI reference, e.g. `ghcr.io/org/linear-mcp:1.2.0`. The runtime spawns this image directly as a sibling container in the agent's pod. Use when the MCP author publishes a container.
  - **Command** -- executable + args, e.g. `npx -y @author/mercury-mcp`. The runtime spawns the platform's generic `mcp-runner` base image (node + python + uv preinstalled) and runs the command inside it. Matches Claude Desktop's `claude.json` shape, so you can usually paste the snippet from an MCP author's README directly.
- **Manifest** -- the set of env vars the MCP expects. Either fetched automatically from the image (if it ships an `/mcp-manifest.json` file under the root) or pasted by the admin:

```json
{
  "env": {
    "LINEAR_API_KEY":      { "kind": "secret", "label": "API key", "required": true },
    "LINEAR_WORKSPACE_ID": { "kind": "value",  "label": "Workspace ID" }
  },
  "tool_scopes": {
    "create_issue":  "linear.write",
    "search_issues": "linear.read"
  }
}
```

`kind: secret` means the field at agent-attach time only accepts `${SECRET_NAME}` references. `kind: value` means a plain string. `tool_scopes` declares which runtime permission scope each tool requires -- see [Runtime tool gating](#runtime-tool-gating) below.

### Workspace secrets

Alongside the MCP catalog, a workspace has a named secret store. Each entry has a name (uppercase letters, digits, and underscores; matches `^[A-Z_][A-Z0-9_]{0,63}$`) and a write-only value.

The same secret store feeds **two attachment zones** — this page (Zone 1, MCP-mediated, agent never sees the value) and [Agent env injection](/security/agent-env) (Zone 2, plaintext lands in the agent container's env at the operator's explicit grant). When in doubt, prefer Zone 1 — only use Zone 2 when the agent itself needs to be the authenticated principal.

Behind the edit screen:

- Plaintext lands once at the API. It is encrypted and persisted; the API does not log the body of this route. Two storage shapes exist depending on the deployment's chart version (see *Storage* below).
- The metadata projection visible to the API and the UI is `{ name, is_set, created_at, updated_at, updated_by }`. The value is never returned.
- There is no `GET /secrets/:name` endpoint. Admins who want to see the value must rotate it and re-enter the new one.

#### Storage — v1 (current implementation)

- Plaintext is encrypted with **AES-256-GCM**: random 96-bit nonce per call (NIST SP 800-38D), 128-bit auth tag, deployment-wide master key.
- The master key is hex-encoded 32 bytes, loaded at api boot from the `WORKSPACE_SECRETS_MASTER_KEY` env var. The installer (`mise run install`) generates one on first run if absent and stores it in GSM as `x1agent-workspace-secrets-master-key`. The api never writes it back, never logs it.
- The encrypted blob (`ciphertext`, `nonce`, `auth_tag`) lives in the `workspace_secrets` table alongside the metadata.
- Rotating the master key would invalidate every existing row — there is no re-encrypt procedure built in v1, so treat the key as forever-immutable.

#### Storage — v2 (target)

The v2 design moves plaintext out of Postgres entirely:

- Plaintext lands at the API and is written to a Kubernetes `Secret` resource in the workspace's namespace.
- The Postgres row keeps only the metadata + a `k8s_secret_ref` pointer. The `ciphertext` / `nonce` / `auth_tag` columns are dropped.
- RBAC on the K8s `Secret` is scoped to exactly two service accounts: the API (to manage) and the session pod's SA (to mount).
- Pod specs reference values via `valueFrom.secretKeyRef` — plaintext never transits the pod spec.

The migration path is additive: add `k8s_secret_ref` column, write to both stores during a flight window, then drop the encrypted-blob columns once every row has a K8s secret. The HTTP API contract (the metadata-only response shape, the write-only `PUT`, the lack of any value-returning `GET`) is identical between v1 and v2.

#### Cross-cutting

**The secret store is one store, used by every system that references a secret.** MCP env, [sibling](/architecture/siblings) env, [runtime service](/architecture/runtime-services) env, and the agent container's own env all resolve `${NAME}` references against the same workspace secret store. The same `^\$\{[A-Z_][A-Z0-9_]*\}$` syntax, the same bare-reference-only rule, and the same materialization path apply in every case. One secret store, one write-only UI, one audit trail, many consumers.

## Attaching MCPs to an agent

On the agent edit screen, under **MCP servers**, the author sees the workspace catalog and clicks **Attach**. For each attachment, the form renders fields from the MCP's manifest:

- `kind: value` fields render as a normal text input. The value is stored in the agent config in Postgres.
- `kind: secret` fields render as a text input that accepts **only** `${SECRET_NAME}` references. The form validates that `SECRET_NAME` exists in the workspace secret store and is marked `is_set = true`. If the referenced secret is cleared later, the agent's next session fails fast with a readable error instead of booting a broken pod.

### The `${NAME}` syntax, precisely

The full value of a secret field must match:

```
^\$\{[A-Z_][A-Z0-9_]*\}$
```

**Bare references only.** `${LINEAR_API_KEY}` is valid. `prefix-${LINEAR_API_KEY}-suffix` is not, and the form rejects it at save time. This rule exists because partial interpolation would force the API to materialize the concatenated plaintext into the pod spec, which lands in etcd outside the `Secret` resource. Bare references let Kubernetes do the substitution via `valueFrom.secretKeyRef` at container start -- plaintext never transits the pod spec.

If an MCP genuinely needs a composed string (e.g. `postgres://user:${PG_PASSWORD}@host/db`), split the composition into the MCP itself: the manifest declares `PG_PASSWORD` as the secret and `PG_HOST`, `PG_USER`, `PG_DATABASE` as values, and the MCP assembles the URL internally.

### Save flow

```mermaid
sequenceDiagram
    participant UI as Browser
    participant API
    participant PG as Postgres

    UI->>API: PUT /agents/:id/mcp-attachments
    Note right of UI: { name: "linear",<br/>env: { LINEAR_API_KEY: "${LINEAR_API_KEY}",<br/>LINEAR_WORKSPACE_ID: "x1-org" } }
    API->>PG: SELECT is_set FROM workspace_secrets WHERE name = 'LINEAR_API_KEY'
    PG-->>API: is_set = true
    API->>PG: INSERT agent_mcp_attachments ...
    API-->>UI: 200 OK
```

On every save, the API validates:

- The MCP name exists in the workspace catalog.
- Every `kind: secret` field has a `${NAME}` reference (or is empty and the field is optional).
- Every referenced `NAME` exists in `workspace_secrets` and `is_set = true`.
- Every `kind: value` field matches its manifest constraints (required, regex, enum).

Validation errors come back with field-level messages. The form does not silently drop invalid data.

## Runtime: how the MCP actually runs

Attaching an MCP changes the pod spec generated for each session.

```mermaid
graph TB
    subgraph pod["Session pod"]
        agent["agent container<br/>(untrusted)"]
        sidecar["sidecar container<br/>(trust boundary)"]
        mcp["mcp-name container<br/>(real MCP binary,<br/>secret env mounted)"]
        sock[("/run/x1/mcp/name.sock<br/>shared emptyDir")]
    end

    agent -- "socat shim<br/>(bytes only)" --> sock
    sock <--> mcp
    mcp -. "outbound with injected secret" .-> ext[External API]
```

At session-start time, the API reads the agent's MCP attachments and, for each one, injects:

- A new container `mcp-<name>` in the pod spec, using the image from the catalog.
- Env on that container: every `kind: value` becomes an `env.value` entry; every `${SECRET_NAME}` reference becomes an `env.valueFrom.secretKeyRef` pointing at the workspace's secret object. **Plaintext is never written to the pod spec.**
- An `emptyDir` volume mounted at `/run/x1/mcp/` on both the MCP container and the agent container.
- The MCP container's entrypoint is wrapped so stdio is bound to a Unix socket in the shared volume (via `socat UNIX-LISTEN:/run/x1/mcp/<name>.sock,fork EXEC:<mcp-binary>,stderr`).

In the agent container, `mcpServers` gains one entry per attachment:

```ts
{
  linear: {
    command: "socat",
    args: ["-", "UNIX-CONNECT:/run/x1/mcp/linear.sock"],
    env: {},
  },
  // ... plus the built-in x1agent server
}
```

The agent SDK spawns `socat`, which pipes JSON-RPC to the real MCP. The agent container never holds `LINEAR_API_KEY` and never runs the Linear MCP binary. Tool descriptions, tool calls, and tool results flow through the pipe as JSON-RPC bytes -- the SDK calls `tools/list` and gets whatever the real MCP returns.

### Configuration is frozen at session start

Because each MCP attachment becomes part of the pod spec, **the set of MCPs available to a session is fixed for that session's lifetime.** Changing an agent's attachments or a workspace secret takes effect on the next session. There is no hot-add.

This matches the lifecycle of every other K8s-backed piece of the platform. An agent editor who changes MCP config sees the new config the next time they click **Run now**.

## Secrets UI

The workspace secrets page renders a table of secret names with a three-state UX per row.

| State | What the admin sees | Actions |
|-------|---------------------|---------|
| Not set | Empty input field | Save (enabled when a value is typed) |
| Set | `Linear API key -- set 2026-04-12 by chris@...` (no value shown) | Replace, Clear |
| Replacing | Fresh input labeled "New value -- saved on submit" | Save, Cancel |

No masking characters. No "show value" toggle. No round-trip of the value through the browser -- `GET /workspaces/:slug/secrets` returns only `{ name, is_set, updated_at, updated_by }`.

Under the hood the write path is a dedicated API route with body logging disabled at the middleware:

```
PUT    /api/workspaces/:slug/secrets/:name   body: { value: "<plaintext>" }
DELETE /api/workspaces/:slug/secrets/:name
```

The `PUT` route is the only place in the codebase that reads a plaintext secret off the wire. Keeping it narrow keeps the audit story simple.

## Runtime tool gating

MCP tools can declare a required scope in their manifest (`tool_scopes`). At session start, the sidecar reads the manifest and combines it with the workspace's [permission grants](/security/permission-grants) to build a gate map. When the agent calls `mcp__linear__create_issue`, the sidecar checks: does this agent or user hold a `tool_scope` grant for `linear.write`?

- **Yes** -- the call proceeds through the shim to the MCP.
- **No** -- the sidecar short-circuits with a `permission_required` error. The agent follows the existing runtime flow: call `request_grant(grant_type: 'tool_scope', details: { scope: 'linear.write' }, ...)`. The user sees a modal, approves, and the original call is retried.

Tool gating is **opt-in per tool** via the manifest. An MCP without `tool_scopes` runs ungated -- the built-in `x1agent` MCP works this way, since its tools are meta-tools, not external-world tools.

This preserves the "only humans grant" invariant from [permission-grants](/security/permission-grants) for MCP-driven tool calls. An MCP can describe what scope it needs; it cannot grant itself that scope. The grant is always written by a human-authenticated `POST /grants`.

## Audit

Every configuration change emits an audit event (actor, workspace, resource, timestamp). Events:

- `workspace.secret.set` / `workspace.secret.replaced` / `workspace.secret.cleared` -- never contains the value.
- `workspace.mcp.registered` / `workspace.mcp.updated` / `workspace.mcp.removed`.
- `agent.mcp.attached` / `agent.mcp.detached` / `agent.mcp.env_updated` -- includes field names, not values.
- `session.mcp.tool_called` -- per-call, includes `name`, `tool`, `duration_ms`, `granted_via` (scope grant id, if gated). Arguments and return values are not in the audit log by default (they may contain PII); they can be enabled per-workspace for debugging via an explicit toggle.

Same shape as the existing permission-grant audit table.

## What's deliberately not supported

- **Partial interpolation inside a secret field.** See above. Use value fields for composable pieces; let the MCP assemble the string.
- **Agent-owned secrets that bypass the workspace store.** Every secret goes through the workspace secret store. Agents can only reference; they cannot write.
- **Runtime-dynamic MCP attachments.** Attach/detach is a config change, not a runtime action. An agent cannot spawn its own MCP.
- **Non-admin MCP registration.** Only workspace admins can add entries to the catalog. Agent authors can attach from it, but cannot introduce new MCPs.
- **HTTP MCP transport in the first cut.** Stdio only. HTTP MCPs can be bolted on later by adding a transport variant to the catalog entry and routing the sidecar proxy accordingly -- same trust boundary, different wire.
