import {
  GoogleAuthProvider,
  DevBypassAuthProvider,
  JwtSessionTokenizer,
  PostgresUserRepository,
  PostgresPersonRepository,
  PostgresLinkAttemptStore,
  createAuthRoutes,
  createRequireAuth,
  type AuthProvider,
  type UserRepository,
  type SessionTokenizer,
} from "@x1agent/domain-auth";
import {
  PostgresMembershipRepository,
  PostgresWorkspaceRepository,
} from "@x1agent/domain-workspaces";
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
  createSessionRoutes,
  createWorkspaceSessionRoutes,
  scheduleDueSessions,
  type ScheduleDueSessionsResult,
  type SessionEventRepository,
} from "@x1agent/domain-sessions";
import {
  PostgresPermissionGrantRepository,
  createWorkspaceGrantRoutes,
} from "@x1agent/domain-permissions";
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

export interface Composition {
  authRoutes: Hono;
  workspaceInvitationRoutes: Hono;
  publicInvitationRoutes: Hono;
  agentRoutes: Hono;
  sessionRoutes: Hono;
  workspaceSessionRoutes: Hono;
  internalRoutes: Hono;
  githubInstallRoutes: Hono;
  installationApiRoutes: Hono;
  agentRepoRoutes: Hono;
  workspaceGrantRoutes: Hono;
  tokenizer: SessionTokenizer;
  users: UserRepository;
  /** For the NATS subscriber to persist events as they fly by. */
  sessionEvents: SessionEventRepository;
  /** Exposed for the Job watcher — reads directly without reconnecting. */
  sql: postgres.Sql<Record<string, unknown>>;
  agents: PostgresAgentRepository;
  sessions: PostgresSessionRepository;
  agentRepoStore: PostgresAgentRepoStore;
  /** Run one scheduler tick. Exposed so callers can wire it to setInterval. */
  tickScheduler: () => Promise<ScheduleDueSessionsResult>;
}

export interface CompositionEnv {
  sql: postgres.Sql<Record<string, unknown>>;
  jwtSecret: string;
  googleClientId: string;
  googleClientSecret: string;
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
  /** Optional: inject a fake GitHubAppClient for tests; overrides octokit. */
  githubAppClient?: GitHubAppClient;
}

export function compose(env: CompositionEnv): Composition {
  const users = new PostgresUserRepository(env.sql);
  const persons = new PostgresPersonRepository(env.sql);
  const linkAttempts = new PostgresLinkAttemptStore(env.sql);
  const workspaces = new PostgresWorkspaceRepository(env.sql);
  const memberships = new PostgresMembershipRepository(env.sql);
  const invitations = new PostgresInvitationRepository(env.sql);
  const agents = new PostgresAgentRepository(env.sql);
  const sessions = new PostgresSessionRepository(env.sql);
  const sessionEvents = new PostgresSessionEventRepository(env.sql);
  const permissionGrants = new PostgresPermissionGrantRepository(env.sql);
  const installations = new PostgresInstallationRepository(env.sql);
  const agentRepos = new PostgresAgentRepoStore(env.sql);
  const tokenizer = new JwtSessionTokenizer({ secret: env.jwtSecret });

  const google = new GoogleAuthProvider({
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
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
    bypassProvider: bypass,
    persons,
    linkAttempts,
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
  });

  const sessionsConfig = {
    agents,
    sessions,
    events: sessionEvents,
    adminGuard: new WorkspaceAdminGuard(memberships),
    resolveWorkspace: async (slug: string) =>
      resolveWorkspace(WorkspaceSlug(slug)),
    requireAuth,
    getActor,
    clock: systemClock,
  };
  const sessionRoutes = createSessionRoutes(sessionsConfig);
  const workspaceSessionRoutes = createWorkspaceSessionRoutes(sessionsConfig);

  const tickScheduler = () =>
    scheduleDueSessions({ agents, sessions, clock: systemClock });

  const internalRoutes = createInternalRoutes({
    events: sessionEvents,
    githubClient,
    internalToken: env.internalToken ?? "",
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

  return {
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
    tokenizer,
    users,
    sessionEvents,
    sql: env.sql,
    agents,
    sessions,
    agentRepoStore: agentRepos,
    tickScheduler,
  };
}
