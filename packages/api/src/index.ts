// Sentry FIRST — the SDK auto-instruments http/pg/etc., which means
// it has to load before the modules it patches. instrument.ts no-ops
// when SENTRY_DSN_API is unset.
import "./instrument.js";
import * as Sentry from "@sentry/node";

// initOtel must run BEFORE any auto-instrumented imports (hono / nats /
// pg-driver / undici) so their patches land. The package no-ops cleanly
// when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
import { initOtel } from "@x1agent/observability";
initOtel({ serviceName: "x1agent-api" });

import { Hono } from "hono";
import * as k8s from "@kubernetes/client-node";
import { compose } from "./composition/index.js";
import { getSql } from "./db/client.js";
import { seedIfDev, seedPlatformPresets } from "./seed.js";
import { startSessionEventSubscriber } from "./nats/subscriber.js";
import { startSessionAuditSubscriber } from "./nats/audit-subscriber.js";
import {
  AnthropicSessionSummarizer,
  OpenAISessionSummarizer,
  StubSessionSummarizer,
  DEFAULT_SUMMARY_CONFIG,
  type SessionSummarizer,
  type MaybeUpdateSessionSummaryConfig,
} from "@x1agent/domain-sessions";
import { startImageBuilder } from "./image-catalog/builder.js";
import { capabilitiesRoutes } from "./capabilities/routes.js";
import { listAnthropicModels } from "./capabilities/anthropic-models.js";

/**
 * Resolve the deployment-wide default model id for new session pods.
 * Explicit ANTHROPIC_MODEL env wins; otherwise pick the first Sonnet
 * from the upstream catalog. Catalog fetch is cached for 5 min so
 * boot adds at most one Vertex / Anthropic round-trip per restart.
 * Returns undefined when nothing is available (let the SDK pick).
 */
/**
 * Build the SessionSummarizer for this process.
 *
 * Selection order:
 *   1. ANTHROPIC_API_KEY (when ANTHROPIC_PROVIDER is unset or "api_key").
 *   2. OPENAI_API_KEY — fallback so an install with an OpenAI key (e.g.
 *      the one already used for collection embeddings) can light up
 *      summaries without also acquiring an Anthropic key.
 *   3. Stub — no creds available; session.summary stays NULL and the UI
 *      falls back to the id hash.
 *
 * Vertex routing for the Anthropic side is still on the X1A-7 follow-up
 * list; until that ships, a Vertex-only install can opt into OpenAI by
 * setting OPENAI_API_KEY.
 */
function buildSessionSummarizer(): SessionSummarizer {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicProvider = process.env.ANTHROPIC_PROVIDER ?? "api_key";
  if (
    anthropicProvider === "api_key" &&
    anthropicKey &&
    anthropicKey.trim()
  ) {
    const model =
      process.env.ANTHROPIC_SUMMARY_MODEL?.trim() || undefined;
    console.log("[summarizer] using anthropic api-key path");
    return new AnthropicSessionSummarizer({ apiKey: anthropicKey, model });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && openaiKey.trim()) {
    const model = process.env.OPENAI_SUMMARY_MODEL?.trim() || undefined;
    console.log("[summarizer] using openai api-key path");
    return new OpenAISessionSummarizer({ apiKey: openaiKey, model });
  }

  console.log(
    "[summarizer] no anthropic or openai api key — session summaries disabled",
  );
  return new StubSessionSummarizer();
}

/**
 * Read summary cooldown overrides from env. Both knobs are optional;
 * unset → DEFAULT_SUMMARY_CONFIG. Operators tune these to control
 * token spend on chatty workspaces without a code change.
 */
function readSummaryConfigFromEnv(): MaybeUpdateSessionSummaryConfig {
  const eventsRaw = Number(process.env.SESSION_SUMMARY_EVENTS_THRESHOLD);
  const intervalRaw = Number(process.env.SESSION_SUMMARY_INTERVAL_MS);
  const windowRaw = Number(process.env.SESSION_SUMMARY_WINDOW_SIZE);
  return {
    eventsThreshold:
      Number.isFinite(eventsRaw) && eventsRaw > 0
        ? eventsRaw
        : DEFAULT_SUMMARY_CONFIG.eventsThreshold,
    intervalMs:
      Number.isFinite(intervalRaw) && intervalRaw > 0
        ? intervalRaw
        : DEFAULT_SUMMARY_CONFIG.intervalMs,
    windowSize:
      Number.isFinite(windowRaw) && windowRaw > 0
        ? windowRaw
        : DEFAULT_SUMMARY_CONFIG.windowSize,
  };
}

async function resolveDefaultAnthropicModel(): Promise<string | undefined> {
  const explicit = process.env.ANTHROPIC_MODEL;
  if (explicit && explicit.trim()) return explicit.trim();
  try {
    const models = await listAnthropicModels();
    // Skip @default preview aliases — Vertex lists them in the catalog
    // but they often 400 with "not servable in region" until promoted
    // to GA. Prefer a dated (GA) version.
    const ga = models.filter((m) => !m.id.endsWith("@default"));
    const sonnet = ga.find((m) => m.id.toLowerCase().includes("sonnet"));
    return sonnet?.id ?? ga[0]?.id ?? models[0]?.id;
  } catch (err) {
    console.warn(
      `[anthropic-models] default resolve failed at boot: ${(err as Error).message}`,
    );
    return undefined;
  }
}
import { startJobWatcher } from "./k8s/job-watcher.js";
import { reapStaleBranches } from "./shared-agent-resources/reap-branches.js";
import { reconcileSharedResourceStatuses } from "./shared-agent-resources/reconcile-status.js";
import { createPeriodicScheduler } from "./orchestration/periodic-scheduler.js";
import { buildHostAllowlist } from "./security/host-allowlist.js";

/**
 * Hot-reload cleanup registry. `bun --hot` re-evaluates this module
 * on every file change but does NOT tear down side effects from the
 * previous evaluation — timers keep ticking, NATS subscriptions keep
 * draining, the job watcher keeps polling. Over a dev session that
 * stacks: 5 ticks registered becomes 10 then 20, each one grabbing a
 * connection and eventually exhausting Postgres max_connections.
 *
 * We pin the registry on globalThis (survives the module re-eval)
 * and, on each module load, first drain every cleanup recorded by
 * the previous generation. Subsequent `registerCleanup` calls record
 * the new generation's handles. A proper SIGTERM also walks the
 * registry on shutdown.
 */
type Cleanup = () => void | Promise<void>;
const g = globalThis as { __x1agentCleanups?: Cleanup[] };
if (g.__x1agentCleanups) {
  for (const fn of g.__x1agentCleanups) {
    try {
      await fn();
    } catch (err) {
      console.warn(
        "[hot-reload] cleanup failed:",
        (err as Error).message,
      );
    }
  }
}
g.__x1agentCleanups = [];
const registerCleanup = (fn: Cleanup) => {
  g.__x1agentCleanups!.push(fn);
};
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    void (async () => {
      for (const fn of g.__x1agentCleanups ?? []) {
        try {
          await fn();
        } catch {
          // best-effort on shutdown
        }
      }
      process.exit(0);
    })();
  });
}

// One scheduler per process. Owns every in-process periodic tick.
// Tasks register before start(); start() fires runOnStart kicks and
// schedules the recurring timers. registerCleanup wires stop() into
// SIGTERM + hot-reload teardown.
const scheduler = createPeriodicScheduler();
registerCleanup(() => scheduler.stop());

const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:4321";
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || "http://localhost:30001";
const PORT = Number(process.env.API_PORT || 30001);

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET env var is required");
}

// NATS connection for the provider gateway — separate from the one
// startSessionEventSubscriber opens so the two paths don't block each
// other on reconnect. Dev stack's NATS is reachable at nats://nats:4222;
// when absent, compose falls back to a "provider_unavailable" stub.
const providerNatsUrl = process.env.NATS_URL || "";
let providerNats: import("nats").NatsConnection | undefined;
if (providerNatsUrl && process.env.NATS_DISABLED !== "true") {
  try {
    providerNats = await (await import("./composition/nats-provider-gateway.js"))
      .connectNats(providerNatsUrl);
    console.log(`[providers] NATS for provider gateway: ${providerNatsUrl}`);
  } catch (err) {
    console.warn(
      `[providers] NATS gateway connect failed: ${(err as Error).message}`,
    );
  }
}

// Kubernetes config is optional — when the process is not running in a
// cluster, composition falls back to "Postgres installer not available"
// (install returns 501; listing still works).
let sharedKubeConfig: k8s.KubeConfig | undefined;
try {
  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();
  sharedKubeConfig = kc;
} catch {
  // Not in a cluster; leave undefined. Dev without devspace still boots.
}

const {
  authRoutes,
  meRoutes,
  workspaceInvitationRoutes,
  workspaceCreateRoutes,
  publicInvitationRoutes,
  agentRoutes,
  sessionRoutes,
  workspaceSessionRoutes,
  workspaceTokenUsageRoutes,
  workspaceCostRoutes,
  workspaceShareRoutes,
  workspaceSharesIndexRoutes,
  sessionShareRoutes,
  internalRoutes,
  githubInstallRoutes,
  installationApiRoutes,
  agentRepoRoutes,
  slackOAuthRoutes,
  slackBotApiRoutes,
  slackEventsRoutes,
  workspaceGrantRoutes,
  workspaceSecretsRoutes,
  mcpCatalogRoutes,
  agentMcpAttachmentRoutes,
  agentEnvRoutes,
  mcpOAuthRoutes,
  mcpUserTokenRoutes,
  collectionRoutes,
  agentCollectionRoutes,
  sharedAgentResourcesRoutes,
  workspaceImageCatalogRoutes,
  workspaceMembersRoutes,
  adminAnthropicModelsRoutes,
  adminWorkspacesRoutes,
  sharedResources: composedSharedResources,
  postgresBranches: composedPostgresBranches,
  postgresMinter: composedPostgresMinter,
  postgresProvisioner: composedPostgresProvisioner,
  redisBranches: composedRedisBranches,
  redisMinter: composedRedisMinter,
  redisProvisioner: composedRedisProvisioner,
  collections: composedCollections,
  permissionGrants,
  sessionEvents,
  tokenUsage: composedTokenUsage,
  sql: composedSql,
  agents: composedAgents,
  sessions: composedSessions,
  agentRepoStore: composedAgentRepos,
  agentEnvBindings: composedAgentEnvBindings,
  workspaceSecrets: composedWorkspaceSecrets,
  mcpAttachments: composedMcpAttachments,
  mcpCatalog: composedMcpCatalog,
  userTokenService: composedUserTokenService,
  users: composedUsers,
  tickScheduler,
  quietHints: composedQuietHints,
} = compose({
  sql: getSql(),
  jwtSecret: process.env.JWT_SECRET,
  googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
  // GOOGLE_OAUTH_SCOPES is a space-separated scope list that overrides
  // the identity-only default. Set in the install file when provider
  // domains (Drive, Calendar, Gmail) are enabled so the consent screen
  // prompts up-front rather than after-the-fact.
  googleScopes: process.env.GOOGLE_OAUTH_SCOPES
    ? process.env.GOOGLE_OAUTH_SCOPES.split(/\s+/).filter(Boolean)
    : undefined,
  appUrl: PUBLIC_URL,
  apiUrl: API_PUBLIC_URL,
  allowedDomains: (process.env.ALLOWED_DOMAINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  platformAdmins: (process.env.PLATFORM_ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  authBypass: process.env.AUTH_BYPASS === "true",
  testUserEmail: process.env.TEST_USER || "",
  platformName: process.env.PLATFORM_NAME || "x1agent",
  cookieSecure: process.env.NODE_ENV === "production",
  githubAppId: process.env.GITHUB_APP_ID || "",
  githubAppSlug: process.env.GITHUB_APP_SLUG || "",
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY || "",
  slackPlatformClientId: process.env.SLACK_PLATFORM_CLIENT_ID,
  slackPlatformClientSecret: process.env.SLACK_PLATFORM_CLIENT_SECRET,
  slackPlatformSigningSecret: process.env.SLACK_PLATFORM_SIGNING_SECRET,
  internalToken: process.env.API_INTERNAL_TOKEN || "",
  workspaceSecretsMasterKey: process.env.WORKSPACE_SECRETS_MASTER_KEY,
  natsConnection: providerNats,
  kubeConfig: sharedKubeConfig,
  sharedResourcesNamespace: process.env.K8S_NAMESPACE || "x1agent",
});

const app = new Hono();

// Host header allowlist — defense in depth against DNS rebinding.
// See security/host-allowlist.ts for the rationale + behavior.
const hostAllowlist = buildHostAllowlist({
  urls: [PUBLIC_URL, API_PUBLIC_URL],
  baseDomain: process.env.BASE_DOMAIN?.trim(),
  disabled: process.env.HOST_HEADER_CHECK === "disabled",
});

app.use("*", async (c, next) => {
  if (!hostAllowlist.isAllowed(c.req.header("Host"))) {
    return c.json({ error: "host_not_allowed" }, 421);
  }
  await next();
});

console.log(
  `[security] Host allowlist: ${
    hostAllowlist.hosts.length === 0
      ? "disabled"
      : hostAllowlist.hosts.join(",")
  }${process.env.BASE_DOMAIN ? ` (+ *.${process.env.BASE_DOMAIN})` : ""}`,
);

// Sentry sees every unhandled error before Hono's default 500 page
// reaches the client. Reraises so any per-route .onError still fires
// downstream and the response shape stays the same as before.
app.onError((err, c) => {
  Sentry.captureException(err);
  console.error(`[hono] unhandled: ${(err as Error).message}`);
  return c.json({ error: "internal_server_error" }, 500);
});

app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", PUBLIC_URL);
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  c.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));
app.route("/api/capabilities", capabilitiesRoutes({ sql: getSql() }));
app.route("/api/admin/anthropic/models", adminAnthropicModelsRoutes);
app.route("/api/admin/workspaces", adminWorkspacesRoutes);

// Sentry verify route — throws so the SDK captures the first event
// during the onboarding flow. Gated to non-production OR by token so
// it doesn't sit as a public 500-trigger forever. Remove after the
// project has its first organic event.
app.get("/debug-sentry", (c) => {
  const token = c.req.query("token");
  if (
    process.env.NODE_ENV === "production" &&
    token !== process.env.API_INTERNAL_TOKEN
  ) {
    return c.json({ error: "not_found" }, 404);
  }
  throw new Error("x1agent api: first Sentry event");
});
app.get("/auth/github/config", (c) =>
  c.json({
    configured:
      !!process.env.GITHUB_APP_ID &&
      !!process.env.GITHUB_APP_PRIVATE_KEY &&
      !!process.env.GITHUB_APP_SLUG,
    app_slug: process.env.GITHUB_APP_SLUG || null,
  }),
);

app.route("/auth", authRoutes);
app.route("/api/me", meRoutes);
app.route("/auth/github", githubInstallRoutes);
app.route("/oauth/slack", slackOAuthRoutes);
app.route("/api/workspaces/:slug/slack", slackBotApiRoutes);
app.route("/api/slack/events", slackEventsRoutes);
app.route("/api/workspaces/:slug/invitations", workspaceInvitationRoutes);
app.route("/api/workspaces", workspaceCreateRoutes);
app.route("/api/invitations", publicInvitationRoutes);
app.route("/api/workspaces/:slug/agents", agentRoutes);
app.route("/api/workspaces/:slug/agents/:agentId/sessions", sessionRoutes);
app.route("/api/workspaces/:slug/sessions", workspaceSessionRoutes);
app.route("/api/workspaces/:slug/token-usage", workspaceTokenUsageRoutes);
// X1A-37 — mounts:
//   GET /api/workspaces/:slug/sessions/:sessionId/cost
//   GET /api/workspaces/:slug/sessions/:sessionId/cost-tree
//   GET /api/workspaces/:slug/agents/:agentId/cost?window=…
app.route("/api/workspaces/:slug", workspaceCostRoutes);
app.route(
  "/api/workspaces/:slug/sessions/:sessionId/shares",
  workspaceShareRoutes,
);
app.route("/api/workspaces/:slug/shares", workspaceSharesIndexRoutes);
app.route(
  "/api/workspaces/:slug/sessions/:sessionId/user-shares",
  sessionShareRoutes,
);
app.route("/api/workspaces/:slug/agents/:agentId/repos", agentRepoRoutes);
app.route("/api/workspaces/:slug/grants", workspaceGrantRoutes);
app.route("/api/workspaces/:slug/secrets", workspaceSecretsRoutes);
app.route("/api/workspaces/:slug/mcp-catalog", mcpCatalogRoutes);
app.route(
  "/api/workspaces/:slug/agents/:agentId/mcp-attachments",
  agentMcpAttachmentRoutes,
);
app.route("/api/workspaces/:slug/agents/:agentId/env", agentEnvRoutes);
// Browser-redirect OAuth flows for remote_oauth MCPs:
//   /auth/mcp/start/:slug/:name      — initiate
//   /auth/mcp/callback/:slug/:name   — provider redirects here
// Plus JSON status endpoints under /api/users/me/mcp-tokens.
app.route("/auth/mcp", mcpOAuthRoutes);
app.route("/api/users", mcpUserTokenRoutes);
app.route("/api/workspaces/:slug/collections", collectionRoutes);
app.route(
  "/api/workspaces/:slug/agents/:agentId/collections",
  agentCollectionRoutes,
);
app.route(
  "/api/workspaces/:slug/shared-agent-resources",
  sharedAgentResourcesRoutes,
);
app.route(
  "/api/workspaces/:slug/agent-images",
  workspaceImageCatalogRoutes,
);
app.route("/api/workspaces/:slug/members", workspaceMembersRoutes);
app.route("/api/installations", installationApiRoutes);
app.route("/api/internal", internalRoutes);

// Always-run seed: platform image presets. Idempotent.
await seedPlatformPresets().catch((err) => {
  console.warn("[seed] platform presets skipped:", (err as Error).message);
});
// Dev-only seed: default workspace + test user.
await seedIfDev().catch((err) => {
  console.warn("[seed] dev skipped:", (err as Error).message);
});

const SCHEDULER_INTERVAL_MS = Number(
  process.env.SCHEDULER_INTERVAL_MS || 30_000,
);
const schedulerDisabled = process.env.SCHEDULER_DISABLED === "true";

if (!schedulerDisabled) {
  scheduler.register({
    name: "session-scheduler",
    intervalMs: SCHEDULER_INTERVAL_MS,
    jitterMs: Math.floor(SCHEDULER_INTERVAL_MS * 0.1),
    runOnStart: true,
    fn: async () => {
      const r = await tickScheduler();
      if (r.created > 0 || r.errors > 0) {
        console.log(
          `[session-scheduler] considered=${r.considered} created=${r.created} skipped=${r.skippedDuplicate} errors=${r.errors}`,
        );
      }
    },
  });
  console.log(
    `[session-scheduler] registered (every ${SCHEDULER_INTERVAL_MS}ms — this is the DB-scan cadence, NOT per-agent run cadence; each agent runs on its own schedule)`,
  );
}

// Dangling-grant reaper. session-scoped grants become invalid when their
// bound session reaches a terminal state; the active-lookup already
// filters on session status, but this belt-and-suspenders pass
// permanently marks those grants revoked so the audit log and the UI
// agree on the set of "live" grants.
const REAPER_INTERVAL_MS = Number(
  process.env.GRANT_REAPER_INTERVAL_MS || 60_000,
);
const reaperDisabled = process.env.GRANT_REAPER_DISABLED === "true";
if (!reaperDisabled) {
  scheduler.register({
    name: "grants-reaper",
    intervalMs: REAPER_INTERVAL_MS,
    jitterMs: Math.floor(REAPER_INTERVAL_MS * 0.1),
    runOnStart: true,
    fn: async () => {
      const n = await permissionGrants.reapDanglingSessionGrants();
      if (n > 0) console.log(`[grants-reaper] reaped ${n} dangling session grants`);
    },
  });
  console.log(`[grants-reaper] registered (interval=${REAPER_INTERVAL_MS}ms)`);
}

const natsUrl = process.env.NATS_URL || "";
if (natsUrl && process.env.NATS_DISABLED !== "true") {
  try {
    const sub = await startSessionEventSubscriber({
      natsUrl,
      events: sessionEvents,
      sessions: composedSessions,
      agents: composedAgents,
      tokenUsage: composedTokenUsage,
      summarizer: buildSessionSummarizer(),
      summaryConfig: readSummaryConfigFromEnv(),
    });
    registerCleanup(() => sub.stop());
    console.log(`[nats] connected to ${natsUrl}`);
  } catch (err) {
    console.warn(
      `[nats] subscriber failed to start: ${(err as Error).message} — events will not land in DB until NATS is reachable`,
    );
  }
  try {
    const sub = await startSessionAuditSubscriber({
      natsUrl,
      sql: composedSql,
    });
    registerCleanup(() => sub.stop());
  } catch (err) {
    console.warn(
      `[audit] subscriber failed to start: ${(err as Error).message} — sidecar audit events will not land in DB`,
    );
  }

  // Image builder — consumes x1.image.build, runs Kaniko inside the
  // api's namespace, writes built_ref back to agent_images. Lives in
  // the api process for v1 (RBAC + k8s client + DB conn already wired);
  // can be extracted to its own deployment in Phase 3 if memory pressure
  // matters.
  if (
    sharedKubeConfig &&
    providerNats &&
    process.env.IMAGE_BUILDER_DISABLED !== "true"
  ) {
    try {
      const handle = await startImageBuilder({
        natsConnection: providerNats,
        sql: composedSql,
        kubeConfig: sharedKubeConfig,
        buildNamespace: process.env.IMAGE_BUILD_NAMESPACE || "x1agent",
        registryAddress:
          process.env.IMAGE_REGISTRY ||
          "x1-registry.x1agent.svc.cluster.local:5000",
        registryInsecure: process.env.IMAGE_REGISTRY_INSECURE !== "false",
      });
      registerCleanup(() => handle.stop());
    } catch (err) {
      console.warn(
        `[image-builder] failed to start: ${(err as Error).message} — workspace image builds will sit at 'pending' until restart`,
      );
    }
  } else if (!sharedKubeConfig) {
    console.warn(
      "[image-builder] no kubeconfig — workspace image builds disabled",
    );
  } else if (!providerNats) {
    console.warn(
      "[image-builder] no NATS connection — workspace image builds disabled",
    );
  }
}

const BRANCH_REAPER_INTERVAL_MS = Number(
  process.env.BRANCH_REAPER_INTERVAL_MS || 24 * 60 * 60 * 1000,
);
const BRANCH_REAPER_STALE_AFTER_MS = Number(
  process.env.BRANCH_REAPER_STALE_AFTER_MS || 30 * 24 * 60 * 60 * 1000,
);
if (process.env.BRANCH_REAPER_DISABLED !== "true") {
  scheduler.register({
    name: "branch-reaper",
    intervalMs: BRANCH_REAPER_INTERVAL_MS,
    // Daily-ish cadence; jitter by an hour so multi-replica deploys
    // don't all hammer the cluster on the stroke of midnight.
    jitterMs: 60 * 60 * 1000,
    runOnStart: true,
    fn: async () => {
      const r = await reapStaleBranches({
        sql: composedSql,
        sharedResources: composedSharedResources,
        postgresBranches: composedPostgresBranches ?? null,
        postgresMinter: composedPostgresMinter ?? null,
        redisBranches: composedRedisBranches ?? null,
        redisMinter: composedRedisMinter ?? null,
        namespace: process.env.K8S_NAMESPACE || "x1agent",
        staleAfterMs: BRANCH_REAPER_STALE_AFTER_MS,
      });
      if (r.postgresReaped + r.redisReaped + r.errors > 0) {
        console.log(
          `[branch-reaper] pg=${r.postgresReaped} redis=${r.redisReaped} errors=${r.errors}`,
        );
      }
    },
  });
  console.log(
    `[branch-reaper] registered (interval=${BRANCH_REAPER_INTERVAL_MS}ms stale_after=${BRANCH_REAPER_STALE_AFTER_MS}ms)`,
  );
}

// Status reconciler for shared agent resources. On a fast cadence
// (15s) we ask each engine's provisioner whether the StatefulSet it
// just stood up has become ready; on the first positive answer we
// flip the workspace_shared_resources row from 'provisioning' to
// 'running'. Without this the UI sits at "provisioning" indefinitely
// even though K8s marked the pod 1/1 Ready seconds after install.
const RESOURCE_RECONCILE_INTERVAL_MS = Number(
  process.env.RESOURCE_RECONCILE_INTERVAL_MS || 15_000,
);
if (process.env.RESOURCE_RECONCILE_DISABLED !== "true") {
  scheduler.register({
    name: "shared-resources-reconciler",
    intervalMs: RESOURCE_RECONCILE_INTERVAL_MS,
    jitterMs: Math.floor(RESOURCE_RECONCILE_INTERVAL_MS * 0.1),
    runOnStart: true,
    fn: async () => {
      const r = await reconcileSharedResourceStatuses({
        sharedResources: composedSharedResources,
        postgresProvisioner: composedPostgresProvisioner ?? null,
        redisProvisioner: composedRedisProvisioner ?? null,
        namespace: process.env.K8S_NAMESPACE || "x1agent",
      });
      if (r.flipped > 0) {
        console.log(
          `[shared-resources-reconciler] reconciled ${r.flipped}/${r.checked} to running`,
        );
      }
    },
  });
  console.log(
    `[shared-resources-reconciler] registered (interval=${RESOURCE_RECONCILE_INTERVAL_MS}ms)`,
  );
}

if (process.env.JOB_WATCHER !== "disabled") {
  try {
    const watcher = startJobWatcher({
      sql: composedSql,
      agents: composedAgents,
      sessions: composedSessions,
      agentRepos: composedAgentRepos,
      collections: composedCollections,
      namespace: process.env.K8S_NAMESPACE || "x1agent",
      agentImage: process.env.AGENT_IMAGE || "x1agent-agent:latest",
      sidecarImage: process.env.SIDECAR_IMAGE || "x1agent-sidecar:latest",
      imagePullPolicy:
        (process.env.IMAGE_PULL_POLICY as
          | "IfNotPresent"
          | "Always"
          | "Never"
          | undefined) ?? "IfNotPresent",
      apiUrl: process.env.CLUSTER_API_URL || "http://api:30001",
      apiInternalToken: process.env.API_INTERNAL_TOKEN || "",
      natsUrl: process.env.NATS_URL || "nats://nats:4222",
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      // Vertex path: the api Deployment's env (set by the Helm chart
      // when anthropic.provider == vertex) drives every session pod
      // it spawns. Default falls through to api_key for back-compat
      // with local dev that has no notion of Vertex.
      anthropicProvider:
        (process.env.ANTHROPIC_PROVIDER as "api_key" | "vertex" | undefined) ??
        "api_key",
      vertexRegion: process.env.CLOUD_ML_REGION || undefined,
      vertexProjectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID || undefined,
      // ANTHROPIC_MODEL pins the SDK to a specific model id. Falls
      // back to the first Sonnet model in the upstream catalog (Vertex
      // or Anthropic API) when the env is unset, so a fresh install
      // doesn't have to manually pick a model just to spawn a session.
      anthropicModel: await resolveDefaultAnthropicModel(),
      sessionServiceAccount:
        process.env.SESSION_SERVICE_ACCOUNT || undefined,
      natsClientTlsSecret:
        process.env.SESSION_NATS_TLS_SECRET || undefined,
      intervalMs: Number(process.env.JOB_WATCHER_INTERVAL_MS || 5000),
      sharedResources: composedSharedResources,
      sessionEvents,
      agentEnvBindings: composedAgentEnvBindings,
      workspaceSecrets: composedWorkspaceSecrets,
      mcpAttachments: composedMcpAttachments,
      mcpCatalog: composedMcpCatalog,
      userTokenService: composedUserTokenService,
      mcpOAuthProxyImage:
        process.env.MCP_OAUTH_PROXY_IMAGE || "x1agent-mcp-oauth-proxy:latest",
      // X1A-42: per-user git identity lookup at session-launch. The
      // job-watcher reads this user's stored identity (set on the
      // account page) and forwards it as GIT_AUTHOR_* / GIT_COMMITTER_*
      // env on the agent container, so worker commits attribute to the
      // human rather than `x1agent[bot]`.
      users: composedUsers,
      postgresMinter: composedPostgresMinter,
      postgresBranches: composedPostgresBranches,
      redisMinter: composedRedisMinter,
      redisBranches: composedRedisBranches,
      wakePublisher: providerNats
        ? async (session, terminalStatus, completedAt, errorMessage) => {
            const { publishStateChangeWake } = await import(
              "./orchestration/wake-publisher.js"
            );
            await publishStateChangeWake(
              { nc: providerNats!, sessions: composedSessions, agents: composedAgents },
              session,
              terminalStatus,
              completedAt,
              errorMessage,
            );
          }
        : undefined,
    });
    registerCleanup(() => watcher.stop());
  } catch (err) {
    console.warn(
      `[jobs] watcher start failed: ${(err as Error).message} — sessions will stay pending`,
    );
  }
}

// Session-status reconciler. The Job-watcher is authoritative when
// the cluster is healthy, but if the node restarts or kubelet crashes
// we can lose the terminal Job event — session rows end up stuck in
// `running` forever, and orchestrator singletons wedge because
// find-or-create sees a live-looking row that isn't. This reconciler
// walks non-terminal sessions older than the grace window, asks
// whether their Job still exists, and flips to `failed` with a
// state_change wake when the Job is gone. See
// packages/domains/sessions/src/application/reconcile-session-status.ts.
const SESSION_RECONCILE_INTERVAL_MS = Number(
  process.env.SESSION_RECONCILE_INTERVAL_MS || 30_000,
);
const SESSION_RECONCILE_GRACE_MS = Number(
  process.env.SESSION_RECONCILE_GRACE_MS || 120_000,
);
if (sharedKubeConfig && process.env.SESSION_RECONCILE_DISABLED !== "true") {
  const { reconcileSessionStatuses } = await import(
    "@x1agent/domain-sessions"
  );
  const { sessionJobName } = await import("./k8s/pod-spec.js");
  const { systemClock } = await import("@x1agent/kernel");
  const batchApi = sharedKubeConfig.makeApiClient(k8s.BatchV1Api);
  const namespace = process.env.K8S_NAMESPACE || "x1agent";
  scheduler.register({
    name: "session-reconciler",
    intervalMs: SESSION_RECONCILE_INTERVAL_MS,
    jitterMs: Math.floor(SESSION_RECONCILE_INTERVAL_MS * 0.1),
    runOnStart: true,
    fn: async () => {
      const r = await reconcileSessionStatuses({
        sessions: composedSessions,
        clock: systemClock,
        jobExists: async (sessionId) => {
          try {
            await batchApi.readNamespacedJob({
              name: sessionJobName(sessionId),
              namespace,
            });
            return true;
          } catch (err) {
            const status = (err as { code?: number; statusCode?: number }).code
              ?? (err as { statusCode?: number }).statusCode;
            if (status === 404) return false;
            // Anything else (5xx, network) → throw so the tick
            // counts it as an error and leaves the row alone.
            throw err;
          }
        },
        notify: async (session, completedAt, errorMessage) => {
          if (!providerNats) return;
          const { publishStateChangeWake } = await import(
            "./orchestration/wake-publisher.js"
          );
          await publishStateChangeWake(
            {
              nc: providerNats,
              sessions: composedSessions,
              agents: composedAgents,
            },
            session,
            "failed",
            completedAt,
            errorMessage,
          );
        },
        gracePeriodMs: SESSION_RECONCILE_GRACE_MS,
      });
      if (r.flipped > 0 || r.errors > 0) {
        console.log(
          `[session-reconciler] reconciled ${r.flipped}/${r.checked} ghost sessions (errors=${r.errors})`,
        );
      }
    },
  });
  console.log(
    `[session-reconciler] registered (interval=${SESSION_RECONCILE_INTERVAL_MS}ms grace=${SESSION_RECONCILE_GRACE_MS}ms)`,
  );
}

// Activity watchdog — periodically sweeps children of live
// orchestrators and fires watchdog wakes when they've been silent
// past the backoff threshold. Requires NATS to publish wakes;
// no-op if NATS isn't configured. See
// docs/architecture/orchestration.md § Server-driven wakes.
if (
  providerNats &&
  process.env.ACTIVITY_WATCHDOG !== "disabled"
) {
  const { startActivityWatchdog } = await import(
    "./orchestration/activity-watchdog.js"
  );
  const watchdog = startActivityWatchdog({
    sql: composedSql,
    agents: composedAgents,
    nc: providerNats,
    intervalMs: Number(process.env.ACTIVITY_WATCHDOG_INTERVAL_MS || 60_000),
    quietHints: composedQuietHints,
  });
  registerCleanup(() => watchdog.stop());
}

// Checkup timer — cadence-driven "just checking in" for
// orchestrators with at least one active child. Complements the
// watchdog (per-child silence detection) by giving the orchestrator
// periodic glance-opportunities even when every child is emitting
// events normally. See docs/architecture/orchestration.md §
// Server-driven wakes.
if (providerNats && process.env.CHECKUP_TIMER !== "disabled") {
  const { startCheckupTimer } = await import(
    "./orchestration/checkup-timer.js"
  );
  const checkup = startCheckupTimer({
    sql: composedSql,
    agents: composedAgents,
    nc: providerNats,
    intervalMs: Number(process.env.CHECKUP_TIMER_SWEEP_MS || 60_000),
    checkupCadenceMs: Number(
      process.env.CHECKUP_CADENCE_MS || 15 * 60_000,
    ),
  });
  registerCleanup(() => checkup.stop());
}

// All periodic tasks were registered above; kick the timers now.
scheduler.start();

console.log(`[api] listening on :${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
