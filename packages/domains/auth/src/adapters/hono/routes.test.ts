import { describe, it, expect, beforeEach } from "bun:test";
import { Email, FixedClock, Role } from "@x1agent/kernel";
import { createAuthRoutes } from "./routes.js";
import {
  InMemoryAuthProvider,
  InMemorySessionTokenizer,
  InMemoryUserRepository,
} from "../../application/fakes.js";
import { InMemoryOAuthLoginStateStore } from "../../application/linking-fakes.js";
import { LoginState } from "../../domain/oauth-login-state.js";
import type { AuthProfile } from "../../domain/auth-profile.js";

/**
 * Route-layer tests for the OAuth login flow. Pin the t04 P0 #1 fix:
 * `/auth/google` MUST mint a state + PKCE verifier and persist them
 * server-side; `/auth/google/callback` MUST validate state via BOTH a
 * server-side ledger AND a one-shot httpOnly cookie before exchanging
 * the code; PKCE verifier MUST round-trip; replays/expiries MUST 400.
 *
 * Audit: docs/audits/2026-05-14_security-sweep/findings/t04_auth.md
 * Spec:  OAuth 2.0 §10.12 (login CSRF), RFC 7636 (PKCE).
 */

const ALICE: AuthProfile = {
  email: Email("alice@example.com"),
  name: "Alice",
  avatarUrl: null,
  providerUserId: "sub-alice",
  providerId: "fake",
};

let provider: InMemoryAuthProvider;
let users: InMemoryUserRepository;
let tokenizer: InMemorySessionTokenizer;
let loginStates: InMemoryOAuthLoginStateStore;
let clock: FixedClock;

function makeApp() {
  return createAuthRoutes({
    authProvider: provider,
    users,
    tokenizer,
    loginStates,
    clock,
    appUrl: "http://app.test",
    apiUrl: "http://api.test",
    allowedDomains: ["example.com"],
    // Treat Alice as a platform admin so the bootstrap-admin path fires
    // (no workspace memberships → /workspaces/new) instead of bouncing
    // to /no-access. Lets us assert the session cookie is set without
    // also seeding a workspace+membership row in the in-memory repo.
    platformAdmins: ["alice@example.com"],
  });
}

beforeEach(() => {
  provider = new InMemoryAuthProvider(new Map([["alice-code", ALICE]]));
  users = new InMemoryUserRepository();
  // Alice already has a workspace seat so the callback's
  // assertHasMembership is satisfied without exercising bootstrap-admin.
  // (The route awaits upsertFromProfile then listMemberships; we seed
  // the membership keyed by the same user the upsert will create. The
  // in-memory repo derives the user id at upsert time, so we instead
  // pre-create the user, then attach the membership.)
  // Simpler: rely on listMemberships returning empty → fall through to
  // /workspaces/new fallback, which is enough to assert the redirect path.
  tokenizer = new InMemorySessionTokenizer();
  loginStates = new InMemoryOAuthLoginStateStore();
  clock = new FixedClock(new Date("2026-05-14T00:00:00Z"));
});

/** Extract a single Set-Cookie value by name from a Response. */
function getSetCookie(res: Response, name: string): string | null {
  // Hono sets cookies via header(); when more than one Set-Cookie is
  // sent on the same response getSetCookie() collapses them into a
  // string the runtime joins with comma. We split conservatively on
  // ", " between cookie boundaries (each cookie has Path=/ etc, so we
  // can match by name= prefix).
  const raw = res.headers.get("Set-Cookie") ?? "";
  // Try every comma-separated chunk.
  for (const chunk of raw.split(/,\s*(?=[A-Za-z0-9_]+=)/)) {
    const m = chunk.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return m[1]!;
  }
  return null;
}

/** Pull the `state` query param off a Response.headers.location. */
function locationStateParam(res: Response): string {
  const loc = res.headers.get("Location") ?? "";
  const idx = loc.indexOf("?");
  if (idx < 0) return "";
  return new URLSearchParams(loc.slice(idx + 1)).get("state") ?? "";
}

describe("/auth/google initiation", () => {
  it("mints state + PKCE, persists them, sets cookie, redirects with state + code_challenge", async () => {
    const app = makeApp();
    const res = await app.request("/google");
    expect(res.status).toBe(302);

    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("fake://authorize");

    const params = new URLSearchParams(loc.slice(loc.indexOf("?") + 1));
    const state = params.get("state");
    expect(state).toBeTruthy();
    expect(state!.length).toBeGreaterThan(20);
    expect(params.get("code_challenge")).toBeTruthy();
    expect(params.get("code_challenge_method")).toBe("S256");

    // Cookie carries the same state.
    const cookieState = getSetCookie(res, "x1_oauth_state");
    expect(cookieState).toBe(state);

    // Server-side ledger has a row for this state.
    const stored = loginStates.rows.get(state!);
    expect(stored).toBeDefined();
    expect(stored!.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(stored!.usedAt).toBeNull();
  });
});

describe("/auth/google/callback", () => {
  async function beginFlow() {
    const app = makeApp();
    const initRes = await app.request("/google");
    const state = locationStateParam(initRes);
    const cookie = getSetCookie(initRes, "x1_oauth_state")!;
    return { app, state, cookie };
  }

  it("happy path: matching state + cookie + valid code → 302 and session cookie", async () => {
    const { app, state, cookie } = await beginFlow();
    const res = await app.request(
      `/google/callback?code=alice-code&state=${state}`,
      { headers: { Cookie: `x1_oauth_state=${cookie}` } },
    );
    expect(res.status).toBe(302);
    // Code-exchange happened with the persisted PKCE verifier.
    expect(provider.lastCodeVerifier).toBeTruthy();
    // Session cookie set.
    expect(getSetCookie(res, "x1_session")).toBeTruthy();
    // State cookie cleared (Max-Age=0 lives in the raw header).
    const raw = res.headers.get("Set-Cookie") ?? "";
    expect(raw).toContain("x1_oauth_state=;");
  });

  it("rejects callback with no state param → 400 oauth_state_invalid", async () => {
    const { app, cookie } = await beginFlow();
    const res = await app.request(`/google/callback?code=alice-code`, {
      headers: { Cookie: `x1_oauth_state=${cookie}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "oauth_state_invalid" });
  });

  it("rejects mismatched state (cookie A, query B) → 400 and does NOT exchange code", async () => {
    const a = await beginFlow();
    const b = await beginFlow();
    const res = await a.app.request(
      `/google/callback?code=alice-code&state=${b.state}`,
      { headers: { Cookie: `x1_oauth_state=${a.cookie}` } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "oauth_state_invalid" });
    // Most important: code exchange NEVER ran. lastCodeVerifier
    // started null and stays null because the route bailed before
    // signInWithCode.
    expect(provider.lastCodeVerifier).toBeNull();
  });

  it("rejects expired state (>10 min) → 400 and does NOT exchange code", async () => {
    const { app, state, cookie } = await beginFlow();
    clock.advance(11 * 60 * 1000);
    const res = await app.request(
      `/google/callback?code=alice-code&state=${state}`,
      { headers: { Cookie: `x1_oauth_state=${cookie}` } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "oauth_state_invalid" });
    expect(provider.lastCodeVerifier).toBeNull();
  });

  it("rejects already-used state (replay) → 400 on second call", async () => {
    const { app, state, cookie } = await beginFlow();
    const first = await app.request(
      `/google/callback?code=alice-code&state=${state}`,
      { headers: { Cookie: `x1_oauth_state=${cookie}` } },
    );
    expect(first.status).toBe(302);
    // Replay using the same state.
    const second = await app.request(
      `/google/callback?code=alice-code&state=${state}`,
      { headers: { Cookie: `x1_oauth_state=${cookie}` } },
    );
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: "oauth_state_invalid" });
  });

  it("rejects PKCE verifier mismatch (provider rejects) → 400", async () => {
    const { app, state, cookie } = await beginFlow();
    // Force the provider to assert a specific (wrong) verifier for
    // this code, so the verifier the route threads from the row will
    // never match.
    provider.expectedVerifierByCode.set("alice-code", "WRONG_VERIFIER_VALUE");
    const res = await app.request(
      `/google/callback?code=alice-code&state=${state}`,
      { headers: { Cookie: `x1_oauth_state=${cookie}` } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // Domain layer surfaces this as invalid_auth_code (provider rejected).
    expect(body.error).toBe("invalid_auth_code");
  });

  it("rejects callback with no cookie at all → 400", async () => {
    const { app, state } = await beginFlow();
    const res = await app.request(
      `/google/callback?code=alice-code&state=${state}`,
      // no Cookie header
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "oauth_state_invalid" });
    expect(provider.lastCodeVerifier).toBeNull();
  });

  it("rejects callback whose state is unknown to the ledger (forged) → 400", async () => {
    const app = makeApp();
    // Plant a cookie that matches the query, but no row was put().
    const forged = "forged-state-value-aaaaaaaaaaaaaaaaaaaa";
    const res = await app.request(
      `/google/callback?code=alice-code&state=${forged}`,
      { headers: { Cookie: `x1_oauth_state=${forged}` } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "oauth_state_invalid" });
    expect(provider.lastCodeVerifier).toBeNull();
  });

  it("does not allow reusing a cookie value to bypass server-side single-use", async () => {
    const { app, state, cookie } = await beginFlow();
    // Consume out-of-band so the row is gone.
    const consumed = await loginStates.consume(LoginState(state));
    expect(consumed).not.toBeNull();
    const res = await app.request(
      `/google/callback?code=alice-code&state=${state}`,
      { headers: { Cookie: `x1_oauth_state=${cookie}` } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "oauth_state_invalid" });
  });
});
