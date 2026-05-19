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
import { startCommentWakeSubscriber } from "./nats/comment-wake-subscriber.js";
import {
  AnthropicSessionSummarizer,
  OpenAISessionSummarizer,
  StubSessionSummarizer,
  VertexAnthropicSessionSummarizer,
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
 *   1. Vertex Anthropic — when ANTHROPIC_PROVIDER="vertex" AND both
 *      ANTHROPIC_VERTEX_PROJECT_ID and CLOUD_ML_REGION are set. The
 *      Workload Identity token is minted per-call from the GCE
 *      metadata server; if the pod isn't on GKE or the SA lacks
 *      aiplatform.user, individual calls return null but the
 *      composition still selects this path (other paths likely have
 *      identical credentials and would also fail).
 *   2. Anthropic direct API — when ANTHROPIC_API_KEY is set, regardless
 *      of ANTHROPIC_PROVIDER. This is the fallback for a Vertex-
 *      configured install whose Vertex creds aren't usable (e.g.
 *      regional outage) but an API key is also wired.
 *   3. OpenAI — when OPENAI_API_KEY is set. Lets a deployment using
 *      OpenAI for embeddings light up summaries without acquiring
 *      Anthropic credentials.
 *   4. Stub — no creds anywhere; session.summary stays NULL and the
 *      UI falls back to the id hash.
 *
 * Selection is one-time at boot. Per-call failures inside the chosen
 * summarizer are swallowed — a missed summary is not a fatal state
 * and the next scheduled summary refresh tries again.
 */
function buildSessionSummarizer(
  sql: import("postgres").Sql<Record<string, unknown>>,
): SessionSummarizer {
  const anthropicProvider = process.env.ANTHROPIC_PROVIDER ?? "api_key";
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const summaryModel = process.env.ANTHROPIC_SUMMARY_MODEL?.trim() || undefined;

  // X1A-145: platform admins pick the summary model in the UI; the
  // selection lives in platform_settings.anthropic.summary_model and
  // wins over the env-time default. Each summarize() call re-reads
  // (no caching) so an admin change takes effect within seconds — no
  // api restart needed. The query is a single keyed point-lookup
  // against a tiny table, well inside the noise floor.
  const modelResolver = async (): Promise<string | undefined> => {
    try {
      const rows = await sql<{ value: string }[]>`
        SELECT value FROM platform_settings
        WHERE key = 'anthropic.summary_model'
      `;
      return rows[0]?.value as unknown as string | undefined;
    } catch {
      return undefined;
    }
  };

  if (anthropicProvider === "vertex") {
    const projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID?.trim();
    const region = process.env.CLOUD_ML_REGION?.trim();
    if (projectId && region) {
      console.log(
        `[summarizer] using anthropic vertex path (project=${projectId} region=${region})`,
      );
      return new VertexAnthropicSessionSummarizer({
        projectId,
        region,
        model: summaryModel,
        modelResolver,
      });
    }
    console.warn(
      "[summarizer] ANTHROPIC_PROVIDER=vertex but ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION unset — falling through",
    );
  }

  if (anthropicKey && anthropicKey.trim()) {
    console.log("[summarizer] using anthropic api-key path");
    return new AnthropicSessionSummarizer({
      apiKey: anthropicKey,
      model: summaryModel,
      modelResolver,
    });
  }

  if (openaiKey && openaiKey.trim()) {
    const model = process.env.OPENAI_SUMMARY_MODEL?.trim() || undefined;
    console.log("[summarizer] using openai api-key path");
    return new OpenAISessionSummarizer({ apiKey: openaiKey, model });
  }

  console.log(
    "[summarizer] no anthropic vertex / api key / openai key — session summaries disabled",
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
  accessGrantsRoutes,
  publicInvitationRoutes,
  agentRoutes,
  agentGrantRoutes,
  previewEnvironmentRoutes,
  sessionRoutes,
  workspaceSessionRoutes,
  workspaceTokenUsageRoutes,
  workspaceCostRoutes,
  workspaceShareRoutes,
  workspaceSharesIndexRoutes,
  sessionShareRoutes,
  shareCommentRoutes,
  internalShareCommentRoutes,
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
  workspaceEnvRoutes,
  mcpOAuthRoutes,
  mcpUserTokenRoutes,
  collectionRoutes,
  agentCollectionRoutes,
  sharedAgentResourcesRoutes,
  workspaceImageCatalogRoutes,
  workspaceMembersRoutes,
  adminAnthropicModelsRoutes,
  adminWorkspacesRoutes,
  platformSecretsRoutes,
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
  memberships: composedMemberships,
  sessionShares: composedSessionShares,
  platformAdminGuard: composedPlatformAdminGuard,
  agentCollaborateResolver: composedAgentCollaborateResolver,
  tokenizer: composedTokenizer,
  shareComments: composedShareComments,
  agentRepoStore: composedAgentRepos,
  agentEnvBindings: composedAgentEnvBindings,
  workspaceSecrets: composedWorkspaceSecrets,
  mcpAttachments: composedMcpAttachments,
  mcpCatalog: composedMcpCatalog,
  userTokenService: composedUserTokenService,
  users: composedUsers,
  tickScheduler,
  quietHints: composedQuietHints,
  uploadRoutes,
  tickUploadsCleanup,
  jobTerminator: composedJobTerminator,
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
app.route("/api/admin/platform-secrets", platformSecretsRoutes);

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
app.route("/api/workspaces/:slug/agents/:agentId/grants", agentGrantRoutes);
app.route(
  "/api/workspaces/:slug/preview-environments",
  previewEnvironmentRoutes,
);
app.route("/api/workspaces/:slug/agents/:agentId/sessions", sessionRoutes);
app.route("/api/workspaces/:slug/sessions", workspaceSessionRoutes);
app.route("/api/workspaces/:slug/token-usage", workspaceTokenUsageRoutes);
// Doc commenting v1 (X1A-52) must mount BEFORE the broader
// `/sessions/:sessionId/shares` route, whose `/:shareId/*` binary-fetch
// handler otherwise eats requests at `/shares/:shareId/comments` and
// returns `{"error":"not_found"}` 404 before this handler can run.
// Hono matches the first registered prefix; specific paths win when
// registered first.
app.route(
  "/api/workspaces/:slug/sessions/:sessionId/shares/:shareId/comments",
  shareCommentRoutes,
);
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
app.route("/api/internal/share-comments", internalShareCommentRoutes);
app.route("/api/workspaces/:slug/agents/:agentId/repos", agentRepoRoutes);
app.route("/api/workspaces/:slug/grants", workspaceGrantRoutes);
app.route("/api/workspaces/:slug/secrets", workspaceSecretsRoutes);
app.route("/api/workspaces/:slug/mcp-catalog", mcpCatalogRoutes);
app.route(
  "/api/workspaces/:slug/agents/:agentId/mcp-attachments",
  agentMcpAttachmentRoutes,
);
app.route("/api/workspaces/:slug/agents/:agentId/env", agentEnvRoutes);
app.route("/api/workspaces/:slug/env-bindings", workspaceEnvRoutes);
app.route("/api/workspaces/:slug/access-grants", accessGrantsRoutes);
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
// X1A-96 — image uploads. The first route inside (PUT /:id/raw) is
// the local-disk signed-URL ingress, which authorises on the HMAC
// token in the query string and runs BEFORE requireAuth. Every other
// route under /api/uploads requires an authenticated session and
// scopes to the creator-only ACL.
app.route("/api/uploads", uploadRoutes);

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

// X1A-96 — uploads cleanup sweep. 1h cadence is conventional for this
// kind of "transition rows past their TTL, then delete the backing
// objects" sweep; tunable via UPLOADS_CLEANUP_INTERVAL_MS for tests +
// operators with smaller windows. UPLOADS_CLEANUP_DISABLED=true turns
// the sweep off (kept for parity with the other schedulers).
const UPLOADS_CLEANUP_INTERVAL_MS = Number(
  process.env.UPLOADS_CLEANUP_INTERVAL_MS || 60 * 60 * 1000,
);
const uploadsCleanupDisabled =
  process.env.UPLOADS_CLEANUP_DISABLED === "true";
if (!uploadsCleanupDisabled) {
  scheduler.register({
    name: "uploads-cleanup",
    intervalMs: UPLOADS_CLEANUP_INTERVAL_MS,
    jitterMs: Math.floor(UPLOADS_CLEANUP_INTERVAL_MS * 0.1),
    runOnStart: true,
    fn: async () => {
      const r = await tickUploadsCleanup();
      if (r.expired > 0 || r.objectsDeleted > 0 || r.hardDeleted > 0 || r.errors > 0) {
        console.log(
          `[uploads-cleanup] expired=${r.expired} objects_deleted=${r.objectsDeleted} hard_deleted=${r.hardDeleted} errors=${r.errors}`,
        );
      }
    },
  });
  console.log(
    `[uploads-cleanup] registered (interval=${UPLOADS_CLEANUP_INTERVAL_MS}ms)`,
  );
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
      summarizer: buildSessionSummarizer(composedSql),
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

  // X1A-55 — comment-wake subscriber. Listens for
  // `agent.share_comment_added` + `agent.share_comment_thread_resolved`
  // and injects a user.message wake into the share's producing
  // session, closing the two-way doc-commenting loop.
  try {
    const sub = await startCommentWakeSubscriber({
      natsUrl,
      sessions: composedSessions,
      comments: composedShareComments,
    });
    registerCleanup(() => sub.close());
  } catch (err) {
    console.warn(
      `[comment-wake] subscriber failed to start: ${(err as Error).message} — orchestrator will not be woken on new comments`,
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
        // Optional KSA the Kaniko Job runs as. Required for Artifact
        // Registry pushes — the KSA must be Workload-Identity-bound to
        // a GSA with roles/artifactregistry.writer. Defaults to
        // x1agent-preview-build, which the chart already provisions
        // when previews are enabled (same writer permission).
        buildServiceAccount: process.env.IMAGE_BUILD_SERVICE_ACCOUNT || undefined,
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
      // Codex runtime spike — only consumed when the resolved agent
      // image is a Codex runtime build (see isCodexRuntimeImage in
      // pod-spec.ts). OPENAI_API_KEY is already wired through the
      // four-layer install pattern documented in CLAUDE.md.
      openaiApiKey: process.env.OPENAI_API_KEY,
      openaiModel: process.env.OPENAI_MODEL || undefined,
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

// Silent-worker reaper (X1A-28). Cancels worker sessions whose
// session_events stream has been silent past the configured threshold
// — distinct from the activity watchdog (which fires a wake to the
// parent at 5 min); the reaper is the hard termination after that.
// Default 30 min silence; configurable via env.
if (process.env.SILENT_WORKER_REAPER !== "disabled") {
  const { startSilentWorkerReaper } = await import(
    "./orchestration/silent-worker-reaper.js"
  );
  const reaper = startSilentWorkerReaper({
    sql: composedSql,
    agents: composedAgents,
    sessions: composedSessions,
    events: sessionEvents,
    jobs: composedJobTerminator,
    quietHints: composedQuietHints,
    intervalMs: Number(
      process.env.SILENT_WORKER_REAPER_INTERVAL_MS || 120_000,
    ),
    silenceThresholdMs: Number(
      process.env.SILENT_WORKER_REAPER_THRESHOLD_MS || 30 * 60_000,
    ),
  });
  registerCleanup(() => reaper.stop());
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

// WebSocket bridge — the browser used to talk to NATS directly over a
// public WS where it was the `x1agent-api` super-user on every subject.
// That ingress is gone; the browser now opens an authenticated WS to
// this api at /api/ws, and this bridge does the auth + per-message
// whitelist enforcement before relaying to/from NATS.
//
// When NATS is disabled or unreachable at boot, we still want the
// HTTP surface to come up — so `wsBridge` may be null and any
// /api/ws upgrade attempt returns 503 from the fetch wrapper.
let wsBridge:
  | ReturnType<typeof import("./ws-bridge/index.js").buildWsBridge>
  | null = null;
if (providerNats) {
  const { buildWsBridge } = await import("./ws-bridge/index.js");
  wsBridge = buildWsBridge({
    tokenizer: composedTokenizer,
    nats: providerNats,
    sessions: composedSessions,
    agents: composedAgents,
    memberships: composedMemberships,
    sessionShares: composedSessionShares,
    platformAdminGuard: composedPlatformAdminGuard,
    agentCollaborateResolver: composedAgentCollaborateResolver,
  });
  console.log("[ws-bridge] listening on /api/ws");
} else {
  console.warn(
    "[ws-bridge] disabled — providerNats is null; browser live-update will be offline",
  );
}

export default {
  port: PORT,
  fetch(req: Request, server: import("bun").Server<unknown>) {
    if (wsBridge) {
      const handled = wsBridge.tryUpgrade(req, server);
      if (handled) return handled;
      // tryUpgrade returns undefined when (a) the path doesn't match
      // /api/ws (so Hono handles it normally) OR (b) the upgrade
      // succeeded (Bun has hijacked the connection). In both cases we
      // fall through to Hono — for case (b) Hono will see a no-op and
      // return whatever it returns; Bun doesn't actually invoke fetch
      // again after a successful upgrade.
    } else {
      const url = new URL(req.url);
      if (url.pathname === "/api/ws") {
        return new Response("nats_bridge_disabled", { status: 503 });
      }
    }
    return app.fetch(req, server);
  },
  websocket: {
    open(ws: import("bun").ServerWebSocket<unknown>) {
      wsBridge?.websocket.open(
        ws as import("bun").ServerWebSocket<never>,
      );
    },
    message(
      ws: import("bun").ServerWebSocket<unknown>,
      data: string | Buffer,
    ) {
      void wsBridge?.websocket.message(
        ws as import("bun").ServerWebSocket<never>,
        data,
      );
    },
    close(ws: import("bun").ServerWebSocket<unknown>) {
      wsBridge?.websocket.close(
        ws as import("bun").ServerWebSocket<never>,
      );
    },
  },
};
