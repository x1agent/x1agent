import { Hono } from "hono";
import type { AuthProvider } from "../../ports/auth-provider.js";
import type { UserRepository } from "../../ports/user-repository.js";
import type { SessionTokenizer } from "../../ports/session-tokenizer.js";
import type { PersonRepository } from "../../ports/person-repository.js";
import type { LinkAttemptStore } from "../../ports/link-attempt-store.js";
import type { PasswordCredentialStore } from "../../ports/password-credential-store.js";
import { signInWithCode, completeSignIn } from "../../application/sign-in.js";
import { signInWithPassword } from "../../application/sign-in-with-password.js";
import { verifySessionToken } from "../../application/verify-session.js";
import { beginLink } from "../../application/begin-link.js";
import { completeLink } from "../../application/complete-link.js";
import { DomainError, systemClock, type Clock } from "@x1agent/kernel";
import {
  NoWorkspaceMembershipError,
  PasswordSignInFailedError,
  SessionVerificationError,
} from "../../domain/errors.js";
import type { AuthProfile } from "../../domain/auth-profile.js";
import { LinkState } from "../../domain/link-attempt.js";
import { Email, UserId } from "@x1agent/kernel";

export interface AuthRoutesConfig {
  authProvider: AuthProvider;
  users: UserRepository;
  tokenizer: SessionTokenizer;

  /** Frontend base URL, used for post-auth redirects. */
  appUrl: string;
  /** API base URL, used to build the OAuth callback redirect_uri. */
  apiUrl: string;
  cookieName?: string;
  cookieMaxAgeSeconds?: number;

  allowedDomains?: readonly string[];
  platformAdmins?: readonly string[];
  /**
   * Optional per-email allowlist. When set, sign-in lets through emails
   * that fail the domain allowlist if the gate says they're known
   * (existing user or pending invitation).
   */
  accessGate?: import("../../ports/access-gate.js").AccessGate;

  /**
   * Optional second provider for dev-only direct sign-in. When set, a
   * `/bypass` route accepts a GET and signs the bypass profile in.
   * Gated at the composition root by env (AUTH_BYPASS=true) — the routes
   * module itself just wires whatever is passed.
   */
  bypassProvider?: AuthProvider;
  /** Code the bypass provider expects; default "bypass". */
  bypassCode?: string;

  /**
   * When both `persons` and `linkAttempts` are provided, account-linking
   * routes are registered: POST /link/begin, GET /link/callback, GET
   * /accounts, POST /switch_account, POST /unlink. Each requires an
   * authenticated session.
   */
  persons?: PersonRepository;
  linkAttempts?: LinkAttemptStore;
  clock?: Clock;

  /**
   * When set, exposes `POST /auth/password` for email+password login
   * and advertises the capability on `GET /auth/config`. Password
   * credentials coexist with SSO — a user can have either, both, or
   * neither. Seeded via the quickstart CLI; there is no reset flow in
   * this deployment (no SMTP).
   */
  passwords?: PasswordCredentialStore;
}

function cookieHeader(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

function readCookie(
  rawCookie: string | undefined,
  name: string,
): string | null {
  if (!rawCookie) return null;
  const m = rawCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1]! : null;
}

function domainErrorStatus(err: unknown): number {
  if (err instanceof NoWorkspaceMembershipError) return 403;
  if (err instanceof SessionVerificationError) return 401;
  if (err instanceof DomainError) return 400;
  return 500;
}

function domainErrorBody(err: unknown) {
  if (err instanceof DomainError)
    return { error: err.code, message: err.message };
  return { error: "internal_error", message: "unexpected failure" };
}

export function createAuthRoutes(cfg: AuthRoutesConfig): Hono {
  const app = new Hono();
  const COOKIE_NAME = cfg.cookieName ?? "x1_session";
  const COOKIE_MAX_AGE = cfg.cookieMaxAgeSeconds ?? 60 * 60 * 24;
  const redirectUri = () => `${cfg.apiUrl}/auth/google/callback`;

  app.get("/config", (c) =>
    c.json({
      provider: cfg.authProvider.id,
      auth_bypass: !!cfg.bypassProvider,
      password_auth: !!cfg.passwords,
    }),
  );

  app.get("/google", (c) =>
    c.redirect(cfg.authProvider.getAuthorizeUrl(redirectUri())),
  );

  app.get("/google/callback", async (c) => {
    const code = c.req.query("code");
    if (!code) return c.json({ error: "missing_code" }, 400);
    try {
      const { session, token } = await signInWithCode(
        {
          authProvider: cfg.authProvider,
          users: cfg.users,
          tokenizer: cfg.tokenizer,
          allowedDomains: cfg.allowedDomains ?? [],
          platformAdmins: cfg.platformAdmins ?? [],
          accessGate: cfg.accessGate,
        },
        code,
        redirectUri(),
      );
      c.header(
        "Set-Cookie",
        cookieHeader(COOKIE_NAME, token, COOKIE_MAX_AGE),
      );
      const slug = session.memberships[0]!.slug;
      return c.redirect(`${cfg.appUrl}/workspaces/${slug}`);
    } catch (err) {
      if (err instanceof NoWorkspaceMembershipError)
        return c.redirect(`${cfg.appUrl}/no-access`);
      return c.json(domainErrorBody(err), domainErrorStatus(err) as 400);
    }
  });

  if (cfg.bypassProvider) {
    const bypass = cfg.bypassProvider;
    const bypassCode = cfg.bypassCode ?? "bypass";
    app.get("/bypass", async (c) => {
      try {
        const profile: AuthProfile = await bypass.exchangeCode(
          bypassCode,
          redirectUri(),
        );
        const { session, token } = await completeSignIn(
          {
            users: cfg.users,
            tokenizer: cfg.tokenizer,
            allowedDomains: cfg.allowedDomains ?? [],
            platformAdmins: cfg.platformAdmins ?? [],
            accessGate: cfg.accessGate,
          },
          profile,
        );
        c.header(
          "Set-Cookie",
          cookieHeader(COOKIE_NAME, token, COOKIE_MAX_AGE),
        );
        const slug = session.memberships[0]!.slug;
        return c.redirect(`${cfg.appUrl}/workspaces/${slug}`);
      } catch (err) {
        if (err instanceof NoWorkspaceMembershipError)
          return c.redirect(`${cfg.appUrl}/no-access`);
        return c.json(domainErrorBody(err), domainErrorStatus(err) as 400);
      }
    });
  }

  if (cfg.passwords) {
    const passwords = cfg.passwords;
    app.post("/password", async (c) => {
      const body = await c.req
        .json<{ email?: string; password?: string }>()
        .catch(() => ({}));
      const email = body.email?.trim();
      const password = body.password;
      if (!email || !password) {
        return c.json({ error: "missing_fields" }, 400);
      }
      try {
        const { session, token } = await signInWithPassword(
          {
            passwords,
            users: cfg.users,
            tokenizer: cfg.tokenizer,
            persons: cfg.persons,
            platformAdmins: cfg.platformAdmins ?? [],
          },
          Email(email),
          password,
        );
        c.header(
          "Set-Cookie",
          cookieHeader(COOKIE_NAME, token, COOKIE_MAX_AGE),
        );
        return c.json({
          ok: true,
          workspace_slug: session.memberships[0]!.slug,
        });
      } catch (err) {
        if (
          err instanceof PasswordSignInFailedError ||
          err instanceof NoWorkspaceMembershipError
        ) {
          // Collapse both "bad credentials" and "no workspace" to a
          // single 401 — exposing the distinction would leak which
          // emails have accounts.
          return c.json({ error: "invalid_credentials" }, 401);
        }
        return c.json(domainErrorBody(err), domainErrorStatus(err) as 400);
      }
    });
  }

  app.post("/logout", (c) => {
    c.header(
      "Set-Cookie",
      `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    return c.json({ ok: true });
  });

  const tokenFromRequest = (c: Parameters<Parameters<typeof app.get>[1]>[0]) =>
    readCookie(c.req.header("Cookie"), COOKIE_NAME) ||
    c.req.header("Authorization")?.replace(/^Bearer\s+/, "") ||
    null;

  app.get("/me", (c) => {
    const token = tokenFromRequest(c);
    if (!token) return c.json({ error: "unauthenticated" }, 401);
    try {
      const session = verifySessionToken(cfg.tokenizer, token);
      return c.json({
        user: {
          id: session.userId,
          email: session.email,
          name: session.name,
          avatar_url: null,
        },
        memberships: session.memberships.map((m) => ({
          workspace_id: m.workspaceId,
          slug: m.slug,
          name: m.name,
          role: m.role,
        })),
        is_platform_admin: session.isPlatformAdmin,
      });
    } catch (err) {
      return c.json(domainErrorBody(err), domainErrorStatus(err) as 401);
    }
  });

  if (cfg.persons && cfg.linkAttempts) {
    const persons = cfg.persons;
    const linkAttempts = cfg.linkAttempts;
    const clock = cfg.clock ?? systemClock;
    const linkRedirectUri = () => `${cfg.apiUrl}/auth/link/callback`;

    app.post("/link/begin", async (c) => {
      const token = tokenFromRequest(c);
      if (!token) return c.json({ error: "unauthenticated" }, 401);
      let session;
      try {
        session = verifySessionToken(cfg.tokenizer, token);
      } catch (err) {
        return c.json(domainErrorBody(err), 401);
      }
      const personId = await persons.findPersonIdForUser(
        UserId(session.userId),
      );
      if (!personId)
        return c.json({ error: "no_person_id" }, 400);

      const { authorizeUrl } = await beginLink(
        { authProvider: cfg.authProvider, linkAttempts, clock },
        { initiatingPersonId: personId, redirectUri: linkRedirectUri() },
      );
      return c.json({ authorize_url: authorizeUrl });
    });

    app.get("/link/callback", async (c) => {
      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!code || !state) return c.json({ error: "missing_params" }, 400);
      try {
        await completeLink(
          {
            authProvider: cfg.authProvider,
            users: cfg.users,
            persons,
            linkAttempts,
            clock,
            allowedDomains: cfg.allowedDomains ?? [],
          },
          {
            state: LinkState(state),
            code,
            redirectUri: linkRedirectUri(),
          },
        );
        return c.redirect(`${cfg.appUrl}/account?linked=1`);
      } catch (err) {
        return c.redirect(
          `${cfg.appUrl}/account?error=${
            err instanceof DomainError ? err.code : "link_failed"
          }`,
        );
      }
    });

    app.get("/accounts", async (c) => {
      const token = tokenFromRequest(c);
      if (!token) return c.json({ error: "unauthenticated" }, 401);
      let session;
      try {
        session = verifySessionToken(cfg.tokenizer, token);
      } catch (err) {
        return c.json(domainErrorBody(err), 401);
      }
      const personId = await persons.findPersonIdForUser(
        UserId(session.userId),
      );
      if (!personId) return c.json({ accounts: [] });
      const userIds = await persons.listUsersForPerson(personId);
      const rows = await Promise.all(
        userIds.map(async (id) => {
          const u = await cfg.users.findById(id);
          if (!u) return null;
          return {
            user_id: u.id,
            email: u.email,
            name: u.name,
            is_current: u.id === session.userId,
          };
        }),
      );
      return c.json({ accounts: rows.filter((r): r is NonNullable<typeof r> => r !== null) });
    });

    app.post("/switch_account", async (c) => {
      const token = tokenFromRequest(c);
      if (!token) return c.json({ error: "unauthenticated" }, 401);
      let session;
      try {
        session = verifySessionToken(cfg.tokenizer, token);
      } catch (err) {
        return c.json(domainErrorBody(err), 401);
      }
      const body = await c.req
        .json<{ user_id?: string }>()
        .catch(() => ({}));
      if (!body.user_id) return c.json({ error: "missing_user_id" }, 400);

      const personId = await persons.findPersonIdForUser(
        UserId(session.userId),
      );
      const targetPersonId = await persons.findPersonIdForUser(
        UserId(body.user_id),
      );
      if (!personId || personId !== targetPersonId) {
        return c.json({ error: "not_linked" }, 403);
      }

      const target = await cfg.users.findById(UserId(body.user_id));
      if (!target) return c.json({ error: "user_not_found" }, 404);

      const memberships = await cfg.users.listMemberships(target.id);
      if (memberships.length === 0)
        return c.json({ error: "target_has_no_memberships" }, 409);

      const newSession = {
        userId: target.id,
        email: target.email,
        name: target.name,
        memberships,
        isPlatformAdmin: session.isPlatformAdmin,
      };
      const newToken = cfg.tokenizer.sign(newSession);
      c.header(
        "Set-Cookie",
        cookieHeader(COOKIE_NAME, newToken, COOKIE_MAX_AGE),
      );
      return c.json({ ok: true, workspace_slug: memberships[0]!.slug });
    });

    app.post("/unlink", async (c) => {
      const token = tokenFromRequest(c);
      if (!token) return c.json({ error: "unauthenticated" }, 401);
      let session;
      try {
        session = verifySessionToken(cfg.tokenizer, token);
      } catch (err) {
        return c.json(domainErrorBody(err), 401);
      }
      const body = await c.req
        .json<{ user_id?: string }>()
        .catch(() => ({}));
      if (!body.user_id) return c.json({ error: "missing_user_id" }, 400);
      if (body.user_id === session.userId)
        return c.json({ error: "cannot_unlink_self" }, 400);

      const personId = await persons.findPersonIdForUser(
        UserId(session.userId),
      );
      const targetPersonId = await persons.findPersonIdForUser(
        UserId(body.user_id),
      );
      if (!personId || personId !== targetPersonId) {
        return c.json({ error: "not_linked" }, 403);
      }

      // Give the unlinked user a fresh person of their own.
      const target = await cfg.users.findById(UserId(body.user_id));
      if (!target) return c.json({ error: "user_not_found" }, 404);
      const newPerson = await persons.create({ displayName: target.name });
      await persons.attachUser(target.id, newPerson.id);
      return c.json({ ok: true });
    });
  }

  return app;
}
