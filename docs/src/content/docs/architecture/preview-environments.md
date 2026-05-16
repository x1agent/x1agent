---
title: Preview environments
description: What's shipping today and where the design is going
sidebar:
  order: 7
---

> **Status — partial.** Today the platform supports one-shot preview deploys via the `preview_deploy` MCP tool and the preview provider in `packages/providers/preview/`. The durable `preview_environments` and `preview_claims` tables, the claim/release semantics, the force-takeover flow, and the `/workspaces/:slug/previews` UI described in [proposals/preview-environments](/proposals/preview-environments) are not yet implemented.

## What ships today

- The `preview_deploy({ repo_full_name, branch, commit_sha })` MCP tool an agent can call. Returns the deployed URL on success.
- The `preview` provider deployment, subscribed to the NATS subject `x1.provider.preview.provision`. Builds with Kaniko, applies a Deployment + Service + Ingress, returns the URL.
- The `.x1agent/preview.yaml` spec format — see [Preview spec reference](/reference/preview-spec).

There is no concept of a *durable* preview environment that outlives the session that deployed it, no claim mutex, and no admin UI to manage them. Sessions deploy fresh URLs every time. This is fine for ephemeral one-shot flows; it is the wrong shape once previews need stable URLs for OAuth callbacks, webhooks, and human bookmarks.

## What's coming (proposal)

See [proposals/preview-environments](/proposals/preview-environments) for the full design covering durable URLs, claim semantics, pre-declared vs. on-first-deploy paths, and the workspace UI. That doc was originally drafted at this URL; this page kept the URL stable while the design was being implemented.

The preview provider lives at `packages/providers/preview/` and subscribes to `x1.provider.preview.provision`.

## Enabling previews on a deployment

Previews are off by default because the wildcard certificate requires DNS-01 ACME, which not every install has Cloud DNS for. To turn them on:

1. **Set `PREVIEWS_ENABLED=true`** in `installs/<base-domain>.local`. Re-run `mise run install:plan` to regenerate the values file.
2. **Switch to DNS-01 TLS** in the same install file: `TLS_SOLVER=dns01` and `TLS_DNS01_PROJECT=<gcp-project-id>` (often the same as `GCP_PROJECT_ID`). The chart fails fast if previews are enabled without DNS-01 — wildcards can't issue via http01.
3. **Add the wildcard DNS record** at your registrar: `*.preview.<base-domain>` A-records pointing at the cluster's ingress static IP (the same IP `app.<base>` and `api.<base>` use).
4. **Run `mise run install:prod`**. The orchestrator does the rest:
   - Terraform creates the `x1agent-preview-build` GSA with `roles/artifactregistry.writer` on the install's AR repo.
   - The chart creates the `x1-previews` namespace, the cross-namespace RBAC, the wildcard Certificate, and the preview-provider Deployment.
   - The cert-manager DNS-01 challenge writes a TXT record to the configured Cloud DNS project, Let's Encrypt issues the wildcard cert, and the Secret lands in `x1-previews/x1agent-preview-wildcard-tls`.
5. **Verify** by calling `preview_deploy({ repo_full_name, branch, commit_sha })` from an agent. The provider clones the repo with a short-lived GitHub App installation token, builds with Kaniko, applies the Deployment/Service/Ingress, and returns the public URL.

If the agent doesn't have access to the repo it's deploying, install the install's GitHub App on the org/repo first — preview builds reuse the same GitHub App machinery as in-cluster git workspace builds.
