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

export interface Composition {
  authRoutes: Hono;
  workspaceInvitationRoutes: Hono;
  publicInvitationRoutes: Hono;
  agentRoutes: Hono;
  tokenizer: SessionTokenizer;
  users: UserRepository;
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
}

export function compose(env: CompositionEnv): Composition {
  const users = new PostgresUserRepository(env.sql);
  const persons = new PostgresPersonRepository(env.sql);
  const linkAttempts = new PostgresLinkAttemptStore(env.sql);
  const workspaces = new PostgresWorkspaceRepository(env.sql);
  const memberships = new PostgresMembershipRepository(env.sql);
  const invitations = new PostgresInvitationRepository(env.sql);
  const agents = new PostgresAgentRepository(env.sql);
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

  const agentRoutes = createAgentRoutes({
    agents,
    adminGuard: new WorkspaceAdminGuard(memberships),
    resolveWorkspace: async (slug) => {
      const w = await workspaces.findBySlug(WorkspaceSlug(slug));
      return w?.id ?? null;
    },
    requireAuth,
    getActor,
  });

  return {
    authRoutes,
    workspaceInvitationRoutes,
    publicInvitationRoutes,
    agentRoutes,
    tokenizer,
    users,
  };
}
