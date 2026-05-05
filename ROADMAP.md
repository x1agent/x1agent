# ROADMAP — doc/code discrepancy checklist

The docs in `docs/src/content/docs/` are declared **binding on the code** by
`CLAUDE.md` ("The architecture described in `docs/architecture/` and
`docs/providers/` is binding on the code"). This file is a checklist of every
claim in the docs that does not match what is actually on disk today.

Each item: the doc that makes the claim, the code state that contradicts it,
and the action to resolve (either build the code, or correct the doc).

Tick each item once the doc and the code agree.

---

## Repository layout

- [ ] **`packages/infrastructure/` does not exist.**
  - Claimed by: `docs/architecture/domain-layout.md` (package tree), `CLAUDE.md`
    repository-structure section ("infrastructure/ Shared infrastructure
    adapters (postgres, nats, kubernetes)").
  - Actual: `packages/` has `agent, api, app, domains, kernel, providers,
    shared, sidecar`. No `infrastructure/` tree.
  - Action: either create `packages/infrastructure/` and move shared pg/nats/k8s
    clients into it, or remove `infrastructure/` from the docs and describe the
    `sidecar`/`providers` packages that actually exist.

- [ ] **`packages/agent/`, `packages/sidecar/`, `packages/providers/` are absent
      from the doc tree.**
  - Claimed by: `docs/architecture/domain-layout.md` (tree does not mention
    them).
  - Actual: all three exist and are load-bearing.
  - Action: add them to the domain-layout tree with one-line descriptions.

- [ ] **Domains missing from the doc tree.** The doc tree lists `auth,
      workspaces, invitations, agents, sessions`. On disk:
      `agent-resources, agent-resources-postgres, agent-resources-redis,
      agents, auth, collections, github, graph, invitations, messaging,
      permissions, sessions, vector, workspaces`.
  - Action: extend `domain-layout.md` with the full list, grouped by
    purpose (control-plane domains, agent-resource domains, provider
    contract domains).

- [ ] **`packages/domains/agent-resources-redis/src/adapters/postgres/`** — the
      redis domain has its adapter folder named `postgres` (copy-paste from the
      sibling package).
  - Action: rename to `redis` to match `shared-agent-resources.md` and the
    sibling `agent-resources-postgres` package shape.

## Helm chart / configuration

- [ ] **No Helm chart.** `deploy/helm/x1agent/` contains only a `README.md`.
  - Claimed by: `docs/providers/overview.md` ("Provider selection is driven by
    Helm values"), `docs/architecture/shared-agent-resources.md` (full
    `sharedAgentResources:` Helm snippet), `CLAUDE.md` ("local dev runs in
    OrbStack K8s via devspace"), and every other doc that references Helm
    values.
  - Action: ship the actual chart under `deploy/helm/x1agent/` (templates,
    values.yaml, values.schema.json), or rework the docs to describe the
    plain-manifest path under `deploy/k8s/dev/`.

- [ ] **`docs/configuration/helm-values.md` is a "Coming soon." stub.**
  - Action: replace with real reference once the chart ships, or remove the
    page and delete the `configuration/` section from the sidebar until it
    has content.

## Providers

- [ ] **Five of the nine documented provider domains have no code.** The
      provider-system table in `docs/providers/overview.md` lists `auth, graph,
      files, messaging, calendar, email, ai, storage, vector`. On disk:
      `packages/domains/` has `graph`, `messaging`, `vector` as provider-
      contract domains. Missing: `files, calendar, email, ai, storage`.
  - Action: either add the missing domain packages (port + contract tests
    first, then adapters), or cut the table in the docs to match what the
    platform actually contracts for today and note the rest as planned.

- [ ] **Only two provider implementations exist.** `packages/providers/` has
      `graph-surrealdb` and `messaging-slack`.
  - Claimed by: the provider-system page lists reference providers for each
    domain (Google OAuth, SurrealDB, Google Drive, Slack, Google Calendar,
    Gmail, Anthropic, GCS, Turbopuffer).
  - Action: ship at minimum an Anthropic (`ai`) reference provider and one
    other, or trim the table.

- [ ] **`deploy/helm/providers/` has manifests only for the two shipped
      providers** (`graph-surrealdb`, `messaging-slack`); `deploy/k8s/dev/`
      matches.
  - Action: when adding new providers, add the corresponding Helm / k8s
    manifest at the same time so the "providers are selected by Helm"
    claim holds.

## Runtime images

- [ ] **No `x1agent/runtime-core` base image.**
  - Claimed by: `docs/architecture/runtime-images.md` ("`x1agent/runtime-core`
    is the single base image the platform maintains. Every admin-authored
    agent image is built `FROM x1agent/runtime-core:<version>`").
  - Actual: `packages/agent/Dockerfile` is a standalone image; language
    presets in `deploy/images/{python,node,go,rust}/Dockerfile` do not `FROM`
    a shared runtime-core.
  - Action: either build and publish `runtime-core` and refactor the presets
    to `FROM` it, or rewrite `runtime-images.md` around the "standalone
    agent image + language presets" model that actually exists.

- [ ] **No Kaniko build pipeline.**
  - Claimed by: `docs/deployment/in-cluster-registry.md` ("Images are built by
    Kaniko... Kaniko runs as an unprivileged container... pushes to the
    in-cluster registry") and `runtime-images.md`.
  - Actual: no Kaniko Job templates, no `agent_image_versions` table, no
    build-status streaming over NATS (`x1.image.build.<id>.logs`).
  - Action: implement the Kaniko Job flow + `agent_image_versions` rows, or
    rewrite the registry doc to describe the current path (presets baked at
    CI, loaded into the local registry at dev time).

- [ ] **`agent_image_versions` table does not exist.** Migration 013 creates
      only `agent_images`.
  - Claimed by: `runtime-images.md` (`dockerfile_hash`, `siblings_hash`,
    `siblings_spec`, `status`, `built_ref`, `log_ref`, versioned images with
    `current_version_id`).
  - Action: add a migration (014) introducing `agent_image_versions` and the
    `current_version_id` FK, or remove the versioning narrative from the
    doc.

## Siblings

- [ ] **No `siblings_yaml` / `siblings_spec` columns anywhere.**
  - Claimed by: `docs/architecture/siblings.md` (the authoritative section on
    canonical storage).
  - Actual: `agent_images` schema has no siblings columns; `agents` has no
    siblings columns; no translator code exists.
  - Action: add the columns (on `agent_images` and `agents`), build the
    compose→PodSpec translator, and integrate it into `pod-spec.ts`. Or
    scope down the docs to reflect that siblings are not yet implemented.

- [ ] **Pod-spec generator does not compose per-image siblings with per-agent
      overrides.** `packages/api/src/k8s/pod-spec.ts` emits the agent +
      sidecar shape but does not merge siblings.
  - Action: wire the translator into `pod-spec.ts` once siblings storage
    lands.

## Runtime services

- [ ] **`request_service` is not implemented.**
  - Claimed by: `docs/architecture/runtime-services.md` (full flow, MCP tool
    signature, NATS subjects, approval model).
  - Actual: `packages/agent/src/x1-mcp.ts` registers
    `emit_status, emit_artifact, request_input, emit_error, share,
    end_session, request_grant, spawn_session, read_session`. No
    `request_service`. No `runtime_service_grants` table. No Deployment +
    Service creation in `packages/api/src/`.
  - Action: implement the full flow, or mark the runtime-services page as
    "proposal, not shipped."

## Orchestration — MCP tools for orchestrators

- [ ] **Orchestrator tool surface is incomplete.** `docs/architecture/
      orchestration.md` describes six operations and specifies a block
      appended to the orchestrator's system prompt:
      `spawn_session, read_session, message_session, await_children` (and
      prose on `report_to_parent` and `cancel_session`).
  - Actual in `packages/agent/src/x1-mcp.ts`: `spawn_session` and
    `read_session` only.
  - Missing: `message_session`, `await_children`, `cancel_session`,
    `report_to_parent`.
  - Action: implement the missing tools (they are called out by the auto-
    injected prompt in the doc, so an orchestrator would currently hit
    dead ends), or remove the missing ones from both the prompt template
    and the doc.

- [ ] **Orchestrator pod shape not verified.** Docs specify a distinct pod
      shape for orchestrators: `activeDeadlineSeconds: unset`,
      `restartPolicy: OnFailure`, `backoffLimit: 6`, per-session PVC, idle
      timer paused with active children.
  - Action: read `packages/api/src/k8s/pod-spec.ts` and
    `job-watcher.ts`; confirm the orchestrator branch exists and actually
    diverges from the worker branch on all four properties. Check or add
    tests.

- [ ] **Spawn-loop depth cap.** Docs say "Depth is capped at one: spawn_session
      rejects calls from any session whose parent_session_id is non-null."
  - Action: confirm `packages/domains/sessions/src/application/
    spawn-child-session.ts` enforces this; add a test if missing.

## MCP servers and workspace secrets

- [ ] **No workspace secrets store.** Doc `docs/providers/mcp-servers.md`
      specifies `workspace_secrets` (metadata table), `PUT /api/workspaces/:slug/
      secrets/:name`, `DELETE`, Kubernetes `Secret` resources in
      `ws-<workspace-id>` namespaces, and the `${NAME}` reference syntax.
  - Actual: no migration for `workspace_secrets`, no routes for
    `/workspaces/:slug/secrets`, no K8s Secret management code, no audit
    events.
  - Action: build the workspace secret store. It is load-bearing for
    MCPs, siblings, runtime services, and shared agent resources all at
    once.

- [ ] **MCP catalog + attachments not implemented.** Doc specifies
      `agent_mcp_attachments`, `mcp-<name>` container injection, `socat`
      byte-pipe shim, `/run/x1/mcp/` shared volume, `tool_scopes` manifest
      key and runtime tool gating.
  - Actual: only the built-in `x1agent` MCP is mounted inside `run.ts`. No
    workspace catalog, no per-agent attachments, no external-MCP
    container injection.
  - Action: implement the catalog/attachments model end-to-end, or
    rewrite `mcp-servers.md` to describe only the built-in tool surface.

## Permission grants

- [x] Grants table exists (migration 009).
- [x] Grant domain exists with `spawn` and `tool_scope` types and the
      `GrantTypeRegistry` pattern at `packages/domains/permissions/src/domain/
      details/registry.ts`.
- [x] Hono routes at `packages/domains/permissions/src/adapters/hono/routes.ts`
      expose GET/POST/DELETE on `/grants` — matches the doc's three-endpoint
      surface.
- [x] `request_grant` MCP tool exists in `x1-mcp.ts`.
- [ ] **Grants-UI runtime request modal.** Doc describes the modal on the
      session detail page that fires when the sidecar publishes
      `agent.permission_request`. Verify `packages/app/src/features/sessions/`
      surfaces it and the approve path hits `POST /grants`.
  - Action: confirm with a manual run or write a test; add if missing.

- [ ] **Dangling-grant reaper.** Doc promises "a daily sweep in the
      permissions domain flips those to `revoked_at`" when a child agent is
      deleted.
  - Action: confirm a reaper exists, or remove the claim.

## Shared agent resources

- [x] `agent-resources-postgres` and `agent-resources-redis` domains exist
      with `statefulset` adapters; migration 012 creates
      `workspace_shared_resources`, `workspace_postgres_branches`,
      `workspace_redis_branches`.
- [x] `reconcile-status.ts` and `reap-branches.ts` exist under
      `packages/api/src/shared-agent-resources/`.
- [x] Branch-reset endpoint exists (recent commit).
- [ ] **GitHub webhook reap path** — doc describes
      `POST /api/workspaces/:slug/webhooks/github` handling `delete` events.
  - Action: confirm the route exists or remove the doc claim.
- [ ] **`admin_secret_ref` Secret handling.** Doc specifies "The API generates
      an admin credential (random 32-byte password) and writes it into a
      Kubernetes Secret in `ws-<id>`."
  - Action: confirm Secret is created on install and cleaned up on
    uninstall; add an integration test.
- [ ] **NetworkPolicy denying control-plane Postgres egress from session
      pods.** Doc states this as the first enforcement of rule 1 ("Agent pods
      cannot reach the control-plane database").
  - Action: confirm `deploy/k8s/dev/networkpolicy.yaml` includes the
    egress deny; if not, add it or cut the rule from the doc.

## Sessions & scheduler

- [x] Sessions domain has `triggered_by` / `triggered_by_user_id` and a
      check constraint matching the doc.
- [x] Scheduler tick exists (`next-due.ts`, `schedule-due-sessions.ts`).
- [x] `parent_session_id` / `parent_tool_use_id` columns exist (migration
      009 extends the sessions table).
- [ ] **Unique `(agent_id, triggered_at)` index for scheduler idempotency.**
  - Action: verify `deploy/migrations/006_sessions.sql` creates this
    index; add if missing.

## NATS protocol

- [ ] **Verify the `X1Message` envelope is emitted with all five fields
      (`session_id, timestamp, sequence, type, payload`).**
  - Reference: `docs/reference/protocol.md`.
  - Action: check the sidecar's `nats_bridge.rs` and `stream.rs` emit
    these fields consistently; if a field is missing, either add it or
    remove it from the spec.

- [ ] **All NATS subjects use the `x1.*` namespace.** Audit for stray
      legacy prefixes left behind in code or docs.
  - Action: grep for non-`x1.` subject prefixes; rename or remove.

## In-cluster registry

- [x] `deploy/k8s/dev/registry.yaml` ships a registry Deployment.
- [ ] **Pull-through mirror for `docker.io`, `ghcr.io`, `quay.io` and
      pod-spec rewrite to the `mirror/<registry>/<path>` form.**
  - Action: inspect the registry ConfigMap and confirm mirror config;
    confirm `pod-spec.ts` rewrites public image refs.
- [ ] **Weekly GC CronJob (`registry garbage-collect`).**
  - Action: ship it or strike the claim.

## Credential proxy

- [ ] **Scope catalog built from provider registrations.** Doc says "Scopes
      are registered by providers at startup. Each provider declares the
      scopes it needs. The sidecar's scope catalog is built from these
      registrations."
  - Actual: sidecar's permission model is tied to the grants table; scope
    registration at NATS-subscribe time is not implemented.
  - Action: implement registration or rewrite the doc to describe
    tool-scope naming as a platform-level convention.

- [ ] **`proxy.*` request path.** Doc `security/credential-proxy.md`
      describes the NATS proxy flow (`target`, `scope`, `Authorization:
      Bearer` injection, token drop, audit).
  - Actual: confirm sidecar has a proxy handler; GitHub credential
    helper in `packages/agent/git-credential-x1.sh` is a simpler
    pattern. Harmonize docs and code.

## Docs housekeeping (non-binding but worth fixing while touching)

- [ ] `docs/configuration/helm-values.md` — "Coming soon." placeholder.
- [ ] `docs/security/overview.md` — confirm it still describes the actual
      trust boundary (not scanned in this pass).
- [ ] `docs/security/provider-isolation.md` — confirm consistency with the
      providers-only-over-NATS invariant.
- [ ] `docs/proposals/branch-deploys.md` — referenced from
      `shared-agent-resources.md`. Verify the link resolves; ensure the
      proposal is clearly marked as not-shipping.

---

## How to use this file

When making a change that touches a binding doc, tick the matching
checkbox once the code catches up (or delete/edit the doc section so it
matches reality and tick). When adding new bindings, add a new
checkbox here in the same pass. Work items without a doc claim do not
belong in this file — track them in issues instead.
