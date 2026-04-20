import { Hono } from "hono";
import * as k8s from "@kubernetes/client-node";
import { compose } from "./composition/index.js";
import { getSql } from "./db/client.js";
import { seedIfDev } from "./seed.js";
import { startSessionEventSubscriber } from "./nats/subscriber.js";
import { startSessionAuditSubscriber } from "./nats/audit-subscriber.js";
import { startJobWatcher } from "./k8s/job-watcher.js";
import { reapStaleBranches } from "./shared-agent-resources/reap-branches.js";

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
  workspaceInvitationRoutes,
  publicInvitationRoutes,
  agentRoutes,
  sessionRoutes,
  workspaceSessionRoutes,
  internalRoutes,
  githubInstallRoutes,
  installationApiRoutes,
  agentRepoRoutes,
  workspaceGrantRoutes,
  collectionRoutes,
  agentCollectionRoutes,
  sharedAgentResourcesRoutes,
  workspaceImageCatalogRoutes,
  sharedResources: composedSharedResources,
  postgresBranches: composedPostgresBranches,
  postgresMinter: composedPostgresMinter,
  redisBranches: composedRedisBranches,
  redisMinter: composedRedisMinter,
  collections: composedCollections,
  permissionGrants,
  sessionEvents,
  sql: composedSql,
  agents: composedAgents,
  sessions: composedSessions,
  agentRepoStore: composedAgentRepos,
  tickScheduler,
} = compose({
  sql: getSql(),
  jwtSecret: process.env.JWT_SECRET,
  googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
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
  githubAppId: process.env.GITHUB_APP_ID || "",
  githubAppSlug: process.env.GITHUB_APP_SLUG || "",
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY || "",
  internalToken: process.env.API_INTERNAL_TOKEN || "",
  natsConnection: providerNats,
  kubeConfig: sharedKubeConfig,
  sharedResourcesNamespace: process.env.K8S_NAMESPACE || "x1agent",
});

const app = new Hono();

app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", PUBLIC_URL);
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));
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
app.route("/auth/github", githubInstallRoutes);
app.route("/api/workspaces/:slug/invitations", workspaceInvitationRoutes);
app.route("/api/invitations", publicInvitationRoutes);
app.route("/api/workspaces/:slug/agents", agentRoutes);
app.route("/api/workspaces/:slug/agents/:agentId/sessions", sessionRoutes);
app.route("/api/workspaces/:slug/sessions", workspaceSessionRoutes);
app.route("/api/workspaces/:slug/agents/:agentId/repos", agentRepoRoutes);
app.route("/api/workspaces/:slug/grants", workspaceGrantRoutes);
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
app.route("/api/installations", installationApiRoutes);
app.route("/api/internal", internalRoutes);

await seedIfDev().catch((err) => {
  console.warn("[seed] skipped:", (err as Error).message);
});

const SCHEDULER_INTERVAL_MS = Number(
  process.env.SCHEDULER_INTERVAL_MS || 30_000,
);
const schedulerDisabled = process.env.SCHEDULER_DISABLED === "true";

if (!schedulerDisabled) {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const r = await tickScheduler();
      if (r.created > 0 || r.errors > 0) {
        console.log(
          `[scheduler] considered=${r.considered} created=${r.created} skipped=${r.skippedDuplicate} errors=${r.errors}`,
        );
      }
    } catch (err) {
      console.warn("[scheduler] tick crashed:", (err as Error).message);
    } finally {
      ticking = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, SCHEDULER_INTERVAL_MS);
  // Don't keep the event loop alive on its own.
  if (typeof (handle as unknown as { unref?: () => void }).unref === "function") {
    (handle as unknown as { unref: () => void }).unref();
  }
  void tick();
  console.log(
    `[scheduler] started (interval=${SCHEDULER_INTERVAL_MS}ms)`,
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
  let reaping = false;
  const reap = async () => {
    if (reaping) return;
    reaping = true;
    try {
      const n = await permissionGrants.reapDanglingSessionGrants();
      if (n > 0) console.log(`[grants] reaped ${n} dangling session grants`);
    } catch (err) {
      console.warn("[grants] reaper crashed:", (err as Error).message);
    } finally {
      reaping = false;
    }
  };
  const handle = setInterval(() => {
    void reap();
  }, REAPER_INTERVAL_MS);
  if (typeof (handle as unknown as { unref?: () => void }).unref === "function") {
    (handle as unknown as { unref: () => void }).unref();
  }
  void reap();
  console.log(`[grants] reaper started (interval=${REAPER_INTERVAL_MS}ms)`);
}

const natsUrl = process.env.NATS_URL || "";
if (natsUrl && process.env.NATS_DISABLED !== "true") {
  try {
    await startSessionEventSubscriber({
      natsUrl,
      events: sessionEvents,
      sessions: composedSessions,
    });
    console.log(`[nats] connected to ${natsUrl}`);
  } catch (err) {
    console.warn(
      `[nats] subscriber failed to start: ${(err as Error).message} — events will not land in DB until NATS is reachable`,
    );
  }
  try {
    await startSessionAuditSubscriber({ natsUrl, sql: composedSql });
  } catch (err) {
    console.warn(
      `[audit] subscriber failed to start: ${(err as Error).message} — sidecar audit events will not land in DB`,
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
  let reaping = false;
  const reap = async () => {
    if (reaping) return;
    reaping = true;
    try {
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
    } catch (err) {
      console.warn(
        "[branch-reaper] tick crashed:",
        (err as Error).message,
      );
    } finally {
      reaping = false;
    }
  };
  const handle = setInterval(() => {
    void reap();
  }, BRANCH_REAPER_INTERVAL_MS);
  if (typeof (handle as unknown as { unref?: () => void }).unref === "function") {
    (handle as unknown as { unref: () => void }).unref();
  }
  // Initial kick is fire-and-forget — reaping on boot is cheap; the
  // API doesn't block startup on it.
  void reap();
  console.log(
    `[branch-reaper] started (interval=${BRANCH_REAPER_INTERVAL_MS}ms stale_after=${BRANCH_REAPER_STALE_AFTER_MS}ms)`,
  );
}

if (process.env.JOB_WATCHER !== "disabled") {
  try {
    startJobWatcher({
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
      intervalMs: Number(process.env.JOB_WATCHER_INTERVAL_MS || 5000),
      sharedResources: composedSharedResources,
      postgresMinter: composedPostgresMinter,
      postgresBranches: composedPostgresBranches,
      redisMinter: composedRedisMinter,
      redisBranches: composedRedisBranches,
    });
  } catch (err) {
    console.warn(
      `[jobs] watcher start failed: ${(err as Error).message} — sessions will stay pending`,
    );
  }
}

console.log(`[api] listening on :${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
