---
title: Preview environments
description: First-class, URL-addressable deployments that outlive sessions
sidebar:
  order: 7
---

A **preview environment** is a durable, URL-addressable deployment of an agent-authored app. Unlike a session (ephemeral, per-task) or a share (one-shot artifact), a preview environment persists until explicitly destroyed. Multiple agent sessions can deploy to it over time — one at a time — and anything external to x1agent (OAuth callbacks, DNS records, CORS allowlists, bookmarks in tickets) gets to rely on a stable URL.

This page covers the concept, the data model, the claim semantics that keep two agents from stepping on each other, and the UI surfaces that expose all of it. For the provider contract that actually stands up and tears down environments, see [Preview Provider](/providers/preview). For the in-repo config format that the orchestrator writes and the provider validates, see [Preview spec reference](/reference/preview-spec).

## Why the URL is the durable entity

The first instinct is to make the session the unit of deployment — spin up a fresh URL per session, tear it down when the session ends, start over next time. That model is clean and fails the moment a preview needs to interact with anything external to the platform.

Anything humans or other systems attach to, they attach to by URL:

- **OAuth callback registration.** Google, Microsoft, Okta, Auth0, GitHub — all of them require callback URLs to be registered up front. You cannot add a new callback programmatically at the pace sessions spin up. You have to register once, then keep using that URL.
- **DNS + TLS certificate provisioning.** A wildcard cert costs nothing for `*.x1agent.localhost`, but for real external domains you're often dealing with specific hostnames, DNS propagation windows, and cert-manager lease times that exceed session lifetimes.
- **Third-party webhook receivers.** Stripe, GitHub, Slack, SendGrid — you point them at a URL once. Rotating URLs per session means re-registering webhooks per session.
- **Human reviewer bookmarks and ticket links.** "The preview is at https://pr-123.preview.company.com" ends up pasted in a dozen Linear / GitHub / Slack threads. If that URL dies with the session, the threads become archaeology.
- **CORS origins, CSP `connect-src` rules, cookie domains.** All scoped by hostname.

The preview environment is defined by its URL. Pods, deploys, sessions, agents — those can churn underneath it. The URL is the contract.

## Data model

```
preview_environments
  id                 uuid PK
  workspace_id       uuid
  url                text UNIQUE          -- the durable contract
  provider_kind      text                 -- local-k8s | vercel | ecs | nomad | ...
  provider_config    jsonb                -- opaque per-provider settings
  status             text                 -- idle | ready | deploying | failed
  created_at         timestamptz
  updated_at         timestamptz

preview_claims
  id                 uuid PK
  preview_env_id     uuid FK preview_environments.id
  session_id         uuid FK sessions.id
  agent_id           uuid                 -- denormalized from session for history queries
  repo               text
  branch             text
  commit_sha         text
  deploy_status      text                 -- claiming | building | deploying | ready | failed | released
  claimed_at         timestamptz
  released_at        timestamptz null     -- partial unique index enforces at most one open claim per env
```

Two invariants enforced by the database, not by application code:

- **`preview_environments.url` is globally unique.** The URL is a platform-wide primary key of user-facing identity.
- **At most one open claim per environment.** `CREATE UNIQUE INDEX ... WHERE released_at IS NULL` on `(preview_env_id)`. If two sessions try to claim simultaneously, one wins at the DB layer; the loser reads the failure and surfaces a "held by session X" error to the caller.

## Claim semantics

A claim is a mutex whose name is the preview environment. Sessions acquire, use, release.

### Acquire

`POST /api/workspaces/:slug/previews/:id/claim` with `{ session_id, repo, branch, commit_sha }`:

- **200 OK** with the claim row if the environment is idle.
- **409 Conflict** with `{ held_by_session, held_by_agent, held_since }` if another claim is open.

### Release

- **Explicit:** `POST /api/workspaces/:slug/previews/:id/release` from the session that owns the claim.
- **Session end:** the session-terminal event (`session.completed` / `session.failed` / `session.canceled`) triggers a release of any claims the session holds.
- **Reaper:** a periodic job in the api (sibling of the grants reaper already on the system) walks `preview_claims WHERE released_at IS NULL` and releases claims whose session is in a terminal state. Catches ungraceful session exits.

### Force takeover

Sometimes you need the environment even though another session holds it — the held session is stuck, or a human wants to take over an agent's work. The UI surfaces this as a dangerous action:

```
This environment is held by session <link> (agent <link>).
Taking it over will cancel that session. Continue?
```

The flow:

1. User confirms.
2. api cancels the held session (standard session cancel path).
3. Session-end release fires for the old claim.
4. New claim proceeds.

No silent takeovers — always a confirmation with the held session named.

## The two creation paths

**Pre-declared.** Operator creates an empty preview environment in the UI before any session attaches. Pick a URL, pick a provider, save. The environment starts in `idle` status with no claims. Sessions attach later with `claim`. Use this path when the URL has to be stable and known externally — SSO callbacks, webhook endpoints, anything pre-registered in a third-party service.

**On-first-deploy.** A session deploys to a preview without a pre-existing environment. The provider mints one with an auto-assigned URL (`{branch-slug}-{repo-slug}-{hash}.x1agent.localhost` for the local provider), the preview row is created, and the deploying session gets the first claim atomically. Simpler for throwaway work. Can be disabled per workspace if you want pre-declare-only discipline.

Workspaces default to **both enabled**. Toggle in Workspace → Settings → Previews.

## Configuration split: what's in the repo vs. what's in x1agent

A preview deploy has two halves that have to agree.

| Lives in the repo (`.x1agent/preview.yaml`) | Lives in x1agent's DB |
|---|---|
| How to build this code: entrypoint (Dockerfile / compose / helm), build context, port | The URL it deploys to |
| Runtime config: healthcheck, resource requests/limits | The provider_kind (local-k8s / vercel / ...) |
| Declared dependencies: "I need a Postgres, I need a Redis" | Whether those shared resources exist in the workspace |
| Required secrets by reference name (`secret:anthropic_api_key`) | The actual secret values |
| Environment variables (declared, with sources) | The resolution of `preview.self_url` and other placeholders |

The split is deliberate. The repo is portable — the same repo deploys against any Preview Provider the operator has configured. The workspace is stateful — which URLs exist, who's claimed them, what secrets fill their env.

The full reference for `.x1agent/preview.yaml` is [Preview spec reference](/reference/preview-spec). In short: it's declarative, JSONSchema-validated, small enough for an orchestrator agent to write from a prompt, opinionated about the five `entrypoint.kind` values (dockerfile, compose, helm, kustomize, manifest).

## Validation

The provider validates `.x1agent/preview.yaml` twice:

- **Dry-run** (`preview.validate(repo_ref, spec) → { ok, errors, warnings }`). The orchestrator calls this before handing the work to a coding agent — catches bad config up front instead of after an expensive build.
- **Pre-deploy**. Same checks re-run as step zero of every actual deploy. The repo can drift between dry-run and deploy (the coding agent may change things); we verify again.

The validator checks:

1. The file parses and matches the JSONSchema.
2. Referenced build entrypoint exists (`Dockerfile`, `compose.yaml`, `Chart.yaml`, …).
3. Declared port is non-privileged, under 65535, reasonable for a dev server.
4. Declared dependencies are available in the workspace — shared Postgres / shared Redis / attached MCPs, etc.
5. Every `from: secret:...` resolves to an existing workspace secret.
6. Every `from: preview.*` is a known placeholder.
7. The `entrypoint.kind` is compatible with the target environment's `provider_kind`.
8. Resources fit within the workspace preview quota.

Errors block the deploy. Warnings don't but surface in the UI and in the orchestrator's input. Diagnostics come back with structured field paths so the coding agent can patch the exact line.

## UI

### Workspace → Previews

New sidebar entry, alongside Agents / Sessions / Shares.

Table columns:

- **URL** (truncated, copyable, click-to-open).
- **Provider** (badge — local-k8s / vercel / ...).
- **Current claim** (session · agent · branch) or "idle".
- **Status** (idle / deploying / ready / failed).
- **Last deployed** (relative time).

Filters: status, provider, agent, "has active claim".

"New preview environment" button in the header — opens a form for the pre-declare path.

### Preview detail

The per-environment page. Sections:

**Header** — URL (large, copyable), status, provider badge, "Destroy" in a danger-zone section.

**Current claim** — session link, agent link, branch, commit SHA, deploy status, tail of recent logs. Actions: Release claim · Redeploy · Force takeover (disabled if no other claim exists).

**Claim history** — table of every past session that held this environment. Session · agent · branch · commit · claimed at · released at · outcome. Click a row to jump to the archived session view. This is the "historic sessions list" you asked for.

**Provider config** — read-only panel showing the provider-specific settings the environment was created with (image registry, cluster target, etc.). Edits require destroy-and-recreate.

**Dependencies** — the shared resources this environment's current deploy depends on (from the repo's `preview.yaml`), with status indicators per dependency.

### Session ↔ preview on the session detail page

Each session row shows which preview(s) it currently holds a claim on, with a click-through. The existing [session detail page](/architecture/sessions) gains a "Previews" section alongside the existing Shares section — the two are parallel concepts (durable outputs of session work) and the UI treats them symmetrically.

## Cross-session workflow patterns

The two-table model supports the patterns you actually want.

**Orchestrator hands off to coding agent, coding agent iterates, human reviews later.** Orchestrator creates the PE (pre-declared path, fixed URL registered with Google SSO). Coding agent session 1 claims, deploys branch `feat/auth`, iterates. Session ends — claim released. Orchestrator reviews the PE asynchronously, decides tweaks are needed. Creates session 2 on the same agent, which claims the same PE, deploys branch `feat/auth-fixed`. History view shows both sessions, both branches, linked back to the original.

**A/B testing two branches against the same URL.** Session 1 deploys `main` to the PE. Session 2 wants to deploy `experimental` to the same PE — can't, session 1's claim is open. Either wait for session 1 to finish, or force-takeover (cancelling session 1). Only one "production" experience lives at the URL at a time, which matches what external users see.

**Throwaway per-branch previews.** On-first-deploy mode — each session creates its own PE with an auto-generated URL. Previews accumulate; the workspace's TTL reaper eventually cleans the idle ones. Good for per-PR preview links without any ceremony.

## What outlives what

```
workspace
  └─ agent                              ← configuration: prompt, schedule, runtime
       └─ session                       ← one execution run
            ├─ events (append-only)     ← durable log of the run
            ├─ shares                   ← outputs the agent published (files)
            └─ preview_claim            ← open while the session owns a PE

  └─ preview_environment                ← URL + provider
       ├─ preview_claim (current)       ← at most one open claim
       └─ preview_claims (history)      ← every past claim
```

The preview environment outlives every session that ever touched it. The URL outlives the environment (if you're careful — destroying and recreating with the same URL is a supported operation). The history trails extend indefinitely.

## Related reading

- [Preview Provider](/providers/preview) — the pluggable interface that actually deploys.
- [Preview spec reference](/reference/preview-spec) — the `.x1agent/preview.yaml` format, written to be readable by both humans and orchestrator agents.
- [Sessions](/architecture/sessions) — the session lifecycle, which the claim reaper hooks into.
- [Shared agent resources](/architecture/shared-agent-resources) — the Postgres / Redis that preview dependencies can point at instead of spinning up their own.
