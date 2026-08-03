---
title: Helm Values Reference
description: Configuration options for the x1agent Helm chart
sidebar:
  order: 1
---

The chart at `deploy/helm/x1agent/` is the v1 install surface. This page documents
every supported value, grouped to match the canonical `values.yaml`. The chart
today targets GCP only; multi-cloud support is on the roadmap (see
[CLAUDE.md "Distribution target"](/contributing/distribution-target)).

:::note
The installer renders a deployment-specific override at
`deploy/helm/x1agent/values.<base-domain>.yaml` from your
`installs/<base-domain>.local` file. You generally don't author `values.yaml`
by hand — you set the inputs in the install file and let the installer
template the chart.
:::

## Identity

| Key | Default | Notes |
| --- | --- | --- |
| `nameOverride` | `""` | Used in resource names + labels. |
| `baseDomain` | `x1agent.com` | Derives `app.<domain>`, `api.<domain>`, `*.preview.<domain>`. |

## Cloud bindings (GCP only in v1)

| Key | Default | Notes |
| --- | --- | --- |
| `cloud.provider` | `gcp` | Only `gcp` is supported today. |
| `cloud.gcp.projectId` | `""` | Project the install lives in. |
| `cloud.gcp.region` | `us-central1` | Region for GKE + cloud-managed certs. |
| `cloud.gcp.workloadIdentityServiceAccount` | `""` | GSA bound to the api SA via WI. Terraform output. |
| `cloud.gcp.sessionWorkloadIdentityServiceAccount` | `""` | GSA bound to session SAs. |
| `cloud.gcp.artifactRegistry` | `us-central1-docker.pkg.dev/REPLACE/x1agent` | AR repo path. |

## TLS

The chart provisions cert-manager `ClusterIssuer`s for Let's Encrypt
(production + staging) using the DNS-01 challenge against Cloud DNS.

| Key | Default | Notes |
| --- | --- | --- |
| `tls.clusterIssuer` | `x1agent-letsencrypt` | Production ClusterIssuer name. A `<name>-staging` issuer is created in parallel — flip Certificates to it during iteration to avoid Let's Encrypt's 5-duplicate-cert/week rate limit. |
| `tls.email` | `""` | ACME account email. Defaults to first `PLATFORM_ADMIN_EMAILS` entry. |

## Anthropic credential source

| Key | Default | Notes |
| --- | --- | --- |
| `anthropic.provider` | `vertex` | `vertex` (Workload Identity, recommended on GCP) or `api_key` (direct Anthropic API). |
| `anthropic.vertexRegion` | `global` | Vertex AI region. `global` recommended; pinned regions like `us-east5` for data-residency. |
| `anthropic.vertexProjectId` | `""` | GCP project hosting the Anthropic publisher models. Usually same as `cloud.gcp.projectId`. |

## Image overrides

The installer fills `repository` + `tag` for each image at render time from
`cloud.gcp.artifactRegistry` and the captured deploy SHA.

| Key | Default | Used by |
| --- | --- | --- |
| `images.api.{repository,tag,pullPolicy}` | (filled), `latest`, `Always` | api Deployment + migrate Job. |
| `images.app.{repository,tag,pullPolicy}` | as above | app Deployment. |
| `images.preview.{repository,tag,pullPolicy}` | as above | preview provider Deployment. |
| `images.agent.{repository,tag}` | (filled), `latest` | session pods. |
| `images.sidecar.{repository,tag}` | as above | session pods (sidecar container). |
| `images.mcpOAuthProxy.{repository,tag}` | as above | per-attached `remote_oauth` MCP. |

## api Deployment

| Key | Default | Notes |
| --- | --- | --- |
| `api.replicas` | `1` | Stateless; multiple replicas safe. |
| `api.resources.requests` | `{cpu: 100m, memory: 256Mi}` | |
| `api.resources.limits` | `{cpu: 1, memory: 1Gi}` | |
| `api.serviceAccountName` | `x1agent-api` | Bound to `cloud.gcp.workloadIdentityServiceAccount` via WI annotation. |
| `api.port` | `30001` | Container port. |
| `api.useJetstreamPublish` | `false` | Wave 1 of the JetStream migration — opt into durable wake publish via JetStream. |
| `api.useJetstreamConsume` | `false` | Wave 1 — inject `USE_JETSTREAM_CONSUME=true` into NEW session sidecars. Existing sessions stay on core until they terminate. |

## app Deployment

| Key | Default | Notes |
| --- | --- | --- |
| `app.replicas` | `1` | |
| `app.resources.requests` | `{cpu: 50m, memory: 128Mi}` | |
| `app.resources.limits` | `{cpu: 500m, memory: 512Mi}` | |
| `app.port` | `4322` | |

## Ingress

| Key | Default | Notes |
| --- | --- | --- |
| `ingress.className` | `traefik` | The chart's Ingress resources reference this class. The operator Helm-installs Traefik separately (one-time). |

## externalSecrets — GSM via External Secrets Operator

| Key | Default | Notes |
| --- | --- | --- |
| `externalSecrets.refreshInterval` | `5m` | How often ESO syncs from GSM. |
| `externalSecrets.clusterSecretStoreName` | `x1agent-gsm` | Created by the Terraform module's second-pass apply. |
| `externalSecrets.bindings` | (18 entries — see values.yaml) | List of `{envName, gsmSecretName}` pairs. The chart materializes these into a single `Secret/x1agent-secrets` that the api `envFrom`s. |

The default bindings cover JWT, internal token, Anthropic / OpenAI keys, Google
OAuth, GitHub App, Slack platform credentials, Sentry DSNs, and the workspace
secrets master key. See `deploy/helm/x1agent/values.yaml:165-225` for the full
set.

## config — non-secret env on api/app

| Key | Default | Notes |
| --- | --- | --- |
| `config.PLATFORM_NAME` | `x1agent` | Display name. |
| `config.PLATFORM_ADMIN_EMAILS` | `""` | Comma-separated. |
| `config.ALLOWED_DOMAINS` | `""` | Comma-separated allow list for SSO sign-in. |
| `config.GOOGLE_OAUTH_SCOPES` | `""` | Space-separated. Default is identity-only. |
| `config.ANTHROPIC_MODEL` | `""` | Override the Claude Code SDK model. Empty = let the SDK pick. |

## providers — capability gating

The api's `GET /api/capabilities` echoes these so the frontend can hide UI
for disabled domains.

| Key | Default | Notes |
| --- | --- | --- |
| `providers.graph` | `none` | Today's only kind: `surrealdb`. |
| `providers.vector` | `none` | Locked to `graph` in v1 — surrealdb implements both. |
| `providers.graphSurrealdb.image.{repository,tag,pullPolicy}` | (filled), `latest`, `Always` | |
| `providers.graphSurrealdb.replicas` | `1` | |
| `providers.graphSurrealdb.surrealImage` | `surrealdb/surrealdb:v2.3` | Backing datastore. |
| `providers.graphSurrealdb.storageSize` | `10Gi` | |
| `providers.graphSurrealdb.rootPassword` | `x1agent-surreal-root` | **Rotate via GSM + ESO before going live.** |

## monitoring.opentelemetry

| Key | Default | Notes |
| --- | --- | --- |
| `monitoring.opentelemetry.enabled` | `false` | Requires the OpenTelemetry Operator installed cluster-wide (see [Telemetry](/operations/telemetry)). |
| `monitoring.opentelemetry.image` | `otel/opentelemetry-collector-contrib:0.105.0` | |
| `monitoring.opentelemetry.serviceName` | `otel-collector` | |
| `monitoring.opentelemetry.grpcPort` | `4317` | |
| `monitoring.opentelemetry.httpPort` | `4318` | |
| `monitoring.opentelemetry.config` | (debug-exporter pipeline) | Inline collector config. Override to point at GCP Cloud Operations / Honeycomb / Datadog. |

## infra

v1 keeps Postgres + NATS in-cluster. Cloud SQL / managed NATS are deferred.

### Postgres

| Key | Default | Notes |
| --- | --- | --- |
| `infra.postgres.enabled` | `true` | Set false to point at an external DB (set `DATABASE_URL` via the install file). |
| `infra.postgres.image` | `postgres:16-alpine` | |
| `infra.postgres.storageSize` | `20Gi` | |
| `infra.postgres.storageClass` | `standard-rwo` | |

### NATS

| Key | Default | Notes |
| --- | --- | --- |
| `infra.nats.enabled` | `true` | |
| `infra.nats.image` | `nats:2.10-alpine` | |
| `infra.nats.replicas` | `1` | Bump to 3+ for multi-node node-failure tolerance. Chart switches to StatefulSet shape automatically when > 1. |
| `infra.nats.jetstream.enabled` | `true` | Required by the wake-reliability work in `rfcs/jetstream-migration.md`. |
| `infra.nats.jetstream.fileStorageSize` | `10Gi` | |
| `infra.nats.jetstream.maxFileStore` | `8Gi` | Per-stream limits in the bootstrap Job apply within this. |
| `infra.nats.jetstream.maxMemoryStore` | `256Mi` | |
| `infra.nats.streams.x1Session.enabled` | `true` | |
| `infra.nats.streams.x1Session.replicas` | `1` | Must be `<= infra.nats.replicas`. |
| `infra.nats.streams.x1Session.maxAge` | `24h` | Forensic flight-recorder retention. |
| `infra.nats.streams.x1Session.maxBytes` | `134217728` (128 MiB) | |
| `infra.nats.streams.x1Session.duplicateWindow` | `2m` | Dedup window for msg-id–based publish retries. |

## What lives outside Helm values

- **Secrets values.** The chart only declares which env vars come from which
  GSM secret name. Secret values are populated separately via `gcloud secrets
  versions add ...` (or from your CI). See [GCP install](/deployment/gcp).
- **DNS NS records.** Set at your domain registrar pointing at the Cloud DNS
  zone Terraform creates (`terraform output dns_nameservers`).
- **`OpenTelemetryCollector` CRD operator.** Installed cluster-wide once via
  `helm install opentelemetry-operator open-telemetry/opentelemetry-operator`.
  The chart's `OpenTelemetryCollector` CR will not apply without it.
- **External Secrets Operator.** Same — installed once cluster-wide before
  the second terraform apply creates the `ClusterSecretStore`.
