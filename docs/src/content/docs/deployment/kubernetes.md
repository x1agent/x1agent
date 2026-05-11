---
title: Kubernetes deployment
description: Taking x1agent to a real cluster
sidebar:
  order: 1
---

This page covers a production deployment of x1agent on any conformant Kubernetes cluster. For a single-machine development setup, see the [quickstart](/getting-started/quickstart) instead — the production topology shares code with local dev, but the secrets story and the scaling story differ.

:::note
The recommended path is the [Helm chart](#helm-chart) at
`deploy/helm/x1agent/`. v1 targets GCP only — see
[GCP install](/deployment/gcp). Multi-cloud support is on the roadmap.
The raw manifests under `deploy/k8s/dev/` are for local OrbStack only.
:::

## Prerequisites

- **GKE** standard cluster (1.28+). EKS / AKS / on-prem are not supported in v1.
- **ingress-nginx** as the ingress controller (the chart's Ingress resources reference `ingressClassName: nginx` by default — see `ingress.className` in [helm-values](/configuration/helm-values)).
- **cert-manager** for TLS — the chart provisions Let's Encrypt `ClusterIssuer`s using the DNS-01 challenge against Cloud DNS.
- **External Secrets Operator** — the chart's secret bindings rely on a `ClusterSecretStore` named `x1agent-gsm` (created by the Terraform module's second-pass apply).
- **Postgres** — in-cluster by default (`infra.postgres.enabled: true`).
- **NATS** — in-cluster by default with mTLS always on (`infra.nats.enabled: true`).

## Install the External Secrets Operator

One operator, cluster-wide, installed once.

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace \
  --set installCRDs=true
```

ESO runs as a single Deployment in the `external-secrets` namespace. It ships with providers for Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, 1Password, Doppler, Akeyless, Bitwarden, Infisical, and about twenty others — all compiled in, no per-backend installation. You pick which ones to activate by creating `ClusterSecretStore` objects pointing at each.

## Secrets model

x1agent has two separate secret stores:

1. **Deployment-wide secrets** (Anthropic key, JWT signing key, OAuth client
   secrets, GitHub App key, Slack platform credentials, Sentry DSNs, the
   workspace-secrets master encryption key) live in **Google Secret Manager**.
   The chart's `externalSecrets.bindings` list maps each env var to its GSM
   secret name; ESO syncs them into a single in-cluster
   `Secret/x1agent-secrets` that the api `envFrom`s. Terraform creates the
   GSM secret resources empty; you populate values via `gcloud secrets
   versions add`.

2. **Per-workspace secrets** (Anthropic API keys per workspace, third-party
   tool tokens, etc.) live in the `workspace_secrets` Postgres table,
   AES-256-GCM-encrypted with the master key from (1). They never leave the
   api process or the per-session pod that needs them.

There is no Vault / AWS-Secrets-Manager / Azure-Key-Vault adapter in v1.

## Helm chart

```bash
# v1: install from a monorepo checkout. An OCI chart (oci://ghcr.io/x1agent/charts/x1agent) is on the roadmap.
helm upgrade --install x1agent ./deploy/helm/x1agent \
  -n x1agent --create-namespace \
  -f values.yaml
```

See the [Helm values reference](/configuration/helm-values) for every supported
key. In practice, operators set ~6 values on top of the chart's defaults:
`baseDomain`, `cloud.gcp.{projectId,region,workloadIdentityServiceAccount,
sessionWorkloadIdentityServiceAccount,artifactRegistry}`, `tls.email`,
`config.{PLATFORM_ADMIN_EMAILS,ALLOWED_DOMAINS}`. Terraform fills the GSA
values for you; the install configurator (`mise run configure:prod`) prompts
for the rest.

Every field that takes a secret value references a Kubernetes Secret name, not the value itself. The chart does not template plaintext into rendered manifests.

## Workspaces and isolation

v1 runs every workspace's session pods, image builds, and shared resources in the single install namespace (`K8S_NAMESPACE`, default `x1agent`). Workspace isolation is enforced at the application layer (every query scopes by `workspace_id`) and by per-pod NetworkPolicy. Per-workspace k8s namespaces are a planned hardening step, not a v1 feature.

Agent pods run in the workspace namespace. They cannot read Secrets from any other namespace — the namespace boundary is enforced by kubelet, not by application-level policy. See [Secrets management / Scoping](/security/secrets#scoping) for the full list of defenses.

## Scaling

**api** — stateless, multiple replicas safe. Default chart ships 1; scale via `api.replicas`. Read/write traffic is Postgres-bound, so horizontal scaling past ~5 replicas rarely wins without sharding the database.

**app** — stateless, multiple replicas safe.

**NATS** — single node is adequate for small deployments. For HA, deploy NATS JetStream with 3-node clustering (out of the chart's default scope; see NATS docs).

**Session pods** — spawned on demand per session. Fan out naturally with cluster capacity. Cluster autoscaling (Karpenter on AWS, Cluster Autoscaler on GKE/AKS) picks up the slack.

**Postgres** — the usual read-replica / connection-pooling pattern. x1agent doesn't need write clustering for the foreseeable load profile.

## Observability

x1agent emits structured logs on stdout. Standard K8s log aggregation (Loki, Cloud Logging, Datadog, etc.) picks them up without configuration. Notable log namespaces: `[nats]`, `[scheduler]`, `[grants]`, `[jobs]`, `[seed]`, `[shares]`, `[audit]`.

Metrics + traces are exposed via OpenTelemetry push (no Prometheus pull
endpoint in v1). Enable with `monitoring.opentelemetry.enabled: true` —
see [Telemetry](/operations/telemetry).

## Backup and disaster recovery

**State to back up:**
- Postgres (workspaces, agents, sessions, session events, memberships, grants, audit events). Standard `pg_dump` or managed-DB backups.
- K8s Secrets in `x1agent-secrets` (Tier 1 only). Include in etcd backups or export via Velero.
- If Tier 2/3: the backend is the system of record. Its own backup story applies.

**State that is derivable / ephemeral:**
- Materialized Secrets in workspace namespaces (ESO will re-materialize on the next sync).
- Session pod state (sessions are recreated by the job-watcher; in-flight sessions are lost on restore).
- The `x1agent-registry` in-cluster image cache (rebuild from source).

**Recovery:**
- Restore Postgres to its most recent backup.
- If Tier 1: restore `x1agent-secrets` namespace.
- If Tier 2/3: no secret restore needed; ESO will re-resolve on its next sync.
- Cycle all api pods so they re-read state.

## Upgrading

x1agent follows SemVer on the chart. Minor releases are backward-compatible migrations applied automatically on api start. Major releases require a documented manual migration step (published per release).

```bash
helm upgrade x1agent x1agent/x1agent -n x1agent -f values.yaml
```

Schema migrations run as a `post-install,post-upgrade` Helm hook
(`templates/migrate-job.yaml`). The api boot itself does not run
migrations — see [Deploying updates](/operations/deploy) for the
ordering implications and rollback rules.

## What this page intentionally does not cover

- Multi-cluster federation — not supported.
- Air-gapped installs — supported in principle (the chart takes image overrides for every container), but the full air-gapped checklist is out of scope for this page.
- Migration from hostPath Claude credentials to workspace-secret-backed Anthropic keys — a one-time operation; see the [quickstart's CLI](/getting-started/quickstart).

## Related reading

- [Quickstart](/getting-started/quickstart) — the single-machine version of everything above.
- [Secrets management](/security/secrets) — the full model the Secrets backend section is a deployment cut of.
- [Security model](/security/overview) — trust boundaries and permission invariants.
- [Helm values reference](/configuration/helm-values) — exhaustive chart values.
