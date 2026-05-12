---
title: Lifecycle — configure, plan, install, deploy
description: How the four prod verbs fit together, when to use each, and how multiple deployments coexist on one machine
sidebar:
  order: 1
---

x1agent has four operator verbs for managing a deployment. Each does one thing; they compose into the full lifecycle. Every one ends in `:prod` so prod intent is never ambiguous in shell history.

```
configure → plan → install → deploy
```

| Verb | Mutates the cluster? | When |
|---|---|---|
| `mise run configure:prod` | No | First time you set up a deployment. Re-run any time you need to add or change a value. |
| `mise run plan:prod` | No | Any time you want to preview what would change — Terraform + Helm in one shot. Safe to run whenever. |
| `mise run install:prod` | Yes (one-shot) | First-time bootstrap of a deployment. Terraform → ESO + cert-manager → secrets → images → helm install. |
| `mise run deploy:prod` | Yes (code only) | Ongoing ships. Builds images + `helm upgrade`. **No Terraform.** Use this once `install:prod` has run at least once. |

Plus housekeeping: `status:prod` (read-only snapshot), `destroy:prod` (type-to-confirm teardown), `logs:prod`, `psql:prod`.

## What each verb actually does

### `configure:prod`

Interactive wizard. Captures cloud target, base domain, admin emails, the bare-minimum non-secret config, and writes everything to `installs/<base-domain>.local`. **Never touches the cluster.** Re-runnable any time — it's idempotent.

See [Configure](/getting-started/configure) for the prompt list and what each value controls.

### `plan:prod`

Read-only diff. Runs `terraform plan` against the GCP module and `helm template` against the chart, prints both side by side. Use this:

- Before a fresh `install:prod` — sanity-check what Terraform is about to provision.
- Before `deploy:prod` after a long pause — see whether infra has drifted (it usually shouldn't, but it does).
- After a chart bump — see which Kubernetes resources `deploy:prod` would touch.

Nothing is applied. No prompts, no confirmations.

### `install:prod`

One-shot bootstrap for a new deployment. Calls, in order:

1. `terraform apply` (first pass) — cluster, IAM, GSM secret resources, Artifact Registry, DNS zone, static IP.
2. Operator step (or automated, depending on chart version) — installs ESO + cert-manager.
3. `terraform apply` (second pass) — adds the `ClusterSecretStore` now that ESO CRDs exist.
4. Builds + pushes the api/app/preview images to the deployment's Artifact Registry.
5. `helm install x1agent` with values templated from `installs/<base-domain>.local`.
6. Waits for the ingress IP to land + the managed TLS cert to go Ready.

Runs once per deployment. Re-running is safe (everything is idempotent) but most operators only re-run `install:prod` after a Terraform-level change.

### `deploy:prod`

Ongoing ship loop. Builds the images, `helm upgrade --install` against the existing release. **Does not touch Terraform.** This is the command you run after merging code.

If `deploy:prod` fails because of an infra delta (e.g., a new GSM secret added in the chart), run `plan:prod` to see what's needed, then `install:prod` to reconcile, then back to `deploy:prod`.

## A typical first install, end-to-end

```bash
mise run configure:prod      # interactive: cloud target, base domain, admin emails, Anthropic source
mise run plan:prod           # preview what's about to happen
mise run install:prod        # bootstrap the whole stack (~10–15 min on GCP)
mise run status:prod         # confirm pods are running + ingress is up
# point DNS at the ingress IP (terraform output: dns_nameservers)
# open https://app.<your-base-domain> — sign in as a platform admin
```

After that, ongoing work is just:

```bash
mise run deploy:prod         # ship new code to the existing deployment
```

## Multiple deployments on one machine

Every operator verb reads **one file** from `installs/`. You can have as many `installs/*.local` files as you want — one per deployment.

```
installs/
  x1agent.com.local           # your reference / dogfood install
  acme.example.com.local      # second customer cloud
  …
```

Each is fully self-contained: its own cloud target, base domain, GCP project, GitHub App credentials, secrets. None of the files touch each other.

### How a verb picks which deployment to act on

In this order:

1. **`X1AGENT_DEPLOYMENT=<base-domain>`** env var — explicit, wins over everything. Best for CI and one-off targeted runs.
2. **Single `installs/*.local` file** — silently uses it (with a `→ target:` header confirmation).
3. **Multiple files + interactive TTY** — wizard prompts you to pick.
4. **Multiple files + non-TTY** — fails fast with the list (so CI never picks the wrong one by accident).

Every operator verb prints a `→ target: x1agent.com (gcp · us-central1 · x1agent)` header before doing anything, so you always see where the command is about to act.

### Listing what's configured

```bash
mise run deployments
```

Reads every file under `installs/` and prints a one-line summary of each (base domain, cloud, project, last-modified).

### Switching between deployments in one shell

Three patterns; pick whichever fits the moment:

**One-off** — env var on the same line:

```bash
X1AGENT_DEPLOYMENT=acme.example.com mise run deploy:prod
```

**Session** — export, then every subsequent verb hits the same deployment:

```bash
export X1AGENT_DEPLOYMENT=acme.example.com
mise run plan:prod
mise run deploy:prod
mise run logs:prod api
```

**Interactive** — leave the env var unset and let the wizard ask each time. Fine for occasional use; tedious for back-to-back commands.

### Gotcha: `gcloud` configuration is separate

Each deployment also wants its own `gcloud` configuration (different account, different project). The wizard creates one named `x1agent` (or per-deployment via `gcloud config configurations create <name>`), but **switching deployments via `X1AGENT_DEPLOYMENT` does NOT auto-switch the gcloud config.** You have to:

```bash
gcloud config configurations activate <name>
export X1AGENT_DEPLOYMENT=<base-domain>
```

The `→ target:` header includes the GCP project ID, so you'll spot a mismatch visually before anything destructive runs. Cleaner auto-switching is tracked as a follow-up — see X1A-83.

## When in doubt

- "What would change if I deployed right now?" → `mise run plan:prod`
- "Is anything broken on the deployment?" → `mise run status:prod`
- "Tail the api logs" → `mise run logs:prod api`
- "Drop into the database" → `mise run psql:prod`
- "Nuke this deployment from orbit" → `mise run destroy:prod` (type-to-confirm; deletes the cluster, the DNS zone, GSM secrets, everything)
