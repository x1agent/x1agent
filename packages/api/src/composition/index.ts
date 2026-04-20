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

export interface Composition {
  authRoutes: Hono;
  workspaceInvitationRoutes: Hono;
  publicInvitationRoutes: Hono;
  agentRoutes: Hono;
  sessionRoutes: Hono;
  workspaceSessionRoutes: Hono;
  workspaceShareRoutes: Hono;
  workspaceSharesIndexRoutes: Hono;
  internalRoutes: Hono;
  githubInstallRoutes: Hono;
  installationApiRoutes: Hono;
  agentRepoRoutes: Hono;
  workspaceGrantRoutes: Hono;
  collectionRoutes: Hono;
  agentCollectionRoutes: Hono;
  sharedAgentResourcesRoutes: Hono;
  workspaceImageCatalogRoutes: Hono;
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
  /** Exposed for the Job watcher — reads directly without reconnecting. */
  sql: postgres.Sql<Record<string, unknown>>;
  agents: PostgresAgentRepository;
  sessions: PostgresSessionRepository;
  permissionGrants: PostgresPermissionGrantRepository;
  collections: PostgresCollectionRepository;
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
  const workspaces = new PostgresWorkspaceRepository(env.sql);
  const memberships = new PostgresMembershipRepository(env.sql);
  const invitations = new PostgresInvitationRepository(env.sql);
  const agents = new PostgresAgentRepository(env.sql);
  const sessions = new PostgresSessionRepository(env.sql);
  const sessionEvents = new PostgresSessionEventRepository(env.sql);
  const permissionGrants = new PostgresPermissionGrantRepository(env.sql);
  const collectionsRepo = new PostgresCollectionRepository(env.sql);
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

  const tickScheduler = () =>
    scheduleDueSessions({ agents, sessions, clock: systemClock });

  const internalRoutes = createInternalRoutes({
    events: sessionEvents,
    sessions,
    agents,
    grants: permissionGrants,
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

  return {
    authRoutes,
    workspaceInvitationRoutes,
    publicInvitationRoutes,
    agentRoutes,
    sessionRoutes,
    workspaceSessionRoutes,
    workspaceShareRoutes,
    workspaceSharesIndexRoutes,
    internalRoutes,
    githubInstallRoutes,
    installationApiRoutes,
    agentRepoRoutes,
    workspaceGrantRoutes,
    collectionRoutes,
    agentCollectionRoutes,
    sharedAgentResourcesRoutes,
    workspaceImageCatalogRoutes,
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
    sql: env.sql,
    agents,
    sessions,
    permissionGrants,
    collections: collectionsRepo,
    agentRepoStore: agentRepos,
    tickScheduler,
  };
}
