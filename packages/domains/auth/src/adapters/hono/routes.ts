import { Hono } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthProvider } from "../../ports/auth-provider.js";
import type { UserRepository } from "../../ports/user-repository.js";
import type { SessionTokenizer } from "../../ports/session-tokenizer.js";
import type { PersonRepository } from "../../ports/person-repository.js";
import type { LinkAttemptStore } from "../../ports/link-attempt-store.js";
import type { OAuthLoginStateStore } from "../../ports/oauth-login-state-store.js";
import type { PasswordCredentialStore } from "../../ports/password-credential-store.js";
import type { UserOAuthTokenStore } from "../../ports/user-oauth-token-store.js";
import {
  signInWithCode,
  completeSignIn,
  type EncryptOAuthToken,
} from "../../application/sign-in.js";
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
import {
  LoginState,
  type OAuthLoginState,
} from "../../domain/oauth-login-state.js";
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
  /**
   * When true, session cookies carry the `Secure` attribute so they're
   * only sent over HTTPS. Composition layer should set this when
   * NODE_ENV === "production". Default false to keep dev (plain
   * HTTP / mixed-cert) flows working.
   */
  cookieSecure?: boolean;

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
  /**
   * REQUIRED for OAuth login (`/google` + `/google/callback`). Backs
   * the server-side `state` + PKCE-verifier ledger that closes the
   * login-CSRF + open-redirect chain (audit t04 P0 #1, OAuth 2.0 §10.12,
   * RFC 7636). Composition root must wire the Postgres adapter; tests
   * use the in-memory fake.
   */
  loginStates: OAuthLoginStateStore;
  clock?: Clock;

  /**
   * When set, exposes `POST /auth/password` for email+password login
   * and advertises the capability on `GET /auth/config`. Password
   * credentials coexist with SSO — a user can have either, both, or
   * neither. Seeded via the quickstart CLI; there is no reset flow in
   * this deployment (no SMTP).
   */
  passwords?: PasswordCredentialStore;

  /**
   * When set, the Google sign-in callback persists the OAuth grant
   * (access_token / refresh_token / scopes / expiry) into the
   * UserOAuthTokenStore via the supplied encrypt boundary. Composition
   * root wires this only when downstream-API providers (Google
   * Workspace, Microsoft 365, etc.) are part of the install. Skip →
   * sign-in still works for identity, downstream providers report
   * permission_required when called.
   */
  oauthTokens?: {
    store: UserOAuthTokenStore;
    encrypt: EncryptOAuthToken;
  };
}

function buildCookieHeader(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Constant-time string compare. False on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}

/** PKCE S256 challenge derivation (RFC 7636 §4.2). */
function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const OAUTH_STATE_COOKIE_NAME = "x1_oauth_state";

function readCookie(
  rawCookie: string | undefined,
  name: string,
): string | null {
  if (!rawCookie) return null;
  const m = rawCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1]! : null;
}

// Maps known domain errors to HTTP status. Unknown errors are
// rethrown so Hono's app.onError fires (→ Sentry.captureException).
function domainErrorStatus(err: unknown): number {
  if (err instanceof NoWorkspaceMembershipError) return 403;
  if (err instanceof SessionVerificationError) return 401;
  if (err instanceof DomainError) return 400;
  throw err;
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
  const COOKIE_SECURE = cfg.cookieSecure ?? false;
  const cookieHeader = (name: string, value: string, maxAgeSeconds: number) =>
    buildCookieHeader(name, value, maxAgeSeconds, COOKIE_SECURE);
  const expiredCookie = (name: string) =>
    buildCookieHeader(name, "", 0, COOKIE_SECURE);
  const redirectUri = () => `${cfg.apiUrl}/auth/google/callback`;

  app.get("/config", (c) =>
    c.json({
      provider: cfg.authProvider.id,
      auth_bypass: !!cfg.bypassProvider,
      password_auth: !!cfg.passwords,
    }),
  );

  const loginStates = cfg.loginStates;
  const clock = cfg.clock ?? systemClock;

  // /google — initiation. Mints a fresh OAuth `state` + PKCE verifier,
  // persists them server-side keyed by `state`, sets a one-shot
  // httpOnly cookie carrying the same `state` (defense-in-depth), and
  // sends the browser to Google with `state` + `code_challenge`.
  //
  // Two layers MUST agree on the callback before we touch the code:
  //   1. The cookie returned by the browser equals the `state` query
  //      param (login-CSRF: an attacker cannot fabricate the cookie).
  //   2. The persisted row exists, isn't expired, and isn't already
  //      consumed (prevents replay).
  //
  // See audit docs/audits/2026-05-14_security-sweep/findings/t04_auth.md
  // (orchestrator repo) and OAuth 2.0 §10.12 / RFC 7636.
  app.get("/google", async (c) => {
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = pkceChallengeFor(codeVerifier);
    const now = clock.now();
    const attempt: OAuthLoginState = {
      state: LoginState(state),
      codeVerifier,
      redirectPath: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000),
      usedAt: null,
    };
    await loginStates.put(attempt);
    c.header(
      "Set-Cookie",
      cookieHeader(OAUTH_STATE_COOKIE_NAME, state, OAUTH_STATE_TTL_SECONDS),
    );
    return c.redirect(
      cfg.authProvider.getAuthorizeUrl(redirectUri(), state, {
        codeChallenge,
        codeChallengeMethod: "S256",
      }),
    );
  });

  app.get("/google/callback", async (c) => {
    const code = c.req.query("code");
    const queryState = c.req.query("state");
    if (!code) return c.json({ error: "missing_code" }, 400);
    if (!queryState) return c.json({ error: "oauth_state_invalid" }, 400);

    // Belt: cookie binding. An attacker who lures the victim into
    // hitting an attacker-built /callback URL cannot forge this cookie
    // — it was never set on the victim's browser.
    const cookieState = readCookie(
      c.req.header("Cookie"),
      OAUTH_STATE_COOKIE_NAME,
    );
    if (!cookieState || !safeEqual(cookieState, queryState)) {
      // Always clear the cookie on rejection so a stale value can't
      // accidentally be reused on a follow-up request.
      c.header("Set-Cookie", expiredCookie(OAUTH_STATE_COOKIE_NAME), {
        append: true,
      });
      return c.json({ error: "oauth_state_invalid" }, 400);
    }

    // Suspenders: server-side single-use ledger. consume() atomically
    // marks `used_at` and returns null on missing / already-used /
    // double-submit races.
    const row = await loginStates.consume(LoginState(queryState));
    c.header("Set-Cookie", expiredCookie(OAUTH_STATE_COOKIE_NAME), {
      append: true,
    });
    if (!row) return c.json({ error: "oauth_state_invalid" }, 400);
    if (row.expiresAt.getTime() < clock.now().getTime())
      return c.json({ error: "oauth_state_invalid" }, 400);

    try {
      const { session, token } = await signInWithCode(
        {
          authProvider: cfg.authProvider,
          users: cfg.users,
          tokenizer: cfg.tokenizer,
          allowedDomains: cfg.allowedDomains ?? [],
          platformAdmins: cfg.platformAdmins ?? [],
          accessGate: cfg.accessGate,
          oauthTokens: cfg.oauthTokens,
        },
        code,
        redirectUri(),
        { codeVerifier: row.codeVerifier },
      );
      c.header(
        "Set-Cookie",
        cookieHeader(COOKIE_NAME, token, COOKIE_MAX_AGE),
        { append: true },
      );
      // Fresh-install platform admin: they signed in successfully but
      // there's no workspace yet (assertHasMembership exempts admins
      // for exactly this case). Send them to /workspaces/new so they
      // can bootstrap the first workspace. Anyone else with at least
      // one membership lands on their first workspace.
      //
      // The post-auth path is server-controlled (either the row's
      // stashed `redirect_path` or the membership-derived default) —
      // never a client-supplied callback param. This is the
      // open-redirect defense.
      const slug = session.memberships[0]?.slug;
      const fallback = slug ? `/workspaces/${slug}` : "/workspaces/new";
      const dest = row.redirectPath ?? fallback;
      return c.redirect(`${cfg.appUrl}${dest}`);
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
        // Same bootstrap-admin handling as the OAuth callback above.
        const slug = session.memberships[0]?.slug;
        const dest = slug ? `/workspaces/${slug}` : "/workspaces/new";
        return c.redirect(`${cfg.appUrl}${dest}`);
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
        // Bootstrap-admin path: a platform admin can sign in via
        // password before any workspace exists. Return null slug; the
        // app routes them to /workspaces/new.
        return c.json({
          ok: true,
          workspace_slug: session.memberships[0]?.slug ?? null,
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
    c.header("Set-Cookie", expiredCookie(COOKIE_NAME));
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
