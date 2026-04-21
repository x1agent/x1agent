---
title: Kubernetes deployment
description: Taking x1agent to a real cluster
sidebar:
  order: 1
---

This page covers a production deployment of x1agent on any conformant Kubernetes cluster. For a single-machine development setup, see the [quickstart](/getting-started/quickstart) instead — the production topology shares code with local dev, but the secrets story and the scaling story differ.

:::note
The recommended path is a [Helm chart](#helm-chart). Raw manifests exist in the repo under `deploy/k8s/` for reference, but the chart is how the project is packaged for operators.
:::

## Prerequisites

- Kubernetes **1.28+**. Tested against GKE, EKS, and generic on-prem clusters.
- An ingress controller and a TLS certificate mechanism (cert-manager is the common pairing). x1agent ships without an opinion here — any ingress that speaks standard K8s `Ingress` resources works.
- **etcd encryption-at-rest** enabled via the cluster's `EncryptionConfiguration`. Managed K8s (GKE, EKS, AKS) offers this as a single switch backed by cloud KMS; self-managed clusters configure it on the api server. This is load-bearing when using the [K8s-backed secrets path](#secrets-backend).
- **External Secrets Operator** (see below). Install it regardless of whether you plan to use an external backend — the same CRD shape is used in both tiers, so ESO being present is always required.
- A **Postgres** instance, either in-cluster (the default chart deploys one) or external (point the chart at your managed database).
- **NATS** with TLS client-cert verification enabled. The chart deploys NATS by default; see [NATS mTLS](/configuration/nats-mtls) for certificate provisioning.

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

## Secrets backend

x1agent's secrets path writes an `ExternalSecret` CRD per secret; ESO resolves it against a named `ClusterSecretStore`. Pick one of the three tiers below.

### Tier 1 — K8s-backed (no external dependency)

The same model the quickstart uses. Suitable for small teams or clusters with no existing secrets infrastructure. Secrets are stored as plain `Secret` objects in the privileged `x1agent-secrets` namespace and materialized into each workspace namespace by ESO's `kubernetes` provider.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: x1-local
spec:
  provider:
    kubernetes:
      remoteNamespace: x1agent-secrets
      server:
        caProvider:
          type: ConfigMap
          name: kube-root-ca.crt
          namespace: external-secrets
          key: ca.crt
      auth:
        serviceAccount:
          name: eso-reader
          namespace: external-secrets
```

Requires etcd encryption-at-rest to be meaningful — without it, your Secrets are recoverable from etcd backups.

**Chart values:**
```yaml
secrets:
  storeRef: x1-local
  uiMode: capture       # users type values into x1agent's UI
```

### Tier 2 — HashiCorp Vault

Values live in Vault. The operator manages them; x1agent's UI is a binder, not an input surface.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: x1-vault
spec:
  provider:
    vault:
      server: https://vault.example.com
      path: secret
      version: v2
      auth:
        kubernetes:
          mountPath: kubernetes
          role: x1agent
          serviceAccountRef:
            name: x1agent-api
            namespace: x1agent
```

**Chart values:**
```yaml
secrets:
  storeRef: x1-vault
  uiMode: bind          # users enter Vault paths instead of values
```

With `uiMode: bind`, the web UI's secret-entry forms display "Path in Vault" instead of "Value". x1agent's api never sees plaintext.

### Tier 3 — Cloud provider (AWS / GCP / Azure)

Equivalent to Vault in shape. Example with AWS Secrets Manager + IAM Roles for Service Accounts (IRSA):

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: x1-aws
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: x1agent-api
            namespace: x1agent
```

The service account needs an IAM role via IRSA (EKS) or Workload Identity (GKE) with `secretsmanager:GetSecretValue` scoped to `arn:aws:secretsmanager:*:*:secret:x1agent/*`. GCP Secret Manager and Azure Key Vault follow the same pattern with the corresponding authentication method.

**Chart values** are identical to the Vault case — `storeRef: x1-aws` and `uiMode: bind`.

### Upgrading between tiers

Moving from Tier 1 → Tier 2/3 is a cluster config change, not an x1agent change.

1. Install the backend (or configure access to the existing one).
2. Apply the new `ClusterSecretStore`.
3. Update each workspace's `ExternalSecret` objects to reference the new store (`kubectl patch`, or a one-time migration script).
4. Set `secrets.uiMode: bind` in the chart values and upgrade.

x1agent's Deployment, Postgres schema, workspace definitions, and agent definitions don't change. What moves: the **values** are either re-entered in the new backend or exported from `x1agent-secrets` via a one-shot `PushSecret`. x1agent doesn't automate the value migration — it's an operator task performed once per workspace.

## Helm chart

```bash
helm repo add x1agent https://charts.x1agent.dev
helm install x1agent x1agent/x1agent \
  -n x1agent --create-namespace \
  -f values.yaml
```

A minimum `values.yaml` for a Tier 1 install:

```yaml
ingress:
  host: x1agent.example.com
  tlsSecretName: x1agent-tls      # cert-manager usually provides this

postgres:
  mode: in-cluster                # or: external, with dsnSecret ref

nats:
  mtls: true                      # ships mTLS CA + client certs

auth:
  google:
    clientIdSecret: x1-google-client-id
    clientSecretSecret: x1-google-client-secret
  password:
    enabled: true                 # local email+password, alongside SSO
  allowedDomains:
    - example.com

secrets:
  storeRef: x1-local
  uiMode: capture
```

Every field that takes a secret value references a Kubernetes Secret name, not the value itself. The chart does not template plaintext into rendered manifests.

## Workspaces and isolation

Each workspace gets its own Kubernetes namespace (`x1agent-ws-{id}`). The chart provisions namespaces on demand from the api; no manual operator intervention is required per workspace.

Agent pods run in the workspace namespace. They cannot read Secrets from any other namespace — the namespace boundary is enforced by kubelet, not by application-level policy. See [Secrets management / Scoping](/security/secrets#scoping) for the full list of defenses.

## Scaling

**api** — stateless, multiple replicas safe. Default chart ships 1; scale via `api.replicas`. Read/write traffic is Postgres-bound, so horizontal scaling past ~5 replicas rarely wins without sharding the database.

**app** — stateless, multiple replicas safe.

**NATS** — single node is adequate for small deployments. For HA, deploy NATS JetStream with 3-node clustering (out of the chart's default scope; see NATS docs).

**Session pods** — spawned on demand per session. Fan out naturally with cluster capacity. Cluster autoscaling (Karpenter on AWS, Cluster Autoscaler on GKE/AKS) picks up the slack.

**Postgres** — the usual read-replica / connection-pooling pattern. x1agent doesn't need write clustering for the foreseeable load profile.

## Observability

x1agent emits structured logs on stdout. Standard K8s log aggregation (Loki, Cloud Logging, Datadog, etc.) picks them up without configuration. Notable log namespaces: `[nats]`, `[scheduler]`, `[grants]`, `[jobs]`, `[seed]`, `[shares]`, `[audit]`.

Metrics are exposed on `/metrics` (Prometheus format) on the api pod. The chart ships a `ServiceMonitor` when Prometheus Operator is detected.

Tracing is not enabled by default. When observability integration matters, the api respects standard OTLP env vars — set `OTEL_EXPORTER_OTLP_ENDPOINT` and traces propagate through NATS into provider deployments.

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

The api performs schema migrations on boot and will refuse to start against a DB with a newer schema than the running version, to prevent silent downgrades.

## What this page intentionally does not cover

- Multi-cluster federation — not supported.
- Air-gapped installs — supported in principle (the chart takes image overrides for every container), but the full air-gapped checklist is out of scope for this page.
- Migration from hostPath Claude credentials to workspace-secret-backed Anthropic keys — a one-time operation; see the [quickstart's CLI](/getting-started/quickstart).

## Related reading

- [Quickstart](/getting-started/quickstart) — the single-machine version of everything above.
- [Secrets management](/security/secrets) — the full model the Secrets backend section is a deployment cut of.
- [Security model](/security/overview) — trust boundaries and permission invariants.
- [Helm values reference](/configuration/helm-values) — exhaustive chart values.
