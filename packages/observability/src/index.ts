/**
 * Shared OpenTelemetry bootstrap for x1agent services (api, app,
 * providers). Each service calls `initOtel({ serviceName })` once at
 * boot, before any other imports that auto-instrument (express, http,
 * pg, undici, etc.).
 *
 * Configuration is purely env-driven so the same image works across
 * dev / staging / prod without code changes:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT  — collector endpoint, e.g.
 *                                  http://otel-collector.x1agent:4317
 *                                  When unset, init() is a no-op and
 *                                  the service runs with zero overhead.
 *   OTEL_SERVICE_NAME            — overrides the default passed to init()
 *   OTEL_RESOURCE_ATTRIBUTES     — extra resource attributes,
 *                                  e.g. deployment.environment=prod
 *   OTEL_LOG_LEVEL               — debug|info|warn|error (default warn)
 *
 * Why a shared package: the auto-instrumentation list is long and
 * needs to match across services so traces stitch together. One copy,
 * one upgrade path.
 */

import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

export interface InitOtelOptions {
  /** Default service name; OTEL_SERVICE_NAME env wins if set. */
  serviceName: string;
  /**
   * Service version. Defaults to process.env.SERVICE_VERSION or "0.0.0".
   * Bumped per release; ingested as service.version on every span/metric.
   */
  serviceVersion?: string;
  /**
   * Extra resource attributes — merged into the default set. Use sparingly;
   * prefer OTEL_RESOURCE_ATTRIBUTES env so they're configurable per
   * deployment without code changes.
   */
  resourceAttributes?: Record<string, string>;
  /**
   * Disable auto-instrumentations (test environments, debug). When false,
   * SDK starts with NO auto-instrumentations and only manual spans/metrics
   * land in the collector.
   */
  enableAutoInstrumentation?: boolean;
}

let sdk: NodeSDK | null = null;
let started = false;

export function initOtel(opts: InitOtelOptions): void {
  if (started) return; // idempotent — multiple calls are no-ops
  started = true;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) {
    // No-op when no collector endpoint is configured. Services run with
    // zero overhead in environments that haven't opted into telemetry.
    return;
  }

  const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || opts.serviceName;
  const serviceVersion =
    opts.serviceVersion ?? process.env.SERVICE_VERSION ?? "0.0.0";

  // Resource = identity attached to every span + metric. Defaults cover
  // the SDK-native fields; user can layer more via OTEL_RESOURCE_ATTRIBUTES.
  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
    [SemanticResourceAttributes.SERVICE_NAMESPACE]: "x1agent",
    ...(opts.resourceAttributes ?? {}),
  });

  const traceExporter = new OTLPTraceExporter({ url: endpoint });
  const metricExporter = new OTLPMetricExporter({ url: endpoint });

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      // Default 60s; small enough for live dashboards, large enough that
      // a busy api doesn't burn egress on metric pushes.
      exportIntervalMillis: Number(
        process.env.OTEL_METRIC_EXPORT_INTERVAL_MS ?? 60_000,
      ),
    }),
    instrumentations:
      opts.enableAutoInstrumentation !== false
        ? [
            getNodeAutoInstrumentations({
              // The fs instrumentation is too noisy in production —
              // every file read becomes a span. Disable by default;
              // an operator chasing an fs perf bug can re-enable via
              // OTEL_NODE_DISABLED_INSTRUMENTATIONS env.
              "@opentelemetry/instrumentation-fs": { enabled: false },
              // dns spans are noisy too; rarely useful for application work.
              "@opentelemetry/instrumentation-dns": { enabled: false },
            }),
          ]
        : [],
  });

  sdk.start();

  // Graceful shutdown so the SDK has a chance to flush its export
  // buffer before the process exits. Both signals matter — SIGTERM is
  // K8s preStop, SIGINT is Ctrl-C in dev.
  const shutdown = async (signal: string) => {
    try {
      await sdk?.shutdown();
    } catch (err) {
      // Logging via console.error so we don't depend on otel during
      // its own shutdown.
      console.error(
        `[otel] shutdown failed on ${signal}: ${(err as Error).message}`,
      );
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/**
 * Get a tracer scoped to the calling component. Safe to call before
 * `initOtel` — the API uses a no-op tracer until the SDK starts.
 */
export function getTracer(componentName: string, version?: string): Tracer {
  return trace.getTracer(componentName, version);
}

/**
 * Get a meter for emitting custom metrics. Safe to call before
 * `initOtel` — the API uses a no-op meter until the SDK starts.
 *
 * Conventions:
 *   - metric names: x1agent.<area>.<measurement>
 *     e.g. x1agent.tokens.input, x1agent.sessions.spawned
 *   - attributes: workspace_id, agent_id, model, kind
 *   - keep cardinality bounded — never put a free-form string in a
 *     metric attribute.
 */
export function getMeter(componentName: string, version?: string): Meter {
  return metrics.getMeter(componentName, version);
}

// ── Domain metric helpers ──────────────────────────────────────────
//
// Per the convention above, metric names are x1agent.<area>.<measurement>.
// Attribute cardinality stays bounded by enumerating: model is a small
// closed set; workspace_id + agent_id are UUIDs but bounded per install.
// If an install hits 10k+ workspaces these counters will blow up the
// collector — switch to histograms or roll up server-side at that
// scale.

const tokenMeter = getMeter("x1agent.tokens", "0.0.1");
const tokensInput = tokenMeter.createCounter("x1agent.tokens.input", {
  description: "LLM input tokens consumed per agent turn.",
  unit: "{token}",
});
const tokensOutput = tokenMeter.createCounter("x1agent.tokens.output", {
  description: "LLM output tokens generated per agent turn.",
  unit: "{token}",
});
const tokensCacheCreate = tokenMeter.createCounter(
  "x1agent.tokens.cache_create",
  {
    description: "LLM cache-creation input tokens (billed at input rate).",
    unit: "{token}",
  },
);
const tokensCacheRead = tokenMeter.createCounter(
  "x1agent.tokens.cache_read",
  {
    description: "LLM cache-read input tokens (billed at 10% of input).",
    unit: "{token}",
  },
);
const turnsCounter = tokenMeter.createCounter("x1agent.agent.turns", {
  description: "Agent SDK turns (one per result message).",
  unit: "{turn}",
});

export interface TokenUsageMetricInput {
  workspaceId: string;
  agentId: string | null;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * Bridge from the existing Postgres write path to OTel. Called from
 * the api's NATS subscriber alongside `tokenUsage.record()`. Cheap when
 * the OTel SDK is not initialized (no-op meter), so it's always-on.
 */
export function recordTokenUsageMetric(input: TokenUsageMetricInput): void {
  const attrs = {
    workspace_id: input.workspaceId,
    agent_id: input.agentId ?? "unknown",
    session_id: input.sessionId,
    model: input.model,
  };
  tokensInput.add(input.inputTokens, attrs);
  tokensOutput.add(input.outputTokens, attrs);
  tokensCacheCreate.add(input.cacheCreationInputTokens, attrs);
  tokensCacheRead.add(input.cacheReadInputTokens, attrs);
  turnsCounter.add(1, attrs);
}
