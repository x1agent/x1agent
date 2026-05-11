---
title: Siblings
description: How an image declares the service containers that run alongside it in the session pod, how agents override those defaults, and the compose-shaped authoring format.
sidebar:
  order: 7
---

> **Status — proposed, not implemented as of 2026-05-10.** No `siblings_yaml`, `siblings_spec`, or `agent_image_versions` exists in the schema. The compose translator, the allowlist enforcer, and the pod-spec assembly are not wired. This page is the binding *design* the implementation should target; track work in [TICKET-LINK].

Siblings are the service containers that run alongside the agent container in a session pod — headless chromium for scraping, MailHog for capturing outbound email during tests, a fake S3 for test fixtures, a disposable Postgres an agent wants to wipe on every session. They are declared in the image catalog and optionally overridden at the agent level. This doc specifies the authoring format, the merge rules, the validation boundaries, and the field allowlist.

For **stateful engines that should persist across sessions** (the Postgres a coding agent iterates migrations against, the Redis that accumulates cache across turns), use [Shared agent resources](/architecture/shared-agent-resources) instead. Siblings are ephemeral; shared agent resources survive session teardown and are isolated per branch. Siblings are the right call for fixtures and mocks; shared agent resources are the right call for the database the agent's application actually uses.

Companion docs:

- [Shared agent resources](/architecture/shared-agent-resources) — long-running workspace-scoped engines with per-branch isolation. Prefer this for real databases and caches.
- [Runtime images](/architecture/runtime-images) — the pod shape and what the agent container is.
- [Runtime services](/architecture/runtime-services) — the mid-session variant, for services the agent decides it needs after the pod is already running.
- [MCP servers](/providers/mcp-servers) — the workspace secret store used for secret interpolation.

## Two levels

**Image-level siblings** ship with the image. The author of `python-django` includes `siblings.yaml` declaring Postgres because "Django needs Postgres" is a safe default. Every agent using that image gets Postgres in its pod automatically.

**Agent-level siblings** are declared on an agent. They add new siblings the image didn't ship with (Redis, MailHog, a MinIO for S3-compat testing), or they override an image-level sibling by name (bump Postgres from 15 to 16, change the database name, raise the memory limit).

Merge rule:

- Same name → agent-level replaces image-level entirely.
- Different name → agent-level is appended to image-level.

Validation and translation happen at save time on either side. A broken siblings spec cannot be saved; the form surfaces field-level errors.

## Authoring format: a compose subset

Authors write siblings in a Docker Compose-shaped YAML. The format is deliberately familiar — most developers read compose fluently, and most READMEs in the wild ship a compose snippet that can be pasted in with minor adjustments.

The canonical storage format is a translated Kubernetes PodSpec fragment. Authors do not need to think about PodSpec; the translation is mechanical and bounded. See [Canonical storage](#canonical-storage) below.

### Supported fields

| Compose field | Translates to | Notes |
|---------------|---------------|-------|
| `image` | `container.image` | Required. Must resolve to an image the in-cluster registry or a configured pull-through source can provide. |
| `environment` | `container.env[]` | String map or list. `${NAME}` triggers a workspace secret lookup — see below. |
| `ports` | Documentation only | Pod siblings share `localhost`; no port publishing is required. Declared ports are preserved as metadata to help humans remember the contract. |
| `volumes` | `container.volumeMounts[]` + `spec.volumes[]` | Only `emptyDir` is permitted in v1 (`type: tmpfs` or named-volume syntax). Named bind mounts, hostPath, and external volumes are rejected. |
| `command` | `container.command` | String or list. |
| `entrypoint` | `container.args` | Maps to `args`, not `command`, because compose's `entrypoint` semantics match that. |
| `user` | `container.securityContext.runAsUser` | Integer only. Runtime enforcement refuses any uid < 1000 in v1. |
| `depends_on` | `startupProbe` on dependents | Any container that names another in `depends_on` gets a `startupProbe` that waits for the dependency to pass its readiness check. |
| `healthcheck` | `container.readinessProbe` + `livenessProbe` | Inferred from `test`/`interval`/`timeout`/`retries`. |
| `resources` (extension) | `container.resources` | Standard K8s shape; not in compose spec but supported as an x1 extension because pods need it. |

### Explicitly rejected fields

Rejected at save time with a clear error:

| Compose field | Why rejected |
|---------------|--------------|
| `build:` | Ad-hoc image builds belong in the image catalog, not in siblings. |
| `privileged: true` | No path to a privileged container in an x1 pod. |
| `cap_add` / `cap_drop` | Platform sets capabilities; admins cannot add. |
| `network_mode: host` | Breaks pod-level isolation. |
| `pid: host` | Same. |
| `volumes_from` | Deprecated in compose, no K8s analog. |
| `devices:` | Device access requires privileged; not permitted. |
| `ulimits:` | Enforced at pod level, not per-container override. |
| `extra_hosts:` | Use K8s DNS or `hostAliases` at pod level if genuinely needed; off in v1. |

### Example: MailHog for outbound email capture

```yaml
# siblings.yaml (ships with the image)
services:
  mailhog:
    image: mailhog/mailhog:v1.0.1
    ports:
      - 1025   # SMTP
      - 8025   # web UI
    resources:
      requests:
        memory: 64Mi
        cpu: 50m
```

When an agent using this image starts a session, the pod spec has three containers (agent + sidecar + mailhog). The agent's app points `SMTP_HOST=localhost:1025`. Outbound mail is captured; no test email escapes the pod; MailHog disappears with the session.

This is the right shape for siblings: ephemeral, stateless (or trivially restored), scoped to one session's needs. For a **real Postgres that agents need to run migrations against and keep their schema between sessions**, do not use a sibling -- install Postgres as a [shared agent resource](/architecture/shared-agent-resources) instead. The sibling pattern is for fixtures and mocks, not for the database your application actually uses.

### Example: agent overrides and extensions

```yaml
# agent-siblings.yaml (on the agent config, on top of the image's siblings)
services:
  postgres:
    image: postgres:16.2  # pin a patch version this agent cares about
    environment:
      POSTGRES_DB: analytics  # override the default
  redis:
    image: redis:7
    resources:
      limits:
        memory: 512Mi
```

After merge: `postgres` keeps everything from the image-level declaration **except** what this agent changed (image tag and DB name); `redis` is added.

## Canonical storage

Compose is the authoring format; the translated K8s PodSpec fragment is what the platform stores and schedules. Both are saved side by side on the image/agent record so the original is preserved and the canonical is unambiguous.

```
agent_images table:
  id              UUID
  workspace_id    UUID
  name            TEXT
  dockerfile      TEXT                       -- admin input
  siblings_yaml   TEXT                       -- admin input (compose subset)
  siblings_spec   JSONB                      -- canonical PodSpec fragment
  current_version_id UUID                     -- FK to agent_image_versions
  ...

agent_image_versions table:
  id              UUID
  image_id        UUID
  dockerfile_hash TEXT                       -- content hash, triggers rebuild when changed
  siblings_hash   TEXT                       -- content hash, triggers re-translation
  siblings_spec   JSONB                      -- canonical for this version
  status          TEXT                       -- pending | building | succeeded | failed
  built_ref       TEXT                       -- registry reference of the built image
  log_ref         TEXT                       -- pointer to build logs
  created_at      TIMESTAMPTZ
  ...

agents table (new column):
  image_id          UUID NOT NULL             -- FK to agent_images
  siblings_yaml     TEXT                     -- optional override, compose subset
  siblings_spec     JSONB                    -- canonical override
```

A save of the compose YAML triggers: parse → validate against the allowlist → translate to `siblings_spec` → persist. At pod-spec generation time, the platform reads `siblings_spec` directly; the compose YAML is only re-read when the admin edits.

## Secrets

Secret values in sibling env are referenced using the same `${NAME}` interpolation as [MCP server config](/providers/mcp-servers#the-name-syntax-precisely). The rule is identical: the value field matches `^\$\{[A-Z_][A-Z0-9_]*\}$` and is translated to `valueFrom.secretKeyRef` pointing at the workspace's secret store. Partial interpolation is rejected — composed strings are assembled inside the sibling process or at the image level, not in the pod spec.

```yaml
services:
  backend:
    image: ghcr.io/company/worker:1
    environment:
      DATABASE_URL: ${PROD_DB_URL}        # resolves to a workspace secret
      LOG_LEVEL: info                     # plain value
```

A save-time validator confirms every referenced secret exists and is marked `is_set = true` in the workspace store. The agent's next session fails fast if a reference later goes stale, rather than booting a broken pod.

**External services (Neon, Supabase, OpenAI, etc.).** These aren't siblings at all. The admin adds `NEON_DATABASE_URL` to the workspace secret store and references it in the agent's env (not a sibling's env). The agent connects over cluster egress; no sibling container is involved.

## Persistence

v1 supports **emptyDir only** for sibling volumes. That means every session's Postgres is fresh; migrations and fixtures must be idempotent and re-runnable at the start of each session. This is a deliberate choice:

- Ephemeral state matches agent lifecycle. Sessions are short-lived; carry-over bugs caused by accreted state in long-lived dev databases are a common source of flakiness.
- emptyDir requires no provisioning beyond the pod itself. Sessions start in seconds, not minutes.
- No risk of one session mutating state that another session depends on.

Persistence across sessions is a planned follow-up with three anticipated shapes:

1. **Per-agent PVC.** The agent's pod mounts a workspace-scoped PersistentVolumeClaim into its sibling's data directory. Data survives session teardown. Appropriate when an agent builds cumulative knowledge.
2. **Workspace-shared external DB.** A separate Deployment + Service, managed outside the session pod, reachable via in-cluster DNS. Appropriate when many agents read/write the same data.
3. **External managed DB.** The agent connects to Neon/Supabase/RDS using a workspace secret. Nothing runs in-cluster. Appropriate when the database is already operated elsewhere.

None of these are shipping in v1. When they land, they will be opt-in at the image or agent level.

## Field allowlist (canonical)

The translator's accept-list for container fields on a sibling:

```
image, env, command, args, resources, ports (documentation),
volumeMounts, readinessProbe, livenessProbe, startupProbe,
securityContext.runAsUser (>= 1000 only)
```

For pod-level contributions from sibling volumes:

```
volumes[*].name
volumes[*].emptyDir (with optional medium=Memory, sizeLimit)
```

Everything else on the container or pod level is owned by the platform. In practice:

- Platform owns `serviceAccountName`, `securityContext` (pod-level), `nodeSelector`, `tolerations`, `affinity`, `hostNetwork`, `hostPID`, `hostIPC`, `dnsPolicy`, `restartPolicy`.
- Platform owns the agent and sidecar containers entirely.
- Siblings contribute only to the container list and the volume list, within the allowlist.

## Validation timeline

Validation runs at three points:

1. **Save-time (UI form submit, or API PUT on the image/agent endpoint).** Parse the compose subset, check the allowlist, translate to PodSpec fragment, persist both. A bad save returns structured errors with field paths.
2. **Build-time (image version creation).** If the image's siblings reference a secret that no longer exists in the workspace store, the build still succeeds (siblings are independent of image build) but the UI surfaces a warning on the image detail page.
3. **Pod-spec generation (session start).** Final merge of image-level + agent-level + secret hydration. Failure here fails the session with a structured error event visible on the session detail page. Common causes: stale secret reference, workspace budget exceeded (too many containers), workspace namespace quota reached.

## Resource budgets

Every session pod has a workspace-enforced budget on the total number of containers, total memory request, total CPU request. Siblings count against the budget. An agent can be rejected at session start if image-level + agent-level siblings exceed the workspace's limits. The UI surfaces remaining headroom on the agent edit screen so the admin can plan.

## What siblings is not

- **Not docker-compose.** The compose-shaped input is a convenience for authors. Runtime behavior is governed by the K8s PodSpec, not by compose semantics.
- **Not a runtime orchestrator.** Siblings are static for the session. To add a service after the pod is running, use [Runtime services](/architecture/runtime-services).
- **Not a substitute for a real database service.** Persistence and cross-session state belong on a PVC, a shared in-cluster DB, or an external managed DB.
- **Not a sandboxing mechanism.** Siblings share the pod's network namespace with the agent by design; an agent can always reach its siblings. Use cluster-level NetworkPolicy for cross-pod isolation, not siblings.

## Summary

- Siblings declared per-image (defaults) and per-agent (overrides), merged by name.
- Authoring format: a compose subset with a bounded field allowlist.
- Canonical storage: translated K8s PodSpec fragment (`siblings_spec` JSONB).
- Secrets flow through the workspace secret store via bare `${NAME}` refs; `valueFrom.secretKeyRef` at materialization.
- emptyDir only in v1; persistence patterns documented for the follow-up.
- Platform owns pod-level fields and the agent + sidecar containers; siblings contribute only within the allowlist.
