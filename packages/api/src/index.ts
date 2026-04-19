import { Hono } from "hono";
import { compose } from "./composition/index.js";
import { getSql } from "./db/client.js";
import { seedIfDev } from "./seed.js";
import { startSessionEventSubscriber } from "./nats/subscriber.js";

const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:4321";
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || "http://localhost:30001";
const PORT = Number(process.env.API_PORT || 30001);

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET env var is required");
}

const {
  authRoutes,
  workspaceInvitationRoutes,
  publicInvitationRoutes,
  agentRoutes,
  sessionRoutes,
  internalRoutes,
  githubInstallRoutes,
  installationApiRoutes,
  agentRepoRoutes,
  sessionEvents,
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
app.route("/api/workspaces/:slug/agents/:agentId/repos", agentRepoRoutes);
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

const natsUrl = process.env.NATS_URL || "";
if (natsUrl && process.env.NATS_DISABLED !== "true") {
  try {
    await startSessionEventSubscriber({ natsUrl, events: sessionEvents });
    console.log(`[nats] connected to ${natsUrl}`);
  } catch (err) {
    console.warn(
      `[nats] subscriber failed to start: ${(err as Error).message} — events will not land in DB until NATS is reachable`,
    );
  }
}

console.log(`[api] listening on :${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
