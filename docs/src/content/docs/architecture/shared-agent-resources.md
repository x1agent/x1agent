---
title: Shared agent resources
description: Long-running workspace-scoped databases and caches that agents connect to, with per-branch isolation and a strict boundary from the control-plane database.
sidebar:
  order: 9
---

Agents write code that talks to databases. Agents iterate on that code across many sessions. If every session starts with an empty Postgres, agents re-run migrations on every turn and real work is impossible.

**Shared agent resources** are long-running workspace-scoped services -- Postgres, Redis, and (over time) any other stateful engine an admin opts into -- that agents in the workspace connect to. They survive session teardown. They are isolated per branch so two agents working on two branches never step on each other. They are installed from a catalog surfaced in the workspace settings UI.

They are not the control-plane database. That distinction is the first section of this document, by design.

Companion docs:

- [Sessions](/architecture/sessions) -- how session pods are spawned and how env is injected.
- [Permission grants](/security/permission-grants) -- the approval model this flow reuses at install time.
- [MCP servers](/providers/mcp-servers#workspace-secrets) -- the workspace secret store (same `${NAME}` syntax as env refs here).
- [Siblings](/architecture/siblings) -- the in-pod ephemeral-service pattern, distinct from shared agent resources. See [Siblings vs. shared agent resources](#siblings-vs-shared-agent-resources).

## Boundary with the control-plane database

The cluster has two classes of Postgres. Never conflate them.

|  | Control-plane database | Shared agent resources |
|---|---|---|
| **What it holds** | `workspaces`, `agents`, `sessions`, `permission_grants`, `audit_events`, `workspace_secrets` metadata | Tables agents create for the apps they are building |
| **Who operates it** | Whoever operates x1agent | Workspace admin, opted in per workspace |
| **Namespace** | `x1agent` | `ws-<workspace-id>` |
| **Who sees it in UI** | Nobody -- operator concern | Workspace admins, under **Settings -> Shared agent resources** |
| **Who connects to it** | API, job-watcher, audit subscriber | Agent session pods only |
| **Lifecycle** | Lives with the cluster | Installed when an admin turns it on; reaped when the workspace is deleted |

### The isolation rules

Two hard rules. Not principles. Not best practices. Rules.

**Rule 1: Agent pods cannot reach the control-plane database.**

Enforced by three layers, each of which would independently be sufficient:

- *NetworkPolicy*. Session pods in `ws-<id>` are denied egress to `postgres.x1agent.svc.cluster.local:5432`.
- *Architecture*. The agent container holds no API token and has no network path to `/api/internal/*`. The sidecar holds `X-Internal-Token` and calls only scoped internal routes; no internal route exposes control-plane SQL or row access.
- *Credential separation*. The control-plane Postgres role does not exist in any workspace Postgres and vice versa. Different instances, different role catalogs.

**Rule 2: Inside its branch database, an agent is owner and the platform does not police what it does.**

The scoped role granted to an agent has:

- `LOGIN`
- `OWNER` of exactly `<repo>_<branch>`, and nothing else
- No `CREATEDB`, no `CREATEROLE`, no `SUPERUSER`

Inside that one database the agent can create tables, drop them, install schema-level extensions, load fixtures, and corrupt its own state at will. The platform does not inspect queries, freeze migrations, or otherwise second-guess agent behavior. If an agent nukes its schema the recovery path is `POST /api/workspaces/:slug/shared-agent-resources/postgres/branches/:name/reset`, which drops and re-creates from the main template. Branch data is scratch data. Ephemeral in principle, durable in practice; the agent owns it.

## The catalog

The workspace admin opens **Settings -> Shared agent resources**. The first screen lists every resource kind the platform knows how to install, in a catalog format:

| Kind | Versions | Provider |
|------|----------|----------|
| Postgres | 16, 15 | `statefulset` |
| Redis | 7 | `statefulset` |
| *(future)* MinIO | ... | ... |
| *(future)* Kafka | ... | ... |

Each entry in the catalog is a **kind** with one or more **versions** and a selected **provider** (the adapter that implements the actual provisioning). v1 ships Postgres and Redis, each with a single `statefulset` provider that works out of the box on OrbStack and any CNI-backed cluster.

The catalog is code-embedded for v1 (`packages/domains/agent-resources/src/catalog.ts`). A future release may allow operators to register additional kinds via a ConfigMap; that change is additive.

### Installing a resource

```mermaid
sequenceDiagram
    participant UI as Browser
    participant API
    participant K8s as K8s API
    participant CP as Control plane Postgres

    UI->>API: POST /api/workspaces/:slug/shared-agent-resources<br/>{ kind: "postgres", version: "16", config: {...} }
    API->>API: validate kind + version + config
    API->>CP: INSERT workspace_shared_resources<br/>(workspace_id, kind, version, config, status=provisioning)
    API->>K8s: apply StatefulSet + Service + Secret (admin creds)
    K8s-->>API: resources created
    API->>K8s: wait for StatefulSet ready
    K8s-->>API: ready
    API->>CP: UPDATE ... SET status='running'
    API-->>UI: 201 Created
```

At install time the API generates an admin credential (a random 32-byte password) and writes it into a Kubernetes Secret in `ws-<id>`. That Secret is mounted into the API's minter path, not into any session pod. The admin credential is used only for provisioning per-branch roles and databases, never exposed to agents.

Reinstall of the same kind is rejected in v1; one instance per kind per workspace. If the admin wants a different version they uninstall first, which drops the StatefulSet and every branch database with it.

### Uninstalling a resource

Explicit and destructive. The UI shows a confirmation with the list of branch databases that will be dropped. On confirm, the API deletes the StatefulSet, deletes the PVC, deletes every `workspace_*_branch_*` row for that resource, and deletes the admin credential Secret. No soft-delete, no snapshot, no archive. Admins who want to preserve data should dump before uninstall.

## Per-branch isolation

Every session knows its `(repo, branch)` from agent config. At pod-spec generation, for each shared resource attached to the agent, the job-watcher provisions a branch-scoped slice.

### Postgres: one database + one role per `(repo, branch)`

The minter runs three statements, idempotently:

```sql
-- if the branch database does not exist, clone from the main template
CREATE DATABASE <repo>_<branch_id> WITH TEMPLATE <repo>_main OWNER postgres;

-- if the role does not exist, create it; otherwise rotate its password
CREATE ROLE <repo>_<branch_id> LOGIN PASSWORD '<rotated>';
-- or: ALTER ROLE <repo>_<branch_id> WITH PASSWORD '<rotated>';

-- grant ownership of the branch database to the role, idempotent
ALTER DATABASE <repo>_<branch_id> OWNER TO <repo>_<branch_id>;
REVOKE ALL ON DATABASE <repo>_<branch_id> FROM PUBLIC;
```

`<branch_id>` is a sanitized-plus-hashed form of the branch name: `feat/new-api` becomes `feat_new_api_a1b2c3d4`, where the suffix is the first eight hex chars of a hash of the original branch name. This avoids postgres's 63-byte identifier limit and guarantees uniqueness between `feat/x-y` and `feat-x_y`.

`<repo>_main` is the template database seeded at resource install time. It is owned by `postgres` and never written to directly by any branch role. Agents that need to change the baseline schema do so by opening a PR on a migration file; the PR merges to main; the next agent starting a session against main sees the change.

### Redis: one ACL user + one key prefix per `(repo, branch)`

```
ACL SETUSER <repo>_<branch_id>
  on >password
  ~<repo>_<branch_id>:*        # key pattern
  &<repo>_<branch_id>:*        # pub/sub channel pattern
  +@all                        # all commands by default
  -@dangerous                  # strip FLUSHDB / FLUSHALL / SHUTDOWN / DEBUG / CONFIG
```

The `~` and `&` clauses are enforced at the server. An agent that tries `KEYS *` or `FLUSHDB` receives a NOPERM error. The shared instance cannot be accidentally or maliciously nuked by a branch-scoped agent.

### Credential delivery

Credentials reach agent containers through the `valueFrom.secretKeyRef` path, not through sidecar injection. This keeps the rule "secrets reach containers only via Kubernetes-native Secret references" intact.

```mermaid
sequenceDiagram
    participant JW as Job watcher
    participant M as Credential minter (API)
    participant WS as Workspace Postgres
    participant K8s as K8s API
    participant Pod as Session pod

    JW->>M: mint session creds (session_id, resources)
    M->>WS: CREATE DATABASE / ALTER ROLE (idempotent)
    M->>WS: new per-session password
    M-->>JW: DSN strings
    JW->>K8s: create Secret session-creds-<id><br/>(labeled session_id=<id>)
    JW->>K8s: create Pod referencing that Secret<br/>via valueFrom.secretKeyRef
    K8s->>Pod: DATABASE_URL, REDIS_URL in env
    Note over Pod: agent starts with env populated
```

On session completion the [session reaper](/architecture/sessions#reaper) deletes the per-session Secret. The branch role and database remain; only the password has rotated.

### What the agent sees

Inside the session pod, the agent sees plain environment variables:

```
DATABASE_URL=postgresql://feat_new_api_a1b2c3d4:PASS@postgres.ws-abc.svc.cluster.local:5432/feat_new_api_a1b2c3d4
REDIS_URL=redis://feat_new_api_a1b2c3d4:PASS@redis.ws-abc.svc.cluster.local:6379/0
```

Plus a two-paragraph block appended to the agent's system prompt:

> You have a Postgres database at `$DATABASE_URL`. It is scoped to your current branch. Migrations, schemas, fixtures, and any other state you create persist across sessions on this branch. On branch deletion the database is dropped; no other action on your part is needed.
>
> You have a Redis cache at `$REDIS_URL`. All keys are prefixed automatically by your branch scope; you read and write unprefixed keys and the server handles isolation.

## Data model

Three tables in the control-plane database track state; none of them hold secrets.

```sql
-- See deploy/migrations/012_shared_agent_resources.sql for the binding schema.

CREATE TABLE workspace_shared_resources (
  id               UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  version          TEXT NOT NULL,
  provider         TEXT NOT NULL,
  config           JSONB NOT NULL DEFAULT '{}'::jsonb,
  admin_secret_ref TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'provisioning',  -- provisioning | running | failed
  status_reason    TEXT,
  installed_by     UUID REFERENCES users(id) ON DELETE SET NULL,  -- nullable
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind)
);

-- agent_repos has a composite PK (agent_id, repo_full_name), so per-branch
-- rows scope by repo_full_name (not a synthetic repo id) — this lets the
-- branch DB follow a repo across agents.
CREATE TABLE workspace_postgres_branches (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  resource_id     UUID NOT NULL REFERENCES workspace_shared_resources(id) ON DELETE CASCADE,
  repo_full_name  TEXT NOT NULL,
  branch_name     TEXT NOT NULL,
  branch_id       TEXT NOT NULL,
  last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reaped_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_id, repo_full_name, branch_name)
);
-- Mirror shape for workspace_redis_branches.
```

Per-engine tables on purpose; a single generic `workspace_branch_resources` table would lose information every engine wants at query time.

## Branch reaper

A branch database or ACL user persists until the branch no longer exists in its repo. A daily reaper sweep:

1. For each `workspace_postgres_branches` and `workspace_redis_branches` row where `reaped_at IS NULL`,
2. List branches in the repo via the workspace's GitHub credential proxy.
3. If the branch is not in the list, reap:
   - Postgres: `DROP DATABASE <branch_id>; DROP ROLE <branch_id>;`
   - Redis: `ACL DELUSER <branch_id>;` then async `SCAN` + `UNLINK` on the prefix.
4. Set `reaped_at`.

Webhooks are an optional faster path: the workspace admin can configure GitHub to POST to `/api/workspaces/:slug/webhooks/github`, and the API reacts to `delete` events on the same day. Webhooks are a Phase-2 convenience; the daily reaper is the authoritative cleanup.

Manual reset is also available: `POST /api/workspaces/:slug/shared-agent-resources/postgres/branches/:name/reset` drops the branch database and re-creates it from the main template. Useful when an agent wrecks its own state.

## Provider shape

Each engine lives in its own bounded context under `packages/domains/`:

```
packages/domains/agent-resources-postgres/
  src/
    domain/       Identifiers, DSN value object, branch-id hashing
    ports/
      AdminProvisioner   (installer-side: install/uninstall, set up main DB)
      BranchMinter       (session-side: ensure branch DB + role, rotate password)
    adapters/
      statefulset/  concrete adapter for the in-cluster StatefulSet engine
    fakes/        in-memory fake for unit tests

packages/domains/agent-resources-redis/
  (same shape)
```

The port shape is engine-specific because the primitives differ: Postgres provisions databases and roles; Redis provisions ACL users. Attempting to unify them at the port level loses too much information.

v1 ships one adapter per engine and therefore **no contract-test suite yet**. CLAUDE.md requires a contract suite once a port has multiple adapters; with one adapter, the adapter's own integration tests are the contract. A second adapter (CloudNativePG for Postgres, Upstash for Redis, Neon for external-managed, etc.) triggers the move to a contract suite in the port package. Future docs will describe that migration.

Helm values select the adapter:

```yaml
sharedAgentResources:
  postgres:
    adapter: statefulset        # the only option in v1
  redis:
    adapter: statefulset
```

A fresh OrbStack install with default values has zero resources provisioned; nothing runs in `ws-<id>` until an admin clicks Install. Resource usage scales with actual demand.

## OrbStack dev

Everything in this document works under `mise run dev` on OrbStack with no operator install. The `statefulset` adapters use the default storage class (OrbStack provisions hostPath PVs on demand). First install of Postgres 16 pulls `postgres:16` from Docker Hub -- local pull-through cache will cut this to seconds after first use once the in-cluster registry is deployed. Redis 7 is the same.

Integration tests against the real StatefulSet run in CI against an OrbStack cluster spun up by the devcontainer; no mocking at the engine level.

## Siblings vs. shared agent resources

[Siblings](/architecture/siblings) are ephemeral service containers that live inside the session pod and die with it. Shared agent resources are long-running services that live in the workspace namespace and survive every session.

| Concern | Use siblings | Use shared agent resources |
|---------|--------------|----------------------------|
| "Every session gets a clean Postgres, no state carry-over" | yes | no |
| "Agents iterate on the same schema across many sessions" | no | yes |
| "MailHog to capture outbound email during tests" | yes | no |
| "Fake S3 for test fixtures" | yes | no |
| "Headless chromium for scraping" | yes | no |
| "Shared cache that accumulates across runs" | no | yes |

When both patterns could work, prefer shared agent resources for stateful engines and siblings for ephemeral test fixtures. A workspace that runs serious application development installs Postgres and Redis as shared resources and uses siblings for MailHog, fake S3, and a headless browser.

## Audit

Every install, uninstall, branch provision, branch reap, and branch reset emits an audit event. Event shape mirrors [permission grants](/security/permission-grants#audit):

- `workspace.shared_resource.installed` -- actor, workspace, kind, version.
- `workspace.shared_resource.uninstalled` -- count of branch databases destroyed.
- `workspace.shared_resource.branch.provisioned` -- resource_id, repo_id, branch.
- `workspace.shared_resource.branch.reset` -- manual drop-and-re-template.
- `workspace.shared_resource.branch.reaped` -- by clean branch-delete or by the daily sweep (reason field distinguishes).

No secret values appear in any event.

## Failure modes

| Failure | Behavior |
|---------|----------|
| StatefulSet never becomes ready (PVC pending, node pressure) | Resource stays in `status='provisioning'` for up to 10 minutes, then flips to `failed` with a structured reason. Admin can retry or uninstall. |
| Branch minter SQL fails at session start | Session pod is not created. Session status becomes `failed` with a structured reason event on the session detail page. |
| Agent exhausts disk in its branch database | Pod-level PVC fills up across all branches; admin sees the health alert on the resource row. Recovery: expand PVC, or uninstall + reinstall with larger storage. |
| Reaper's GitHub list call fails | Reaper logs and retries on next sweep. Branch data persists; no destructive action taken under uncertainty. |
| Webhook `delete` event received for a branch that still exists (GitHub race) | Idempotent; reaper's next scheduled sweep is authoritative. A webhook-driven drop is only executed after a confirmation list call. |

## What this is not

- **A deploy target for apps the agent builds.** Shared agent resources are engines agents connect to, not workloads the agent ships. For the parked proposal on agent-shipped workloads and branch preview deploys, see `proposals/branch-deploys.md`.
- **A secret store.** Workspace secrets live in the [MCP servers workspace secret store](/providers/mcp-servers#workspace-secrets); admin DSN credentials for shared resources are stored in Kubernetes Secrets and referenced by name, not copy.
- **A full-fidelity postgres/redis operator.** The `statefulset` adapter is deliberately minimal (single replica, no HA, no backups). Operators who need production-grade stateful engines should, when we ship it, select the `cloudnative-pg` or operator-based adapter for Postgres and the equivalent for Redis.
- **A cross-workspace sharing boundary.** Every resource is workspace-scoped. Agents in workspace A cannot reach workspace B's Postgres even if both have Postgres installed.

## Summary

- Two Postgres classes in the cluster, never conflated: the control-plane database and shared agent resources.
- Agent pods are denied network egress to the control-plane database by NetworkPolicy and hold no credentials for it.
- Admins install resources from a catalog (Postgres 16, Redis 7 in v1) from **Settings -> Shared agent resources**.
- Each installed resource is a long-running StatefulSet + Service in the workspace namespace.
- Sessions on a given `(repo, branch)` receive a scoped credential to a per-branch database (Postgres) or ACL user (Redis). State persists across sessions on the same branch and is reaped when the branch is deleted upstream.
- Agents receive credentials as `DATABASE_URL` / `REDIS_URL` env vars via `valueFrom.secretKeyRef`; the agent system prompt is augmented with a two-paragraph usage block.
- One bounded context per engine (`agent-resources-postgres`, `agent-resources-redis`); one adapter per engine in v1; contract suite added when a second adapter lands.
- Deploying apps agents build back into the cluster is out of scope for this architecture; see the parked proposal.
