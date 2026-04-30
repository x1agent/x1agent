---
title: Configure
description: Capture install values into .env.local and (if deploying to GCP) set up the gcloud configuration
sidebar:
  order: 0
---

`mise run configure` is the pre-flight step that runs before any cluster work. It captures everything x1agent needs to install — cloud target, base domain, secrets — into `.env.local`. It does not touch the cluster.

Run it once on a new clone, or any time you need to add or change a value. The wizard is idempotent: existing values are kept unless you change them.

## What it captures

### Required

These four are checked by `mise run configure:check`, which is a `depends` of `dev:cold` and `dev:direct`. If they're missing, those tasks fail fast with a friendly message instead of a confusing boot error later.

| Variable | What | How |
|---|---|---|
| `JWT_SECRET` | Signing key for platform session tokens | Auto-generated (32 bytes hex) if you don't have one |
| `API_INTERNAL_TOKEN` | Internal service-to-service token | Auto-generated (24 bytes hex) if you don't have one |
| `ANTHROPIC_API_KEY` | The agent runtime's API key | You paste it (`sk-ant-...`) — masked input |
| `PLATFORM_ADMIN_EMAILS` | Comma-separated list of admin emails | You type them |

If you pick GCP as the deployment target, two more become required:

| Variable | What |
|---|---|
| `GCP_PROJECT_ID` | The GCP project ID this install binds to |
| `GCP_ACCOUNT` | The Google account email with access to the project |

### Optional

You're prompted for each block; skip with N. Keys not configured yet aren't blocking — they unlock specific features when you add them.

- **Google OAuth** (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `ALLOWED_DOMAINS`) — for user sign-in
- **GitHub App** (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_WEBHOOK_SECRET`) — for repo + agent integrations. The `GITHUB_APP_PRIVATE_KEY` is captured by hand-editing `.env.local` directly because multi-line paste in a terminal is unreliable.
- **Slack** (`SLACK_BOT_TOKEN`) — for the messaging provider

## Deployment targets

The wizard's first question is "where are you deploying?" The answer drives everything else.

### Local (OrbStack)

The default. `BASE_DOMAIN` is hardcoded to `local.x1agent.dev` to match the manifests under `deploy/k8s/dev/`. URLs become:

- `app.local.x1agent.dev`
- `api.local.x1agent.dev`
- `*.preview.local.x1agent.dev`

No gcloud setup happens. After configure, run `mise run dev:cold` (or `mise run dev` for hot reload) to bring the cluster up.

### Google Cloud (GKE)

You enter the base domain (e.g. `x1agent.com`), the GCP project ID, and the Google account email. The wizard then sets up the `x1agent` gcloud configuration:

```
gcloud config configurations create x1agent
gcloud config set account <your-email> --configuration=x1agent
gcloud config set project <your-project-id> --configuration=x1agent
```

Inside this directory, `.claude/settings.json` sets `CLOUDSDK_ACTIVE_CONFIG_NAME=x1agent`, so any `gcloud` call from a Bash tool automatically uses this configuration. A safety hook (`enforce-x1agent-gcloud-config.sh`) blocks `--project=`, `--account=`, or `--configuration=` flags that would silently target a different account or project.

If the requested account isn't logged in yet, the wizard tells you to run `gcloud auth login <email>` in another terminal — it doesn't run that for you because the browser flow is hard to integrate cleanly.

> **Note**: the Helm chart for GCP deployment isn't built yet. Right now, the configure step captures the values; the actual `helm install` flow lands in a follow-up.

## Multiple deployment targets later

x1agent is built so future operators can install on AWS, Azure, or other providers. The wizard's `provider` field is the single switch that abstracts this — `local` and `gcp` are the only options today. New providers add an option to the select prompt and a section in the wizard for their cloud-specific bindings (project ID, account, secret store, etc.).

The base-domain pattern is provider-agnostic: `app.<domain>`, `api.<domain>`, `*.preview.<domain>` works the same on any cloud, and the Helm chart will template ingress hostnames from `BASE_DOMAIN` regardless.

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
[configure:check] missing required values:
  - ANTHROPIC_API_KEY
  - PLATFORM_ADMIN_EMAILS

[configure:check] run `mise run configure` to fix.
```

Exit code is 1 if anything required is missing, 0 otherwise. Optional misses surface as informational warnings on stderr but never fail the check.
