import { Hono, type MiddlewareHandler } from "hono";
import {
  DomainError,
  UserId,
  WorkspaceSlug,
  type Email,
  type WorkspaceId,
} from "@x1agent/kernel";
import { AgentId } from "@x1agent/domain-agents";
import { SessionId } from "@x1agent/domain-sessions";
import { createGrant } from "../../application/create-grant.js";
import { revokeGrant } from "../../application/revoke-grant.js";
import { listGrants } from "../../application/list-grants.js";
import {
  GrantId,
  GrantScope,
  GrantType,
  type Grant,
  type GrantSubject,
} from "../../domain/grant.js";
import type { PermissionGrantRepository } from "../../ports/permission-grant-repository.js";
import type { AdminGuard } from "../../ports/admin-guard.js";

export interface WorkspaceReader {
  getIdBySlug(slug: WorkspaceSlug): Promise<WorkspaceId | null>;
}

export interface GrantRoutesConfig {
  grants: PermissionGrantRepository;
  adminGuard: AdminGuard;
  workspaces: WorkspaceReader;
  requireAuth: MiddlewareHandler;
  getActor: (
    c: Parameters<MiddlewareHandler>[0],
  ) => { userId: UserId; email: Email } | null;
}

function serializeGrant(g: Grant) {
  return {
    id: g.id,
    workspace_id: g.workspaceId,
    user_subject_id:
      g.subject.kind === "user" ? g.subject.userId : null,
    agent_subject_id:
      g.subject.kind === "agent" ? g.subject.agentId : null,
    grant_type: g.grantType,
    details: g.details,
    scope: g.scope,
    session_id: g.sessionId,
    consumed_at: g.consumedAt?.toISOString() ?? null,
    revoked_at: g.revokedAt?.toISOString() ?? null,
    granted_by_user_id: g.grantedByUserId,
    granted_at: g.grantedAt.toISOString(),
    reason: g.reason,
  };
}

function domainErrorStatus(err: unknown): number {
  if (err instanceof DomainError) {
    switch (err.code) {
      case "grant_not_found":
        return 404;
      case "grant_wrong_workspace":
      case "admin_denied":
      case "not_a_member":
      case "insufficient_role":
        return 403;
      case "session_scope_requires_session_id":
      case "non_session_scope_rejects_session_id":
      case "invalid_grant_shape":
        return 400;
      default:
        return 400;
    }
  }
  return 500;
}

function domainErrorBody(err: unknown) {
  if (err instanceof DomainError)
    return { error: err.code, message: err.message };
  return { error: "internal_error", message: "unexpected failure" };
}

interface CreateBody {
  user_subject_id?: string | null;
  agent_subject_id?: string | null;
  grant_type?: string;
  details?: unknown;
  scope?: string;
  session_id?: string | null;
  reason?: string | null;
}

function parseSubject(body: CreateBody): GrantSubject | { error: string } {
  const hasUser = typeof body.user_subject_id === "string";
  const hasAgent = typeof body.agent_subject_id === "string";
  if (hasUser === hasAgent)
    return { error: "exactly_one_of_user_subject_id_or_agent_subject_id" };
  if (hasUser) return { kind: "user", userId: UserId(body.user_subject_id!) };
  return { kind: "agent", agentId: AgentId(body.agent_subject_id!) };
}

export function createWorkspaceGrantRoutes(cfg: GrantRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  const resolveWs = async (slug: string) => {
    try {
      return await cfg.workspaces.getIdBySlug(WorkspaceSlug(slug));
    } catch {
      return null;
    }
  };

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    const userSubjectId = c.req.query("user_subject_id");
    const agentSubjectId = c.req.query("agent_subject_id");
    const grantTypeQ = c.req.query("grant_type");
    const includeRevoked = c.req.query("include_revoked") === "true";

    let subject: GrantSubject | undefined;
    if (userSubjectId && agentSubjectId)
      return c.json(
        { error: "exactly_one_of_user_subject_id_or_agent_subject_id" },
        400,
      );
    if (userSubjectId)
      subject = { kind: "user", userId: UserId(userSubjectId) };
    if (agentSubjectId)
      subject = { kind: "agent", agentId: AgentId(agentSubjectId) };

    try {
      const rows = await listGrants(
        { grants: cfg.grants, adminGuard: cfg.adminGuard },
        {
          actor: actor.userId,
          workspaceId: wsId,
          subject,
          grantType: grantTypeQ ? GrantType(grantTypeQ) : undefined,
          includeRevoked,
        },
      );
      return c.json({ grants: rows.map(serializeGrant) });
    } catch (err) {
      return c.json(domainErrorBody(err), domainErrorStatus(err) as 400);
    }
  });

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    const body = await c.req.json<CreateBody>().catch(() => ({}) as CreateBody);
    const subject = parseSubject(body);
    if ("error" in subject) return c.json(subject, 400);
    if (!body.grant_type) return c.json({ error: "grant_type_required" }, 400);
    if (!body.scope) return c.json({ error: "scope_required" }, 400);

    try {
      const grant = await createGrant(
        { grants: cfg.grants, adminGuard: cfg.adminGuard },
        {
          actor: actor.userId,
          workspaceId: wsId,
          subject,
          grantType: GrantType(body.grant_type),
          details: body.details ?? {},
          scope: GrantScope(body.scope),
          sessionId: body.session_id ? SessionId(body.session_id) : null,
          reason: body.reason ?? null,
        },
      );
      return c.json({ grant: serializeGrant(grant) }, 201);
    } catch (err) {
      return c.json(domainErrorBody(err), domainErrorStatus(err) as 400);
    }
  });

  app.delete("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    try {
      await revokeGrant(
        { grants: cfg.grants, adminGuard: cfg.adminGuard },
        {
          actor: actor.userId,
          workspaceId: wsId,
          grantId: GrantId(c.req.param("id")!),
        },
      );
      return c.json({ ok: true });
    } catch (err) {
      return c.json(domainErrorBody(err), domainErrorStatus(err) as 400);
    }
  });

  return app;
}
