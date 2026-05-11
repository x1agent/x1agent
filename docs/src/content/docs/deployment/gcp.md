---
title: Install on Google Cloud
description: Stand up x1agent on GKE Standard with cert-manager + Let's Encrypt and GSM-backed secrets
sidebar:
  order: 2
---

The GCP install path uses the Helm chart at `deploy/helm/x1agent/`, fed by the values you captured with `mise run configure:prod`. Secrets live in Google Secret Manager (GSM), synced into the cluster by External Secrets Operator (ESO). TLS comes from cert-manager + Let's Encrypt (DNS-01 challenge against Cloud DNS).

> **v1 scope**: the Terraform module at `deploy/terraform/gcp/` provisions the cluster, IAM, GSM secret resources, Artifact Registry, DNS zone, and global static IP. Helm-side, the chart assumes ESO is installed cluster-wide (one operator step between the two terraform applies — see Sequence below).

## Prerequisites

- A GCP project with billing enabled (the Terraform module enables APIs but does not create projects)
- `gcloud`, `kubectl`, `helm`, `terraform` (>= 1.3), and `bun` on PATH
- `mise run configure:prod` already completed with `CLOUD_PROVIDER=gcp` (writes the project ID, account, base domain, and the bare-minimum non-secret config to `installs/<base-domain>.local`)

Everything else (cluster, IAM, GSM placeholders, Artifact Registry, static IP, DNS zone) is provisioned by the Terraform module — see Sequence below.

## Sequence

```bash
# 1. Capture install values
mise run configure:prod

# 2. Provision GCP-side infra in two passes (ESO CRDs need to exist
#    before the ClusterSecretStore manifest applies)
mise run terraform:prod:init
mise run terraform:prod:apply:cluster   # cluster + IAM + GSM + AR + DNS

# 3. Get cluster credentials, install ESO, annotate its SA for WI
gcloud container clusters get-credentials x1agent --region us-central1 --project <project>
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace --set installCRDs=true
kubectl -n external-secrets annotate sa external-secrets \
  iam.gke.io/gcp-service-account=x1agent-eso@<project>.iam.gserviceaccount.com
kubectl -n external-secrets rollout restart deploy/external-secrets

# 4. Second terraform apply — adds the ClusterSecretStore now ESO CRDs exist
mise run terraform:prod:apply

# 5. Populate GSM secrets (each one created empty — values never touch
#    Terraform state). At minimum:
echo -n "$ANTHROPIC_API_KEY" | gcloud secrets versions add x1agent-anthropic-api-key \
  --project=<project> --data-file=-
# Repeat for: x1agent-jwt-secret, x1agent-api-internal-token,
# x1agent-postgres-password, plus any optionals you actually use.

# 6. Build + push images, then helm install via the installer
mise run install:prod:plan
mise run install:prod:apply

# 7. Watch status until ingress IP + cert are ready
mise run install:prod:status

# 8. Set NS records at your registrar pointing at the Cloud DNS zone
#    (terraform output: dns_nameservers)
```

## Build + push images

`mise run install:prod:build-images` (which calls `deploy/scripts/build-push-prod.sh`) builds and pushes seven images to your Artifact Registry:

| Image | Dockerfile | Used by |
| --- | --- | --- |
| `api` | `deploy/docker/api.prod.Dockerfile` | api Deployment, migrate Job |
| `app` | `deploy/docker/app.prod.Dockerfile` | app Deployment |
| `preview` | `deploy/docker/preview.prod.Dockerfile` | preview provider |
| `graph-surrealdb` | `deploy/docker/graph-surrealdb.prod.Dockerfile` | graph provider |
| `mcp-oauth-proxy` | `deploy/docker/mcp-oauth-proxy.prod.Dockerfile` | per-attached `remote_oauth` MCP |
| `agent` | `packages/agent/Dockerfile` | session pods |
| `sidecar` | `packages/sidecar/Dockerfile` | session pods (sidecar container) |

The installer's `install:prod` (and the subsequent `deploy:prod`) wraps this
for you. Run `mise run install:prod:build-images` only when you want to
rebuild without re-applying the chart.

Pass the tag to the installer via `INSTALL_IMAGE_TAG=$TAG mise run install:prod:plan`. If unset, the installer uses the current git short-SHA.

## Plan

```
mise run install:prod:plan
```

This:
1. Verifies preflight (gcloud auth present, .env.local present, helm/kubectl/gcloud on PATH)
2. Renders `deploy/helm/x1agent/values.<baseDomain>.yaml` from `installs/<base-domain>.local`
3. Runs `helm template` and reports how many resources would be created

No cluster mutation. Safe to run repeatedly. The values file is regenerated each time, so `.env.local` changes flow through.

## Apply

```
mise run install:prod:apply
```

Confirms once, then runs:

```
helm upgrade --install x1agent deploy/helm/x1agent \
  -f deploy/helm/x1agent/values.<baseDomain>.yaml \
  --namespace x1agent --create-namespace --wait --timeout 10m
```

TLS provisioning is async — the chart creates `Certificate` CRs that cert-manager fulfils via Let's Encrypt's DNS-01 challenge against Cloud DNS. First-time provisioning typically takes 1–10 minutes. Pods come up before the cert is ready; HTTPS will fail until then. (Switch to the `*-staging` ClusterIssuer during iteration to avoid Let's Encrypt's 5-duplicate-cert/week rate limit.)

## Status

```
mise run install:prod:status
```

Prints:
- Each Deployment's `ready/desired` replica count
- The Ingress's allocated IP (or `(pending)`)
- The `Certificate` Ready condition, per host

Run it on a loop while waiting for first-time cert provisioning.

## Destroy

```
mise run install:prod:destroy
```

Double-confirms, then `helm uninstall`. The in-cluster Postgres PVC is deleted with the StatefulSet — there are no GSM-backed backups in v1, so this is a one-way operation. Take a `pg_dump` first if you care about the data.

## What's templated from `.env.local`

The installer's render step converts these `installs/<base-domain>.local` values into Helm overrides:

| `.env.local` key | Helm path | Notes |
|---|---|---|
| `BASE_DOMAIN` | `baseDomain` | URLs derived in templates |
| `GCP_PROJECT_ID` | `cloud.gcp.projectId` | Workload Identity GSA derived from this |
| `GCP_REGION` | `cloud.gcp.region` | Default `us-central1` |
| `ARTIFACT_REGISTRY` | `cloud.gcp.artifactRegistry` + each `images.*.repository` | Default `<region>-docker.pkg.dev/<project>/x1agent` |
| `PLATFORM_ADMIN_EMAILS` | `config.PLATFORM_ADMIN_EMAILS` | Inline env on api pod |
| `ALLOWED_DOMAINS` | `config.ALLOWED_DOMAINS` | Inline env on api pod |

Secrets (`ANTHROPIC_API_KEY`, `JWT_SECRET`, etc.) are NOT in `values.yaml`. They live in GSM and ESO syncs them into a K8s `Secret/x1agent-secrets` that the api `envFrom`s.

## Future cloud providers

`CLOUD_PROVIDER=gcp` is currently the only option. The wizard, the chart, and the installer are all written so adding `aws` or `azure` is a matter of:

1. Adding the option to `configure`'s cloud-provider select
2. Templating cloud-specific bits in the chart (Workload Identity → IRSA, managed cert → ACM, GSM → AWS SM)
3. Adding a new secret-store kind in the ExternalSecret bindings
4. Following with a Terraform module under `deploy/terraform/<provider>/`

The `BASE_DOMAIN` + URL derivation pattern is provider-agnostic.
