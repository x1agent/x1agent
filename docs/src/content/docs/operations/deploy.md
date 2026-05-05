---
title: Deploying updates
description: Ship code changes to a configured x1agent deployment.
sidebar:
  order: 2
---

`x1agent install` sets up the cluster the first time — Terraform, ESO,
cert-manager, ingress, GSM secrets, the chart. After that runs once,
**`x1agent deploy` is what ships code**: build images, push to Artifact
Registry, run migrations, helm-upgrade.

## The contract

Every deploy:

1. Tags every image with the same string (default: `git rev-parse --short HEAD`).
2. Pushes those images to the deployment's Artifact Registry.
3. Helm-upgrades the chart. A `pre-upgrade` Job runs the migrator
   against in-cluster Postgres before any api or app pod cycles.
4. Only after the Job succeeds does helm roll the workloads.

This means the image and its migrations always ship together. A new
column the api expects is in place before any pod that reads it starts.

## Manual deploy

```sh
# from a checkout, with the active deployment selected via
# installs/<basedomain>.local
mise run deploy:prod

# or directly
cd packages/cli && bun run src/index.ts deploy
```

Flags:

- `--yes` — skip the confirmation prompt. Required for unattended runs.
- `--tag <sha>` — override the image tag. Use to redeploy a specific
  build (rollback) or to pin to a release tag.
- `--skip-build` — only run helm upgrade against an existing tag in
  Artifact Registry. Pair with `--tag` to roll back without rebuilding.

```sh
# rollback to a previous build
x1 deploy --yes --tag a1b2c3d --skip-build
```

## CI/CD

The same command runs in CI. The standard pattern is GitHub Actions
with [Workload Identity
Federation](https://cloud.google.com/iam/docs/workload-identity-federation)
so no long-lived service-account key has to live in a GitHub secret.

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      tag:
        description: "Override image tag"
        required: false

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: ${{ secrets.WIF_SERVICE_ACCOUNT }}

      - uses: google-github-actions/setup-gcloud@v2

      - run: gcloud container clusters get-credentials x1agent --region us-central1 --project ${{ secrets.GCP_PROJECT_ID }}

      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: 1.2.16

      # The deployment file lives in installs/<basedomain>.local and
      # is gitignored. CI rehydrates it from a single GitHub secret —
      # the same file that lives on the operator's laptop.
      - run: echo "${{ secrets.X1AGENT_INSTALL_FILE }}" > installs/${{ vars.BASE_DOMAIN }}.local

      - run: bun install --frozen-lockfile

      - env:
          X1AGENT_DEPLOYMENT: ${{ vars.BASE_DOMAIN }}
        run: bun run packages/cli/src/index.ts deploy --yes --tag ${{ inputs.tag || github.sha }}
```

What the GitHub-side secrets and vars look like:

| Name                       | Type   | Value                                                          |
| -------------------------- | ------ | -------------------------------------------------------------- |
| `WIF_PROVIDER`             | secret | `projects/.../locations/global/workloadIdentityPools/.../providers/...` |
| `WIF_SERVICE_ACCOUNT`      | secret | `x1agent-deployer@<project>.iam.gserviceaccount.com`           |
| `GCP_PROJECT_ID`           | secret | `<your gcp project>`                                           |
| `X1AGENT_INSTALL_FILE`     | secret | full contents of `installs/<basedomain>.local`                 |
| `BASE_DOMAIN`              | var    | e.g. `x1agent.com`                                             |

The deployer service account needs:

- `roles/artifactregistry.writer` (push images)
- `roles/container.developer` (kubectl get/list/patch on the cluster)
- `roles/secretmanager.secretVersionAdder` (only if your CI updates GSM)
- `roles/iam.workloadIdentityUser` on itself (for WIF)

## Rollback

Two paths:

1. **Redeploy the previous SHA**:
   ```sh
   x1 deploy --yes --tag <previous-sha> --skip-build
   ```
   The image is already in Artifact Registry. Helm rolls back to that
   image. Migrations on the new image rerun (idempotent), and any
   migrations *only* in the rolled-forward build stay applied — that's
   why migrations should always be backwards-compatible until the next
   release.

2. **`helm rollback`**:
   ```sh
   helm rollback x1agent <revision> -n x1agent
   ```
   Restores the entire helm release state, including image tags and
   any chart changes. Use when a chart-level change broke things, not
   just the image.

## What `deploy` does NOT do

- No Terraform changes. Run `mise run terraform:prod:apply` for those.
- No GSM rotation. Run `mise run install:prod:apply` (or update GSM out of band).
- No operator-chart upgrades (ESO, cert-manager, ingress-nginx). Those
  upgrade independently with `helm upgrade <name>` in their own namespaces.

These are intentional: `deploy` should be safe to run from CI on every
green main. Anything that touches IAM, DNS, or persistent state stays
behind the bigger `install` command.
