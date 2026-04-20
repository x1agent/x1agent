---
title: Branch deploys (proposal)
description: A non-binding design sketch for deploying the applications agents build back into the cluster, with per-branch preview environments and a deploy_branch MCP tool.
sidebar:
  order: 1
---

**Status: proposal. Not yet architecture. Not yet implemented.** Code should not be written against this document. The [Shared agent resources](/architecture/shared-agent-resources) document is the currently-binding answer for "agents need a database"; branch deploys is a different, larger idea that we may or may not choose to build.

This document captures the design work done during early scoping so the thinking is not lost.

## The question

Given that agents produce application code, and given that the cluster x1agent runs in is a Kubernetes cluster, should the platform support deploying the apps agents build back into that same cluster?

Put differently: can a coding agent close the loop -- write the app, ship the app, observe the app in production, fix the app -- all within one cluster, without routing through an external CI/CD system?

## What makes this a proposal and not architecture

Three reasons this is parked rather than adopted:

1. **Scope.** Shipping this requires a build pipeline (already planned for the image catalog), an Ingress + DNS + TLS story (new), a workload reconciliation loop (new), a `deploy_branch` permission model (extends the existing permission-grants system), and UI surfaces. The surface is large enough that it deserves its own sequencing decision rather than being slipped into the shared-agent-resources scope.
2. **Use-case demand.** The platform's two initial verticals (coding automation, agent automation for external systems) do not require agent-shipped workloads to prove value. Shared agent resources are table-stakes for coding work; branch deploys are an amplifier that becomes valuable once coding automation is working well.
3. **Operator burden.** A production deployment enabling branch deploys needs a wildcard DNS record, a wildcard TLS certificate, and an Ingress controller configured for per-branch hostnames. Shipping without those being optional raises the floor for "default out-of-the-box install" in a way that conflicts with the CLAUDE.md principle that the default path must work with zero operator setup.

If and when this proposal is promoted, it will either ship behind an explicit opt-in (`branchDeploys.enabled: true` in Helm, off by default) or be split into its own optional chart.

## The idea

Every branch in an agent's repo can become a live running Deployment in the workspace namespace, with its own URL, its own database, and its own lifecycle tied to the upstream branch.

```
workspace namespace ws-<id>
  | postgres StatefulSet    <- shared agent resource
  | redis StatefulSet        <- shared agent resource
  | app "api" (branch main)  <- user-authored workload; always up
  | app "api" (branch feat-x)<- ephemeral preview; reaped on branch delete
  | app "api" (branch feat-y)<- ephemeral preview; reaped on branch delete
```

Each branch deploy:

- Its own `Deployment` + `Service`, labeled `x1.app=api, x1.branch=feat-x`.
- In-cluster DNS: `api-feat-x.ws-<id>.svc.cluster.local`.
- External URL via a wildcard Ingress pattern: `feat-x.api.<workspace-slug>.<cluster-domain>` (requires operator to configure wildcard DNS + TLS).
- Uses the branch's Postgres database from shared agent resources (same `DATABASE_URL` the agent saw during development; no separate prod DB).
- Same workspace secrets as the development session.

## The agent-facing surface

A new MCP tool, permission-gated behind a `deploy` grant:

```
deploy_branch(
  app:        string,        // workspace-unique app name
  branch:     string,        // from the agent's working repo
  commit_sha: string,        // pinned for reproducibility
  dockerfile: string,        // repo-relative path
  ports:      number[],
  env?:       Record<string, string>,    // ${SECRET} refs allowed
  replicas?:  number,                     // default 1
  resources?: { cpu, memory }
) -> { url, version, image_ref } | { denied, reason }
```

On approve:

1. Kaniko Job builds the Dockerfile against the agent's repo at `commit_sha`, pushes to the in-cluster registry as `ws/<id>/app-<name>:<commit_sha>`.
2. API creates or updates the Deployment for `(app, branch)` with the new image.
3. API creates a Service + Ingress if they do not yet exist.
4. DSN returned to the agent includes the external URL and the image reference.

The agent can hand the URL back to its parent (an orchestrator) or to the user. Reviewers click the URL to see the change before merging the PR.

## Use cases this unlocks

1. **Preview environments per PR.** Human reviewer clicks a link to see the agent's change running live, not just a diff.
2. **Parallel hypotheses.** An orchestrator spawns three worker agents, each on its own branch. Each produces a running URL. The orchestrator (or the user) visits each, picks the winner, merges. Other branches auto-reap.
3. **Continuous self-deployment.** A dark-factory agent working on an internal tool pushes to main, triggers a deploy, watches logs, iterates. No human in the merge-to-deploy loop for agents with persistent `deploy` grants.

## Where the hard parts live

- **Dev/prod data collapse.** The branch's Postgres database IS the branch's Postgres database, whether the consumer is a dev session or a running branch-deploy pod. This is intentional (agents see one coherent state) but worth naming: a deploy of branch `feat-x` runs against the same rows the last `feat-x` dev session wrote. Main branch is live; every feature branch is its own sandbox.
- **Secrets in deployed pods.** Same workspace secret store. `valueFrom.secretKeyRef` in the Deployment. No new primitive.
- **Rollback.** Version rows per `(app, branch)`; flip `current_version_id`, re-apply. Built image is still in the registry; no rebuild.
- **Reaping.** Daily sweep against GitHub's branch list. Branch gone upstream -> delete Deployment, Service, Ingress, version rows, artifacts.
- **Resource budgets.** Every branch deploy counts against workspace budget. Preview proliferation is a real risk; mitigate with per-workspace "max concurrent branch deploys" setting and a reaper that ages out preview Deployments with no HTTP traffic for N days.

## Where the operator burden lives

- **Ingress controller.** Operator runs one (nginx, Traefik, Istio gateway). x1agent emits plain Ingress resources; whichever controller is installed serves them.
- **Wildcard DNS.** Operator configures `*.<workspace-slug>.<cluster-domain>` to point at the Ingress controller, or delegates that responsibility to `external-dns` with a ZonedRecordSet. Per-workspace subdomains cap the DNS sprawl.
- **Wildcard TLS.** `cert-manager` with a wildcard DNS-01 challenge, one certificate per workspace subdomain. ACME account needed.

None of these are exotic; they are standard K8s infrastructure. But they are three services the operator must configure before the feature works, which is why this proposal bundles an explicit opt-in.

## Data model (sketch)

```sql
workspace_apps (
  id, workspace_id, name, default_branch, created_by, created_at
);

workspace_app_branches (
  id, app_id, branch_name,
  current_version_id,
  deployment_ref, service_ref, ingress_ref,
  url, status, created_at, reaped_at
);

workspace_app_versions (
  id, branch_id, commit_sha, image_ref,
  status, built_at, deployed_at
);

workspace_app_deploy_grants (
  id, app_id, agent_id,
  grant_type='deploy',          -- same permission system as spawn/request_service
  branch_pattern TEXT,          -- e.g. 'feat/*' or '*'
  granted_by, granted_at, revoked_at
);
```

## Companion requirements if promoted

- **In-cluster registry** -- required for hosting built app images. Already planned for Phase 2 of the image catalog work but would be promoted to "ship this first" if branch deploys is prioritized.
- **Kaniko build pipeline** -- required for building app images from agent repos. Same module needed by the image catalog.
- **Permission-grants extension** -- add `deploy` grant type, UI for granting/revoking per agent + branch pattern.
- **Workload reconciler** -- K8s watcher that maps branch-deploy rows to Deployment/Service/Ingress state, heals drift, reaps on branch deletion.
- **Session UI updates** -- the agent's session page should surface branch-deploy URLs in the event stream.

## Open questions that would need resolution before promotion

1. **Multi-repo agents.** One app per repo, or one app across many repos? Currently an agent can attach multiple repos; how does `deploy_branch(app='api', ...)` pick which repo's branch?
2. **Deploy triggers.** Agent-driven only (the agent calls `deploy_branch` after finishing work), or also webhook-driven (GitHub push event -> auto-redeploy)? The former is dark-factory-native; the latter is more conventional and requires webhook plumbing.
3. **Promotion between branches.** Is `main` just "another branch" or does promoting `feat-x` to main mean something special (DB schema migration plan, data copy)?
4. **Cross-workspace linking.** Can an agent in workspace A hit a branch deploy URL in workspace B (e.g. for inter-service testing)? Defaulting to "no" keeps workspace isolation tight; allowing it via an explicit workspace trust edge is a whole other design.
5. **Observability.** Deployed apps emit logs and metrics. Do those route through the same NATS event stream sessions use, or through a separate metrics pipeline? Prometheus scraping the workspace namespace works but changes the platform's monitoring story.

## Adjacent proposals

- **Build pipeline as a provider** -- whether Kaniko is the one right answer or whether the build step should be a port with multiple adapters (Kaniko, Buildkit-rootless, Buildah). Parked; adjacent to branch deploys but independently decidable.
- **Workspace apps as long-running stateful services** -- a cousin of this proposal for when the "app" is something like a MinIO that should be always-on, not branch-scoped.

## Summary

Branch deploys are the dark-factory flywheel: agents produce running applications, not just code. The design maps cleanly onto existing x1agent primitives (workspace namespace, permission grants, in-cluster registry, credential injection). The parked status reflects scope and operator-burden concerns, not technical doubt. If and when this is promoted, the doc moves to `architecture/branch-deploys.md` and the proposal language is stripped.
