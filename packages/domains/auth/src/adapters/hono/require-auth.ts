import type { MiddlewareHandler } from "hono";
import type { SessionTokenizer } from "../../ports/session-tokenizer.js";
import type { AuthSession } from "../../domain/auth-session.js";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

export interface RequireAuthOptions {
  cookieName?: string;
}

export function createRequireAuth(
  tokenizer: SessionTokenizer,
  opts: RequireAuthOptions = {},
): MiddlewareHandler {
  const cookieName = opts.cookieName ?? "x1_session";
  return async (c, next) => {
    const raw = c.req.header("Cookie") || "";
    const match = raw.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
    const token =
      match?.[1] ||
      c.req.header("Authorization")?.replace(/^Bearer\s+/, "") ||
      null;
    if (!token) return c.json({ error: "unauthenticated" }, 401);
    const session = tokenizer.verify(token);
    if (!session) return c.json({ error: "invalid_token" }, 401);
    c.set("session", session);
    await next();
  };
}
