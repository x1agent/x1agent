---
title: Telemetry
description: OpenTelemetry traces + metrics from x1agent's services, plus the in-app token-usage dashboard
sidebar:
  order: 4
---

x1agent ships three telemetry surfaces, in increasing order of setup cost:

1. **Token usage dashboard** (in-app) — workspace × agent breakdown of LLM spend, captured per agent turn from the Anthropic SDK's `result` message. Always on; reads from the `token_usage` Postgres table.
2. **OpenTelemetry collector** (opt-in) — traces + metrics from api / providers (and app, when bootstrapped). Single in-cluster collector exports to wherever you point it.
3. **Cluster health** (GCP-native) — GKE Workloads / Observability tab, free for the first 50 GB/mo of logs.

This page covers (1) and (2). Cluster health needs no setup beyond a GKE cluster.

## Token-usage dashboard

After `mise run install:prod:apply`, every workspace gets a "Token usage — this month" card visible to admins on the workspace home page. It shows:

- Estimated cost in USD (input + output + cache, computed from a baked-in model price table)
- Total input / output tokens
- Cache read / write tokens
- Per-agent breakdown sorted by cost
- Per-model breakdown (so you see Sonnet vs Opus vs Haiku spend separately)

Costs use Anthropic's published prices for the major Claude 4.x models. Rates drift over time — treat the number as directional, not invoice-exact. The actual token counts ARE invoice-exact; they come straight from the SDK's `usage` object.

The underlying API is `GET /api/workspaces/:slug/token-usage?since=YYYY-MM-DD&until=YYYY-MM-DD`, admin-only. Default range is the current UTC month. Use it for custom dashboards or billing exports.

## OpenTelemetry

Off by default. Enable with two operator steps + one Helm value flip.

### One-time cluster setup

Install the OpenTelemetry Operator — this manages `OpenTelemetryCollector` CRs:

```
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace opentelemetry-operator-system --create-namespace \
  --set admissionWebhooks.certManager.enabled=true   # we already ship cert-manager via the chart
```

(Same one-time-per-cluster pattern as ESO.)

### Enable in your install

In your `values.<baseDomain>.yaml` (or via `--set`):

```yaml
monitoring:
  opentelemetry:
    enabled: true
```

Re-run `mise run install:prod:apply`. This:

- Creates an `OpenTelemetryCollector` resource in the install namespace
- Adds `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` env vars to api + app
- Each service's `initOtel()` (already in the boot path) picks up the endpoint and starts pushing

Out of the box, the collector ships traces + metrics + logs to its `debug` exporter (stdout in collector pod logs). Cheap, zero deps, but only useful for "is anything coming through?" checks.

### Pointing at a real backend

Override `monitoring.opentelemetry.config` in your values file. Examples:

**Google Cloud Trace + Monitoring + Logging:**

```yaml
monitoring:
  opentelemetry:
    enabled: true
    config: |
      receivers:
        otlp:
          protocols:
            grpc: { endpoint: 0.0.0.0:4317 }
            http: { endpoint: 0.0.0.0:4318 }
      processors:
        batch: { timeout: 5s, send_batch_size: 512 }
        resourcedetection:
          detectors: [gcp]
      exporters:
        googlecloud: {}
      service:
        pipelines:
          traces:  { receivers: [otlp], processors: [batch, resourcedetection], exporters: [googlecloud] }
          metrics: { receivers: [otlp], processors: [batch, resourcedetection], exporters: [googlecloud] }
          logs:    { receivers: [otlp], processors: [batch, resourcedetection], exporters: [googlecloud] }
```

The collector pod needs `roles/cloudtrace.agent`, `roles/monitoring.metricWriter`, and `roles/logging.logWriter` on its GSA. The Terraform module already grants the api/eso GSAs the relevant roles; add a third GSA for the collector when you turn this on.

**Honeycomb / Datadog / Tempo:** swap the exporter block. The receivers + processors stay the same.

### What's instrumented

| Service | Auto-instrumented | Manual spans/metrics |
|---|---|---|
| api | hono, undici, pg, nats (via auto-instrumentations-node) | `recordTokenUsageMetric()` per agent turn — fires `x1agent.tokens.{input,output,cache_create,cache_read}` and `x1agent.agent.turns` |
| provider-preview | nats, undici, k8s | none yet |
| provider-messaging-slack | nats | none yet |
| provider-graph-surrealdb | nats | none yet |
| provider-google-workspace | nats, undici | none yet |
| app | (not bootstrapped — env vars set, init follow-up) | n/a |

The chart only renders an `OpenTelemetryCollector` resource when `monitoring.opentelemetry.enabled=true`, and only sets `OTEL_EXPORTER_OTLP_ENDPOINT` env on the api + app + graph-surrealdb provider Deployments. If you enable preview / messaging-slack / google-workspace providers, verify those Deployment templates also project the OTel env (they may live under `deploy/helm/providers/` rather than the main chart — file a chart bug if not).

Disabled by default in auto-instrumentations: `fs` and `dns` (too noisy in production). Override via `OTEL_NODE_DISABLED_INSTRUMENTATIONS` env if you need them for a specific debug session.

### Conventions for new metrics

When you add custom metrics in code, follow:

- Names: `x1agent.<area>.<measurement>` (e.g. `x1agent.sessions.spawned`, `x1agent.previews.deployed`)
- Attributes: `workspace_id`, `agent_id`, `model`, `kind` — bounded sets
- Never put a free-form string in an attribute (URL paths, error messages, user input). Cardinality blows up the collector and the backend.

Use `getMeter()` from `@x1agent/observability` to get a Meter, then `createCounter` / `createHistogram` / `createUpDownCounter` as needed.

## Cluster health

GKE's built-in observability covers nodes, pods, containers, PVCs, and events. Find it at:

```
console.cloud.google.com → Kubernetes Engine → <cluster> → Observability
```

For workload-level dashboards (api request rate, error %, p95 latency), use the OTel pipeline above with the GCP exporter — Cloud Monitoring auto-creates dashboards from the Service Monitoring API once metrics start flowing.

When you outgrow GCP-native (10+ K8s clusters, multi-cloud), the standard upgrade is `kube-prometheus-stack` for K8s metrics and Loki/Grafana for log search. That swap is a separate Helm install; the chart's `monitoring` section is structured so this slot in cleanly later.
