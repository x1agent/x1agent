import { NatsMessageInjector } from "../orchestration/nats-message-injector.js";
import { QuietHintStore } from "../orchestration/quiet-hints.js";
import {
  GoogleAuthProvider,
  DevBypassAuthProvider,
  JwtSessionTokenizer,
  PostgresUserRepository,
  PostgresPersonRepository,
  PostgresLinkAttemptStore,
  PostgresPasswordCredentialStore,
  PostgresAccessGate,
  createAuthRoutes,
  createRequireAuth,
  isPlatformAdmin as isEmailPlatformAdmin,
  type AuthProvider,
  type UserRepository,
  type SessionTokenizer,
} from "@x1agent/domain-auth";
import {
  PostgresMembershipRepository,
  PostgresWorkspaceRepository,
  createWorkspaceRoutes,
} from "@x1agent/domain-workspaces";
import { composeSlack } from "./slack.js";
import {
  CryptoTokenGenerator,
  PostgresInvitationRepository,
  createPublicInvitationRoutes,
  createWorkspaceInvitationRoutes,
} from "@x1agent/domain-invitations";
import {
  PostgresAgentRepository,
  createAgentRoutes,
} from "@x1agent/domain-agents";
import {
  PostgresSessionRepository,
  PostgresSessionEventRepository,
  PostgresTokenUsageRepository,
  PostgresSessionShareRepository,
  createSessionRoutes,
  createWorkspaceSessionRoutes,
  createWorkspaceTokenUsageRoutes,
  createSessionShareRoutes,
  scheduleDueSessions,
  type ScheduleDueSessionsResult,
  type SessionEventRepository,
} from "@x1agent/domain-sessions";
import {
  PostgresPermissionGrantRepository,
  createWorkspaceGrantRoutes,
} from "@x1agent/domain-permissions";
import {
  PostgresSecretRepository,
  SecretService,
  loadMasterKey,
  createWorkspaceSecretsRoutes,
} from "@x1agent/domain-workspace-secrets";
import {
  CatalogService,
  AttachmentService,
  PostgresCatalogRepository,
  PostgresAttachmentRepository,
  PostgresOAuthClientRepository,
  PostgresUserTokenRepository,
  UserTokenService,
  createMcpCatalogRoutes,
  createAgentMcpAttachmentRoutes,
  createMcpOAuthRoutes,
  createMcpUserTokenRoutes,
  type OAuthFlowState,
} from "@x1agent/domain-mcp-catalog";
import jwt from "jsonwebtoken";
import {
  BindingService,
  PostgresBindingRepository,
  createAgentEnvRoutes,
} from "@x1agent/domain-agent-env";
import {
  PostgresCollectionRepository,
  createCollectionRoutes,
  createAgentCollectionRoutes,
  type WorkspaceReader as CollectionsWorkspaceReader,
} from "@x1agent/domain-collections";
import {
  PostgresSharedResourceRepository,
  SharedResourceKind,
  createSharedAgentResourcesRoutes,
  type BranchResetter,
  type KindInstaller,
  type KindUninstaller,
  type SharedResource,
  type SharedResourceRepository,
} from "@x1agent/agent-resources";
import {
  PostgresPostgresBranchRepository,
  StatefulSetPostgresAdminProvisioner,
  StatefulSetPostgresBranchMinter,
  installPostgres,
  type PostgresAdminProvisioner,
  type PostgresBranchMinter,
  type PostgresBranchRepository,
} from "@x1agent/agent-resources-postgres";
import {
  PostgresRedisBranchRepository,
  StatefulSetRedisAdminProvisioner,
  StatefulSetRedisBranchMinter,
  installRedis,
  type RedisAdminProvisioner,
  type RedisBranchMinter,
  type RedisBranchRepository,
} from "@x1agent/agent-resources-redis";
import type * as k8s from "@kubernetes/client-node";
import { NatsProviderGateway } from "./nats-provider-gateway.js";
import type { NatsConnection } from "nats";
import {
  OctokitGitHubAppClient,
  PostgresInstallationRepository,
  PostgresAgentRepoStore,
  createGitHubInstallRoutes,
  createInstallationApiRoutes,
  createAgentRepoRoutes,
  type GitHubAppClient,
} from "@x1agent/domain-github";
import {
  systemClock,
  WorkspaceSlug,
  type Email,
  type UserId,
} from "@x1agent/kernel";
import type postgres from "postgres";
import type { Context, Hono } from "hono";
import {
  MembershipGrantorAdapter,
  WorkspaceAdminGuard,
  WorkspaceReaderAdapter,
} from "./invitation-adapters.js";
import { createInternalRoutes } from "../internal/routes.js";
import { createWorkspaceImageCatalogRoutes } from "../image-catalog/routes.js";
import {
  createWorkspaceShareRoutes,
  createWorkspaceSharesIndexRoutes,
} from "../shares/routes.js";
import {
  createAdminAnthropicModelsRoutes,
  listEnabledOverrides,
} from "../capabilities/admin-routes.js";
import { createAdminWorkspacesRoutes } from "../admin/workspaces-routes.js";

export interface Composition {
  authRoutes: Hono;
  workspaceInvitationRoutes: Hono;
  publicInvitationRoutes: Hono;
  /** POST /api/workspaces — platform-admin-only first-workspace bootstrap. */
  workspaceCreateRoutes: Hono;
  agentRoutes: Hono;
  sessionRoutes: Hono;
  workspaceSessionRoutes: Hono;
  workspaceTokenUsageRoutes: Hono;
  workspaceShareRoutes: Hono;
  /** /api/workspaces/:slug/sessions/:sessionId/user-shares — per-user share grants. */
  sessionShareRoutes: Hono;
  workspaceSharesIndexRoutes: Hono;
  internalRoutes: Hono;
  githubInstallRoutes: Hono;
  installationApiRoutes: Hono;
  agentRepoRoutes: Hono;
  /** /oauth/slack/* — browser-facing Slack OAuth callback. */
  slackOAuthRoutes: Hono;
  /** /api/workspaces/:slug/slack/* — workspace-admin Slack bot CRUD. */
  slackBotApiRoutes: Hono;
  /** /api/slack/events — Slack inbound event webhook (one URL, all bots). */
  slackEventsRoutes: Hono;
  workspaceGrantRoutes: Hono;
  /** /api/workspaces/:slug/secrets — workspace-admin-only env var store. */
  workspaceSecretsRoutes: Hono;
  /** /api/workspaces/:slug/mcp-catalog — workspace-admin MCP image registry. */
  mcpCatalogRoutes: Hono;
  /** /api/workspaces/:slug/agents/:agentId/mcp-attachments — per-agent MCP picks. */
  agentMcpAttachmentRoutes: Hono;
  /** /api/workspaces/:slug/agents/:agentId/env — Zone-2 agent env bindings. */
  agentEnvRoutes: Hono;
  /** /auth/mcp/* — browser redirects for the OAuth flow. */
  mcpOAuthRoutes: Hono;
  /** /api/users/me/mcp-tokens — JSON status endpoints for the UI. */
  mcpUserTokenRoutes: Hono;
  collectionRoutes: Hono;
  agentCollectionRoutes: Hono;
  sharedAgentResourcesRoutes: Hono;
  workspaceImageCatalogRoutes: Hono;
  /** /api/admin/anthropic/models — platform-admin model curation. */
  adminAnthropicModelsRoutes: Hono;
  /** /api/admin/workspaces — platform-admin cross-workspace list. */
  adminWorkspacesRoutes: Hono;
  sharedResources: SharedResourceRepository;
  postgresBranches: PostgresBranchRepository;
  postgresProvisioner: PostgresAdminProvisioner | null;
  postgresMinter: PostgresBranchMinter | null;
  redisBranches: RedisBranchRepository;
  redisProvisioner: RedisAdminProvisioner | null;
  redisMinter: RedisBranchMinter | null;
  tokenizer: SessionTokenizer;
  users: UserRepository;
  /** For the NATS subscriber to persist events as they fly by. */
  sessionEvents: SessionEventRepository;
  /** Per-turn token usage rows for billing + dashboards. */
  tokenUsage: PostgresTokenUsageRepository;
  /** Zone-2 agent env bindings repository — exposed to the job watcher. */
  agentEnvBindings: PostgresBindingRepository;
  /** Workspace-secret service — exposed for trusted decrypt at session-launch. */
  workspaceSecrets: SecretService;
  /** Zone-3 plumbing — exposed to the job watcher for token resolution. */
  mcpAttachments: PostgresAttachmentRepository;
  mcpCatalog: PostgresCatalogRepository;
  userTokenService: UserTokenService;
  /** Exposed for the Job watcher — reads directly without reconnecting. */
  sql: postgres.Sql<Record<string, unknown>>;
  agents: PostgresAgentRepository;
  sessions: PostgresSessionRepository;
  permissionGrants: PostgresPermissionGrantRepository;
  collections: PostgresCollectionRepository;
  agentRepoStore: PostgresAgentRepoStore;
  /** Run one scheduler tick. Exposed so callers can wire it to setInterval. */
  tickScheduler: () => Promise<ScheduleDueSessionsResult>;
  /**
   * Shared in-memory store of child `expect_quiet_for` hints. The
   * activity watchdog consults this to skip legitimately-quiet
   * children on the current sweep.
   */
  quietHints: QuietHintStore;
}

export interface CompositionEnv {
  sql: postgres.Sql<Record<string, unknown>>;
  jwtSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  /**
   * OAuth scopes requested at Google sign-in. Defaults to identity-only
   * (openid + email + profile). Operators expand this to include
   * Drive / Calendar / Gmail scopes when those providers are enabled,
   * so the consent screen prompts the user on first sign-in instead
   * of after-the-fact when they hit a feature.
   */
  googleScopes?: readonly string[];
  appUrl: string;
  apiUrl: string;
  allowedDomains: readonly string[];
  platformAdmins: readonly string[];
  authBypass: boolean;
  testUserEmail: string;
  platformName: string;
  githubAppId: string;
  githubAppSlug: string;
  githubAppPrivateKey: string;
  /** Shared secret the sidecar sends on /api/internal/*. */
  internalToken?: string;
  /**
   * Hex-encoded 32-byte master key for AES-256-GCM encryption of
   * workspace secrets. Required — compose() throws on missing/invalid.
   * Generate with `openssl rand -hex 32`. Stored in GSM as
   * x1agent-workspace-secrets-master-key. NEVER log or echo.
   */
  workspaceSecretsMasterKey?: string;
  /** Optional: inject a fake GitHubAppClient for tests; overrides octokit. */
  githubAppClient?: GitHubAppClient;
  /**
   * `configured` to be true; otherwise the Slack routes 503 and the
   * settings UI shows a "not configured" panel.
   */
  slackPlatformClientId?: string;
  slackPlatformClientSecret?: string;
  slackPlatformSigningSecret?: string;
  /**
   * NATS connection the api reuses for provider request/reply
   * (collections provision/deprovision today; more tomorrow). Optional:
   * when absent the collection create/delete endpoints return
   * provider_unavailable.
   */
  natsConnection?: NatsConnection;
  /**
   * Kubernetes config for shared-agent-resources install / minter calls.
   * When absent, the Install route returns 501 for kinds that need K8s.
   * Kept optional so local dev without a cluster keeps booting.
   */
  kubeConfig?: k8s.KubeConfig;
  /**
   * Namespace where shared-agent-resource StatefulSets and their Secrets
   * go. v1 reuses the platform's main namespace; per-workspace namespaces
   * are a future enhancement.
   */
  sharedResourcesNamespace?: string;
}

export function compose(env: CompositionEnv): Composition {
  const users = new PostgresUserRepository(env.sql);
  const persons = new PostgresPersonRepository(env.sql);
  const linkAttempts = new PostgresLinkAttemptStore(env.sql);
  const passwords = new PostgresPasswordCredentialStore(env.sql);
  const workspaces = new PostgresWorkspaceRepository(env.sql);
  const memberships = new PostgresMembershipRepository(env.sql);
  const invitations = new PostgresInvitationRepository(env.sql);
  const agents = new PostgresAgentRepository(env.sql);
  const sessions = new PostgresSessionRepository(env.sql);
  const sessionEvents = new PostgresSessionEventRepository(env.sql);
  const sessionShares = new PostgresSessionShareRepository(env.sql);
  const tokenUsage = new PostgresTokenUsageRepository(env.sql);
  const permissionGrants = new PostgresPermissionGrantRepository(env.sql);
  const collectionsRepo = new PostgresCollectionRepository(env.sql);
  const installations = new PostgresInstallationRepository(env.sql);
  const agentRepos = new PostgresAgentRepoStore(env.sql);
  const tokenizer = new JwtSessionTokenizer({ secret: env.jwtSecret });

  const google = new GoogleAuthProvider({
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    scopes: env.googleScopes,
  });

  let bypass: AuthProvider | undefined;
  if (env.authBypass) {
    if (!env.testUserEmail) {
      throw new Error(
        "AUTH_BYPASS=true but TEST_USER is not set; refusing to enable bypass",
      );
    }
    bypass = new DevBypassAuthProvider({
      email: env.testUserEmail,
      name: env.testUserEmail,
    });
  }

  // GitHub App client — either the test fake or the real Octokit-backed one.
  // Octokit construction is gated on presence of all three values to keep
  // early local dev working before the user has set up the App.
  const githubClient: GitHubAppClient | null =
    env.githubAppClient ??
    (env.githubAppId && env.githubAppPrivateKey && env.githubAppSlug
      ? new OctokitGitHubAppClient({
          appId: Number(env.githubAppId),
          privateKey: env.githubAppPrivateKey,
          appSlug: env.githubAppSlug,
        })
      : null);

  const authRoutes = createAuthRoutes({
    authProvider: google,
    users,
    tokenizer,
    appUrl: env.appUrl,
    apiUrl: env.apiUrl,
    allowedDomains: env.allowedDomains,
    platformAdmins: env.platformAdmins,
    // Lets emails outside the domain whitelist sign in if they have a
    // pending invitation or an existing user row. Always wired in
    // prod; the in-memory tests still use the in-memory fake or skip
    // accessGate entirely.
    accessGate: new PostgresAccessGate(env.sql),
    bypassProvider: bypass,
    persons,
    linkAttempts,
    passwords,
    clock: systemClock,
  });

  const requireAuth = createRequireAuth(tokenizer);
  const getActor = (c: Context) => {
    const session = c.get("session");
    if (!session) return null;
    return {
      userId: session.userId as UserId,
      email: session.email as Email,
    };
  };

  const invitationConfig = {
    invitations,
    workspaces: new WorkspaceReaderAdapter(workspaces, env.sql),
    adminGuard: new WorkspaceAdminGuard(memberships),
    memberships: new MembershipGrantorAdapter(memberships),
    tokens: new CryptoTokenGenerator(),
    clock: systemClock,
    requireAuth,
    getActor,
  };

  const workspaceInvitationRoutes =
    createWorkspaceInvitationRoutes(invitationConfig);
  const publicInvitationRoutes =
    createPublicInvitationRoutes(invitationConfig);

  const resolveWorkspace = async (slug: ReturnType<typeof WorkspaceSlug>) => {
    const w = await workspaces.findBySlug(slug);
    return w?.id ?? null;
  };

  const agentRoutes = createAgentRoutes({
    agents,
    adminGuard: new WorkspaceAdminGuard(memberships),
    resolveWorkspace: async (slug) => resolveWorkspace(WorkspaceSlug(slug)),
    requireAuth,
    getActor,
    // Strict mode mirrors the dropdown: agent.model must be in the
    // admin-enabled set. Empty set rejects every model — users fall
    // back to the deployment-wide ANTHROPIC_MODEL default until an
    // admin curates at /admin/anthropic-models.
    enabledModels: async () => listEnabledOverrides(env.sql),
  });

  const sessionsConfig = {
    agents,
    sessions,
    events: sessionEvents,
    adminGuard: new WorkspaceAdminGuard(memberships),
    // Lets non-admin sharees read sessions they were granted; without
    // this the only ways through loadScoped are owner + admin.
    shares: sessionShares,
    resolveWorkspace: async (slug: string) =>
      resolveWorkspace(WorkspaceSlug(slug)),
    requireAuth,
    getActor,
    clock: systemClock,
  };
  const sessionRoutes = createSessionRoutes(sessionsConfig);
  const workspaceSessionRoutes = createWorkspaceSessionRoutes(sessionsConfig);
  const workspaceTokenUsageRoutes = createWorkspaceTokenUsageRoutes({
    tokenUsage,
    adminGuard: new WorkspaceAdminGuard(memberships),
    resolveWorkspace: async (slug) => resolveWorkspace(WorkspaceSlug(slug)),
    requireAuth,
    getActor,
  });

  // POST /api/workspaces — platform-admin-only. Used by NoAccessRoot's
  // "Create your first workspace" CTA on a fresh install. Auth gating
  // (platform admin check) lives inside createWorkspace, not here.
  const workspaceCreateRoutes = createWorkspaceRoutes({
    workspaces,
    memberships,
    platformAdmins: env.platformAdmins,
    requireAuth,
    getActor,
    // Refresh the caller's JWT after they create a workspace so the
    // brand-new owner-membership row shows up in their session
    // immediately. Without this the next /workspaces/<slug> request
    // 403s because the auth middleware reads memberships from the
    // JWT, which was minted at sign-in time when there were none.
    // Cookie attributes match the auth domain's set elsewhere.
    refreshSessionForUser: async (userId, email) => {
      const user = await users.findById(userId);
      if (!user) throw new Error(`user ${userId} not found`);
      const freshMemberships = await users.listMemberships(userId);
      const newSession = {
        userId: user.id,
        email: user.email,
        name: user.name,
        memberships: freshMemberships,
        isPlatformAdmin: isEmailPlatformAdmin(
          user.email,
          env.platformAdmins,
        ),
      };
      const token = tokenizer.sign(newSession);
      const maxAge = 60 * 60 * 24;
      return [
        `x1_session=${token}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${maxAge}`,
      ].join("; ");
    },
  });

  const workspaceShareRoutes = createWorkspaceShareRoutes({
    sessions,
    events: sessionEvents,
    agents,
    adminGuard: new WorkspaceAdminGuard(memberships),
    resolveWorkspace: async (slug) => resolveWorkspace(WorkspaceSlug(slug)),
    requireAuth,
    getActor,
    gcsArtifactsBucket: process.env.GCS_ARTIFACTS_BUCKET || undefined,
  });

  const workspaceSharesIndexRoutes = createWorkspaceSharesIndexRoutes({
    sql: env.sql,
    adminGuard: new WorkspaceAdminGuard(memberships),
    resolveWorkspace: async (slug) => resolveWorkspace(WorkspaceSlug(slug)),
    requireAuth,
    getActor,
  });

  const sessionShareRoutes = createSessionShareRoutes({
    sessions,
    shares: sessionShares,
    findUserIdByEmail: async (email) => {
      const u = await users.findByEmail(email as Email);
      return u?.id ?? null;
    },
    isWorkspaceAdmin: async (userId, workspaceId) => {
      const m = await memberships.findByUserAndWorkspace(userId, workspaceId);
      return m?.role === "admin" || m?.role === "owner";
    },
    resolveWorkspace: async (slug) => resolveWorkspace(WorkspaceSlug(slug)),
    requireAuth,
    getActor,
  });

  const tickScheduler = () =>
    scheduleDueSessions({
      agents,
      sessions,
      clock: systemClock,
      injector: env.natsConnection
        ? new NatsMessageInjector(env.natsConnection)
        : undefined,
    });

  // One QuietHintStore shared between the internal route that
  // receives `expect_quiet_for` from children and the watchdog
  // that consults them. Lives on the api process in-memory.
  const quietHints = new QuietHintStore();

  const internalRoutes = createInternalRoutes({
    events: sessionEvents,
    sessions,
    agents,
    grants: permissionGrants,
    githubClient,
    internalToken: env.internalToken ?? "",
    natsConnection: env.natsConnection,
    quietHints,
    sql: env.sql,
  });

  // If the GitHub App isn't configured, return stub routes that 503 so
  // boot doesn't fail. Frontend reads /auth/github/config to check.
  const githubRoutesConfig = githubClient
    ? {
        client: githubClient,
        installations,
        agentRepos,
        appUrl: env.appUrl,
        requireAuth,
        getActor,
      }
    : null;

  const unconfigured = (route: string) => {
    const app = new (require("hono").Hono)();
    app.all("*", (c: Context) =>
      c.json({ error: "github_not_configured", route }, 503),
    );
    return app;
  };

  const githubInstallRoutes = githubRoutesConfig
    ? createGitHubInstallRoutes(githubRoutesConfig)
    : unconfigured("/auth/github");
  const installationApiRoutes = githubRoutesConfig
    ? createInstallationApiRoutes(githubRoutesConfig)
    : unconfigured("/api/installations");
  const agentRepoRoutes = githubRoutesConfig
    ? createAgentRepoRoutes(githubRoutesConfig)
    : unconfigured("/api/workspaces/:slug/agents/:agentId/repos");

  const workspaceGrantRoutes = createWorkspaceGrantRoutes({
    grants: permissionGrants,
    adminGuard: new WorkspaceAdminGuard(memberships),
    workspaces: new WorkspaceReaderAdapter(workspaces, env.sql),
    requireAuth,
    getActor,
  });

  // Workspace secret store. The master key is loaded once at compose
  // time and held in memory for the life of the process. Decryption
  // happens only inside the SecretService — repository never sees it.
  const workspaceSecretsRepo = new PostgresSecretRepository(env.sql);
  const workspaceSecretsKey = loadMasterKey(
    env.workspaceSecretsMasterKey ?? process.env.WORKSPACE_SECRETS_MASTER_KEY,
  );
  const workspaceSecretsService = new SecretService(
    workspaceSecretsRepo,
    workspaceSecretsKey,
  );
  const workspaceSecretsRoutes = createWorkspaceSecretsRoutes({
    service: workspaceSecretsService,
    requireAuth,
  });

  // Slack composition. Reuses workspaceSecretsKey for bot-token
  // encryption — single key concern across the secret-bearing
  // surfaces. Routes degrade to 503 stubs when the platform-app
  // credentials are not configured; the frontend reads `configured`
  // off /api/workspaces/:slug/slack/bots and shows the "operator
  // setup needed" panel in that case.
  const slackResolveWorkspace = async (
    actor: ReturnType<typeof UserId>,
    slug: string,
  ) => {
    const ws = await workspaces.findBySlug(WorkspaceSlug(slug));
    if (!ws) return null;
    const membership = await memberships.findByUserAndWorkspace(actor, ws.id);
    if (!membership) return null;
    return {
      id: ws.id,
      canManage: membership.role === "admin" || membership.role === "owner",
    };
  };
  const slackComposed = composeSlack(
    {
      apiUrl: env.apiUrl,
      appUrl: env.appUrl,
      sql: env.sql,
      workspaceSecretsKey,
      platformClientId: env.slackPlatformClientId,
      platformClientSecret: env.slackPlatformClientSecret,
      platformSigningSecret: env.slackPlatformSigningSecret,
    },
    {
      requireAuth,
      getActor,
      resolveWorkspace: slackResolveWorkspace,
    },
  );
  const slackOAuthRoutes = slackComposed.oauthRoutes;
  const slackBotApiRoutes = slackComposed.botApiRoutes;
  const slackEventsRoutes = slackComposed.eventsRoutes;

  // MCP catalog: workspace admin registers MCP servers here. Three
  // shapes: stdio image, stdio command (npx/uvx), remote_oauth.
  // The remote_oauth path runs RFC 9728/8414 discovery + RFC 7591 DCR
  // server-side at registration time — store the issued client_secret
  // encrypted with the workspace_secrets master key.
  const mcpCatalogRepo = new PostgresCatalogRepository(env.sql);
  const mcpAttachmentRepo = new PostgresAttachmentRepository(env.sql);
  const mcpOAuthClientRepo = new PostgresOAuthClientRepository(env.sql);
  // Shared so DCR-time registration and token-exchange-time redirect_uri
  // are byte-identical. RFC 6749 §4.1.3 rejects the exchange otherwise.
  // Path order matches the Hono route mount: /auth/mcp/callback/:slug/:name.
  const mcpRedirectUriFor = ({
    workspaceSlug,
    catalogName,
  }: {
    workspaceSlug: string;
    catalogName: string;
  }) =>
    `${env.apiUrl}/auth/mcp/callback/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(catalogName)}`;
  const catalogService = new CatalogService(mcpCatalogRepo, {
    workspaceSlugFor: async (workspaceId: string) => {
      const w = await workspaces.findById(workspaceId as never);
      return w?.slug ?? null;
    },
    redirectUriFor: mcpRedirectUriFor,
    cipherKey: workspaceSecretsKey,
    oauthClients: mcpOAuthClientRepo,
  });
  const attachmentService = new AttachmentService(
    mcpAttachmentRepo,
    mcpCatalogRepo,
  );
  const mcpCatalogRoutes = createMcpCatalogRoutes({
    catalog: catalogService,
    requireAuth,
  });

  // Per-agent middleware: validates that :slug + :agentId pair is real,
  // the user is admin/owner of that workspace, and stashes workspaceId
  // + userId for downstream handlers. Used by both MCP attachments and
  // Zone-2 env bindings — they share the same auth posture: only admins
  // can edit the credentials and tools an agent runs with.
  const requireAgent: import("hono").MiddlewareHandler = async (c, next) => {
    const session = c.get("session") as
      | {
          email: string;
          userId: string | null;
          memberships: readonly { slug: string; workspaceId: string; role: string }[];
        }
      | undefined;
    if (!session?.email) return c.json({ error: "unauthenticated" }, 401);
    const slug = c.req.param("slug");
    const agentId = c.req.param("agentId");
    if (!slug) return c.json({ error: "missing workspace slug" }, 400);
    if (!agentId) return c.json({ error: "missing agent id" }, 400);
    const m = session.memberships.find((x) => x.slug === slug);
    if (!m) return c.json({ error: "forbidden" }, 403);
    if (m.role !== "admin" && m.role !== "owner") {
      return c.json({ error: "forbidden" }, 403);
    }
    // Confirm agent belongs to the workspace before any write. Cheap
    // guard against UI bugs that would otherwise let an admin in
    // workspace A mutate an agent in workspace B by URL guessing.
    const agent = await agents.findById(agentId as never);
    if (!agent || (agent.workspaceId as unknown as string) !== m.workspaceId) {
      return c.json({ error: "agent not found" }, 404);
    }
    c.set("workspaceId", m.workspaceId);
    c.set("userId", session.userId);
    // Surface agent kind so downstream routes can apply
    // kind-specific policy (remote_oauth MCPs require worker).
    c.set(
      "agentKind",
      (agent.kind as "worker" | "orchestrator" | "scheduled") ?? "worker",
    );
    await next();
  };

  const agentMcpAttachmentRoutes = createAgentMcpAttachmentRoutes({
    attachments: attachmentService,
    requireAuth,
    requireAgent,
  });

  // Per-user OAuth flow for remote_oauth MCPs. Tokens encrypt under
  // the same workspace_secrets master key. Flow state cookie is
  // signed with the same JWT_SECRET used for session cookies — short
  // TTL (5 min, set by the route) bounds replay risk.
  const userTokenRepo = new PostgresUserTokenRepository(env.sql);
  const userTokenService = new UserTokenService({
    catalog: mcpCatalogRepo,
    oauthClients: mcpOAuthClientRepo,
    userTokens: userTokenRepo,
    cipherKey: workspaceSecretsKey,
    redirectUriFor: mcpRedirectUriFor,
    workspaceSlugFor: async (workspaceId: string) => {
      const w = await workspaces.findById(workspaceId as never);
      return w?.slug ?? null;
    },
  });

  // Workspace-membership middleware reused by both OAuth redirect
  // routes — ensures the caller is a member of the slug they're
  // operating against and stashes workspaceId for the handler.
  const requireWorkspaceMembership: import("hono").MiddlewareHandler = async (
    c,
    next,
  ) => {
    const session = c.get("session") as
      | {
          email: string;
          userId: string | null;
          memberships: readonly { slug: string; workspaceId: string; role: string }[];
        }
      | undefined;
    if (!session?.email) return c.json({ error: "unauthenticated" }, 401);
    const slug = c.req.param("slug");
    if (!slug) return c.json({ error: "missing slug" }, 400);
    const m = session.memberships.find((x) => x.slug === slug);
    if (!m) return c.json({ error: "forbidden" }, 403);
    c.set("workspaceId", m.workspaceId);
    c.set("userId", session.userId);
    await next();
  };

  const FLOW_TOKEN_TTL_S = 300;
  const mcpOAuthRoutes = createMcpOAuthRoutes({
    service: userTokenService,
    requireAuth,
    requireWorkspaceMembership,
    appUrl: env.appUrl,
    signFlowState: (state: OAuthFlowState) =>
      jwt.sign({ flow: state }, env.jwtSecret, {
        expiresIn: FLOW_TOKEN_TTL_S,
      }),
    verifyFlowState: (token: string) => {
      try {
        const decoded = jwt.verify(token, env.jwtSecret) as {
          flow?: OAuthFlowState;
        };
        return decoded.flow ?? null;
      } catch {
        return null;
      }
    },
  });
  const mcpUserTokenRoutes = createMcpUserTokenRoutes({
    service: userTokenService,
    requireAuth,
  });

  // Zone-2 agent env bindings. The SecretExistsCheck reads through the
  // workspace_secrets repository; failing here means a binding rotation
  // tried to point at a secret that no longer exists.
  const bindingRepo = new PostgresBindingRepository(env.sql);
  const bindingService = new BindingService(
    bindingRepo,
    async (workspaceId, secretName) => {
      const blob = await workspaceSecretsRepo.getBlob(
        workspaceId,
        // Cast through unknown to satisfy SecretName brand without
        // re-validating: BindingService already validated the name.
        secretName as unknown as Parameters<typeof workspaceSecretsRepo.getBlob>[1],
      );
      return blob !== null;
    },
  );
  const agentEnvRoutes = createAgentEnvRoutes({
    service: bindingService,
    requireAuth,
    requireAgent,
  });

  const collectionsWorkspaceReader: CollectionsWorkspaceReader = {
    async getIdBySlug(slug) {
      const w = await workspaces.findBySlug(slug);
      return w?.id ?? null;
    },
    async getSlugById(id) {
      const w = await workspaces.findById(id);
      return w ? (w.slug as WorkspaceSlug) : null;
    },
  };

  const providerGateway = env.natsConnection
    ? new NatsProviderGateway(env.natsConnection)
    : null;
  const providerUnavailable = () => {
    throw Object.assign(new Error("NATS not connected; provider unavailable"), {
      code: "provider_unavailable",
    });
  };
  const providerGatewayUnavailable = {
    async provision() {
      providerUnavailable();
    },
    async deprovision() {
      providerUnavailable();
    },
    async discover() {
      providerUnavailable();
      return [];
    },
    async listRecords() {
      providerUnavailable();
      return [];
    },
  };

  const sharedResources = new PostgresSharedResourceRepository(env.sql);
  const postgresBranches = new PostgresPostgresBranchRepository(env.sql);
  const redisBranches = new PostgresRedisBranchRepository(env.sql);
  const postgresProvisioner: PostgresAdminProvisioner | null = env.kubeConfig
    ? new StatefulSetPostgresAdminProvisioner(env.kubeConfig)
    : null;
  const postgresMinter: PostgresBranchMinter | null = env.kubeConfig
    ? new StatefulSetPostgresBranchMinter(env.kubeConfig)
    : null;
  const redisProvisioner: RedisAdminProvisioner | null = env.kubeConfig
    ? new StatefulSetRedisAdminProvisioner(env.kubeConfig)
    : null;
  const redisMinter: RedisBranchMinter | null = env.kubeConfig
    ? new StatefulSetRedisBranchMinter(env.kubeConfig)
    : null;

  const installers: Partial<Record<SharedResourceKind, KindInstaller>> = {};
  const uninstallers: Partial<Record<SharedResourceKind, KindUninstaller>> = {};
  const branchResetters: Partial<Record<SharedResourceKind, BranchResetter>> = {};

  if (postgresProvisioner) {
    installers.postgres = async (req): Promise<SharedResource> =>
      installPostgres(sharedResources, postgresProvisioner, {
        workspaceId: req.workspaceId,
        namespace: req.namespace,
        version: req.version,
        storageSize: (req.config.storage_size as string) ?? "20Gi",
        installedBy: req.installedBy,
      });
    uninstallers.postgres = async (resource) => {
      const branches =
        await postgresBranches.listActiveByResource(resource.id);
      if (postgresMinter) {
        for (const b of branches) {
          await postgresMinter
            .revokeBranch({
              resource,
              namespace: env.sharedResourcesNamespace ?? "x1agent",
              branchId: b.branchId,
            })
            .catch(() => undefined);
          await postgresBranches.markReaped(b.id).catch(() => undefined);
        }
      }
      await postgresProvisioner.uninstall(
        resource,
        env.sharedResourcesNamespace ?? "x1agent",
      );
    };
    if (postgresMinter) {
      branchResetters.postgres = async ({ resource, branchId }) => {
        // Drop then remint. The mint path ensures CREATE DATABASE
        // from the main template again.
        await postgresMinter.revokeBranch({
          resource,
          namespace: env.sharedResourcesNamespace ?? "x1agent",
          branchId,
        });
      };
    }
  }

  if (redisProvisioner) {
    installers.redis = async (req): Promise<SharedResource> =>
      installRedis(sharedResources, redisProvisioner, {
        workspaceId: req.workspaceId,
        namespace: req.namespace,
        version: req.version,
        storageSize: (req.config.storage_size as string) ?? "5Gi",
        installedBy: req.installedBy,
      });
    uninstallers.redis = async (resource) => {
      const branches = await redisBranches.listActiveByResource(resource.id);
      if (redisMinter) {
        for (const b of branches) {
          await redisMinter
            .revokeBranch({
              resource,
              namespace: env.sharedResourcesNamespace ?? "x1agent",
              branchId: b.branchId,
            })
            .catch(() => undefined);
          await redisBranches.markReaped(b.id).catch(() => undefined);
        }
      }
      await redisProvisioner.uninstall(
        resource,
        env.sharedResourcesNamespace ?? "x1agent",
      );
    };
    if (redisMinter) {
      branchResetters.redis = async ({ resource, branchId }) => {
        await redisMinter.revokeBranch({
          resource,
          namespace: env.sharedResourcesNamespace ?? "x1agent",
          branchId,
        });
      };
    }
  }

  const workspaceImageCatalogRoutes = createWorkspaceImageCatalogRoutes({
    sql: env.sql,
    resolveWorkspace: async (slug) => resolveWorkspace(slug),
    requireAuth,
    getActor,
  });

  const sharedAgentResourcesRoutes = createSharedAgentResourcesRoutes({
    resources: sharedResources,
    installers,
    uninstallers,
    branchResetters,
    findBranchId: async ({ kind, resourceId, repoFullName, branchName }) => {
      if (kind === "postgres") {
        const row = await postgresBranches.find({
          resourceId: resourceId as never,
          repoFullName,
          branchName,
        });
        return row?.branchId ?? null;
      }
      if (kind === "redis") {
        const row = await redisBranches.find({
          resourceId: resourceId as never,
          repoFullName,
          branchName,
        });
        return row?.branchId ?? null;
      }
      return null;
    },
    adminGuard: new WorkspaceAdminGuard(memberships),
    resolveWorkspace: async (slug) => resolveWorkspace(slug),
    workspaceNamespace: env.sharedResourcesNamespace ?? "x1agent",
    requireAuth,
    getActor,
  });

  const collectionRoutes = createCollectionRoutes({
    collections: collectionsRepo,
    adminGuard: new WorkspaceAdminGuard(memberships),
    providers: providerGateway ?? providerGatewayUnavailable,
    workspaces: collectionsWorkspaceReader,
    requireAuth,
    getActor,
  });
  const agentCollectionRoutes = createAgentCollectionRoutes({
    collections: collectionsRepo,
    adminGuard: new WorkspaceAdminGuard(memberships),
    workspaces: collectionsWorkspaceReader,
    requireAuth,
    getActor,
  });

  const adminAnthropicModelsRoutes = createAdminAnthropicModelsRoutes({
    sql: env.sql,
    platformAdmins: env.platformAdmins,
    requireAuth,
  });

  const adminWorkspacesRoutes = createAdminWorkspacesRoutes({
    sql: env.sql,
    platformAdmins: env.platformAdmins,
    requireAuth,
  });

  return {
    authRoutes,
    workspaceInvitationRoutes,
    publicInvitationRoutes,
    workspaceCreateRoutes,
    agentRoutes,
    sessionRoutes,
    workspaceSessionRoutes,
    workspaceTokenUsageRoutes,
    workspaceShareRoutes,
    sessionShareRoutes,
    workspaceSharesIndexRoutes,
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
    adminAnthropicModelsRoutes,
    adminWorkspacesRoutes,
    sharedResources,
    postgresBranches,
    postgresProvisioner,
    postgresMinter,
    redisBranches,
    redisProvisioner,
    redisMinter,
    tokenizer,
    users,
    sessionEvents,
    tokenUsage,
    agentEnvBindings: bindingRepo,
    workspaceSecrets: workspaceSecretsService,
    mcpAttachments: mcpAttachmentRepo,
    mcpCatalog: mcpCatalogRepo,
    userTokenService,
    sql: env.sql,
    agents,
    sessions,
    permissionGrants,
    collections: collectionsRepo,
    agentRepoStore: agentRepos,
    tickScheduler,
    quietHints,
  };
}
