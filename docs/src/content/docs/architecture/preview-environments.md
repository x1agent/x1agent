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
