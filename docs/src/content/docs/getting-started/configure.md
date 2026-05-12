---
title: Configure
description: Capture install values into .env.local and (if deploying to GCP) set up the gcloud configuration
sidebar:
  order: 2
---

> See [Lifecycle](/getting-started/lifecycle) for how `configure → plan → install → deploy` fit together and how multiple deployments coexist on one machine. This page focuses on the `configure:prod` step.


`mise run configure:prod` is the pre-flight step that runs before any cluster work. It captures everything x1agent needs to install — cloud target, base domain, secrets — into a per-deployment file at `installs/<base-domain>.local`. It does not touch the cluster.

One file per deployment. Run `mise run configure:prod` once for x1agent.com, again later for acme.example.com, etc. — each writes its own file under `installs/`, never overwriting the others. List what's already configured with `mise run deployments`.

Run it any time you need to add or change a value. The wizard is idempotent: existing values are kept unless you change them. To edit an existing deployment, pick it from the list at the top of the wizard. To create a new one, pick "+ New deployment" and type a base domain that doesn't already have a file — the wizard refuses to silently overwrite an existing one.

## What it captures

### Required

These are checked by `mise run configure:check`, which is a `depends` of every cluster-mutating prod task (`install:prod`, `plan:prod`, `deploy:prod`, `destroy:prod`, `logs:prod`, `psql:prod`, and the underlying `install:prod:*` / `terraform:prod:*` tasks they wrap). If anything is missing, those tasks fail fast with a friendly message instead of a confusing boot error later. Read-only tasks (`status:prod`, `terraform:prod:init`) skip the check.

| Variable | What | How |
|---|---|---|
| `CLOUD_PROVIDER` | Where this install lands (`gcp` is the only option today) | Picked from a menu |
| `BASE_DOMAIN` | The base hostname for ingress (e.g. `x1agent.com`) | You type it; same as the deployment file name |
| `JWT_SECRET` | Signing key for platform session tokens | Auto-generated (32 bytes hex) on confirmation if you don't have one |
| `API_INTERNAL_TOKEN` | Internal service-to-service token | Auto-generated (24 bytes hex) silently if you don't have one |
| `PLATFORM_ADMIN_EMAILS` | Comma-separated list of admin emails | You type them |
| `ANTHROPIC_PROVIDER` | Source of the agent's Claude credential — `api_key` or `vertex` | Picked from a menu |

If `ANTHROPIC_PROVIDER=api_key`:

| Variable | What | How |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic console API key (`sk-ant-...`) | You paste it — masked input |

If `ANTHROPIC_PROVIDER=vertex` (only valid when `CLOUD_PROVIDER=gcp`):

| Variable | What | How |
|---|---|---|
| `CLOUD_ML_REGION` | Vertex region (e.g. `us-central1`) | You type it |
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP project hosting Vertex | You type it (defaults to `GCP_PROJECT_ID`) |

If `CLOUD_PROVIDER=gcp`, two more become required:

| Variable | What |
|---|---|
| `GCP_PROJECT_ID` | The GCP project ID this install binds to |
| `GCP_ACCOUNT` | The Google account email with access to the project |

### Optional

You're prompted for each block; skip with N. Keys not configured yet aren't blocking — they unlock specific features when you add them.

- **Provider selection** (`PROVIDER_GRAPH`, `PROVIDER_VECTOR`) — picks which graph/vector provider deployment this install runs (or `none`). The api echoes them through `GET /api/capabilities`; the frontend hides Collections etc. when set to `none`.
- **Allowed sign-in domains** (`ALLOWED_DOMAINS`) — comma-separated; blank = any verified Google account.
- **Google OAuth** (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`) — for user sign-in.
- **GitHub App** (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_WEBHOOK_SECRET`) — for repo + agent integrations. The `GITHUB_APP_PRIVATE_KEY` is captured by hand-editing `installs/<base-domain>.local` directly (newlines escaped as `\n`) because multi-line paste in a terminal is unreliable.
- **Slack** (`SLACK_BOT_TOKEN`) — for the messaging provider.
- **Sentry DSNs** (`SENTRY_DSN_API`, `SENTRY_DSN_APP`, `SENTRY_DSN_SIDECAR`) — error reporting per runtime; SDKs no-op when unset.

## Picking a target

If `installs/` already has files, the wizard opens with a list of existing deployments. Picking one drops you into "edit" mode for that deployment. Picking "+ New deployment" creates a new file — the base-domain prompt refuses values that collide with an existing file, so a typo can't silently overwrite x1agent.com when you meant to create acme.example.com.

If `installs/` is empty, the wizard goes straight to the base-domain prompt for a new deployment.

### Local development (`.env.local`)

`mise run configure:prod` opens with a "What are you configuring?" prompt that branches on `local` vs `deployment`. The deployment branch writes to `installs/<base-domain>.local`. The local branch writes `.env.local` (asks only about `AUTH_BYPASS`/`TEST_USER`/Claude credential paths). The local-dev cluster is OrbStack-only and uses hardcoded base domains (`*.local.x1agent.dev`); the wizard for it is optional — most operators edit `.env.local` by hand using `.env.example` as a template.

### Google Cloud (GKE)

You enter the base domain (e.g. `x1agent.com`), the GCP project ID, and the Google account email. The wizard then sets up an `x1agent` gcloud configuration:

```
gcloud config configurations create x1agent
gcloud config set account <your-email> --configuration=x1agent
gcloud config set project <your-project-id> --configuration=x1agent
```

Inside this directory, `.claude/settings.json` sets `CLOUDSDK_ACTIVE_CONFIG_NAME=x1agent`, so any `gcloud` call from a Bash tool automatically uses this configuration. A safety hook (`enforce-x1agent-gcloud-config.sh`) blocks `--project=`, `--account=`, or `--configuration=` flags that would silently target a different account or project.

If the requested account isn't logged in yet, the wizard tells you to run `gcloud auth login <email>` in another terminal — it doesn't run that for you because the browser flow is hard to integrate cleanly.

**Multiple deployments on one machine**: when you have x1agent.com on one Google account and acme.example.com on another, the gcloud configurations are managed by you, not the wizard. The pattern is `gcloud config configurations create <name>` once per deployment, then `gcloud config configurations activate <name>` before running prod tasks against that deployment. See [Picking which deployment to act on](#picking-which-deployment-to-act-on) below.

## Picking which deployment to act on

Every prod task (`plan:prod`, `install:prod`, `deploy:prod`, `status:prod`, `destroy:prod`, `logs:prod`, `psql:prod`) reads one file from `installs/`. With one file present it picks that one silently. With multiple, the resolver picks in this order:

1. `X1AGENT_DEPLOYMENT=<base-domain>` — explicit env var (CI / scripted)
2. Single `installs/*.local` file → use it
3. Multiple files + interactive TTY → prompt to pick
4. Multiple files + non-TTY → fail fast with the list

Every prod task prints a `→ target: <base-domain> (cloud · region · project)` header before doing anything, so you always see where the command is about to act. If you forget which `X1AGENT_DEPLOYMENT` is exported in the current shell, that header surfaces it.

To list what's configured: `mise run deployments`.

## Multiple cloud providers later

x1agent is built so future operators can install on AWS, Azure, or other providers. The wizard's `provider` field is the single switch that abstracts this — `gcp` is the only option today, and the only target verified by the install path (`packages/cli/src/install/up.ts`, `deploy/terraform/gcp/`). New providers will add a section in the wizard for their cloud-specific bindings (project ID, account, secret store, etc.) and a sibling `deploy/terraform/<provider>/` module.

The base-domain pattern is provider-agnostic by design: `app.<domain>`, `api.<domain>`, `*.preview.<domain>`. The Helm chart templates ingress hostnames from `BASE_DOMAIN`, so the chart itself is cloud-neutral; the cloud-specific work is in the Terraform module.

## Re-running

The wizard is fully idempotent. On re-run:

- Each prompt shows the current value (masked if it's a secret)
- Empty input keeps the current value
- The "About to write" summary lists only what actually changed (`+` added, `~` modified, `-` removed)
- You confirm before anything is written

Switching deployment targets (e.g. `local` → `gcp`) prompts for the new fields and clears the ones that no longer apply.

## Just check, don't prompt

`mise run configure:check` runs the same validation without any TUI. Useful in CI, in scripts, or when you just want to know whether `dev:cold` is going to refuse to start:

```
$ mise run configure:check
[configure:check] /Users/you/x1agent/installs/x1agent.com.local
[configure:check] missing required values:
  - ANTHROPIC_API_KEY
  - PLATFORM_ADMIN_EMAILS

[configure:check] run `mise run configure:prod` to fix.
```

(The validator also prints the resolved deployment file path on the first line, so you can see which install file is being checked when multiple are configured.)

Exit code is 1 if anything required is missing, 0 otherwise. Optional misses surface as informational warnings on stderr but never fail the check.
