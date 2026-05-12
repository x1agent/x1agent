import { Hono, type Context, type MiddlewareHandler } from "hono";
import { Email } from "@x1agent/kernel";
import { isPlatformAdmin } from "@x1agent/domain-auth";
import {
  LLM_PROVIDERS,
  LLM_PROVIDER_ENV,
  type LlmProvider,
} from "./types.js";
import { llmKeysStatus, singleStatus } from "./status.js";
import {
  PlatformSecretsUnavailableError,
  type PlatformSecretsStore,
} from "./store.js";

/**
 * /api/admin/platform-secrets/llm — X1A-46 Admin Settings → LLM Keys.
 *
 * Surface contract (load-bearing, do not loosen):
 *   - Every route in here passes through requireAuth + isPlatformAdmin.
 *     A non-admin URL-poker gets a server-side 403 regardless of any UI
 *     menu-hiding upstream. The 403 page in the app reads this status
 *     code to switch into "forbidden" mode.
 *   - GET returns ONLY booleans. Never the value, never a prefix,
 *     never a length — see status.ts unit tests for the regression
 *     guard. This is the load-bearing security property of the surface.
 *   - PUT writes through the PlatformSecretsStore port and then asks
 *     it to roll the api Deployment so the new value takes effect.
 *     UI shows the "API will restart in ~30s" banner client-side as
 *     soon as the PUT returns 200.
 *   - DELETE clears the override; on the next pod start, the
 *     ESO-synced x1agent-secrets value (if any) becomes effective
 *     again, and the api falls back to "not configured" if neither
 *     source carries it.
 */
export interface PlatformSecretsRoutesConfig {
  platformAdmins: readonly string[];
  requireAuth: MiddlewareHandler;
  store: PlatformSecretsStore;
  /**
   * Source of truth for the configured/not-configured status — the
   * live process env. Overridable so route tests can pass a fixed
   * snapshot instead of mutating globals. The status endpoint reads
   * THIS map, not the K8s Secret data, because the api pod's current
   * process.env is the only honest answer to "is the api currently
   * able to call this provider."
   */
  readEnv?: () => Readonly<Record<string, string | undefined>>;
}

export function createPlatformSecretsRoutes(
  cfg: PlatformSecretsRoutesConfig,
): Hono {
  const app = new Hono();
  const readEnv =
    cfg.readEnv ??
    (() => process.env as Readonly<Record<string, string | undefined>>);

  app.use("*", cfg.requireAuth);
  app.use("*", async (c, next) => {
    const session = c.get("session") as
      | { email?: string }
      | undefined;
    if (!session?.email) return c.json({ error: "unauthenticated" }, 401);
    if (!isPlatformAdmin(Email(session.email), cfg.platformAdmins)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });

  /**
   * GET /llm → { providers: [{provider, configured}, ...] }
   * Returns the booleans only. See status.ts for the value-leakage test.
   */
  app.get("/llm", (c) => c.json(llmKeysStatus(readEnv())));

  /**
   * PUT /llm/:provider — body { value: string }. Writes to the
   * platform-secrets K8s Secret and triggers a rollout. Returns the
   * provider's updated status (still booleans only).
   */
  app.put("/llm/:provider", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown_provider" }, 400);

    interface PutBody {
      value?: unknown;
    }
    const body = await c.req.json<PutBody>().catch(() => ({}) as PutBody);
    const value = typeof body.value === "string" ? body.value : "";
    // Reject empty / whitespace-only values up front. The UI's Save
    // button is disabled in this case, but defend at the api layer
    // too so a curl with --data '{"value":""}' doesn't pretend to
    // succeed and then leave a "configured but empty" footgun.
    if (value.trim().length === 0) {
      return c.json(
        { error: "validation_error", message: "value must not be empty" },
        400,
      );
    }

    try {
      await cfg.store.setKey(LLM_PROVIDER_ENV[provider], value);
      await cfg.store.rolloutRestartApi();
    } catch (err) {
      return errorResponse(c, err);
    }

    // The new value is in the K8s Secret but not yet in the LIVE pod's
    // process.env — that won't happen until the rolled pod starts.
    // Echo "configured: true" anyway because (a) the user explicitly
    // just set a non-empty value, and (b) the UI's restart banner
    // already explains that a brief restart is in progress.
    return c.json({
      provider,
      configured: true,
      restart: "pending",
    });
  });

  /**
   * DELETE /llm/:provider — removes the platform-secrets override and
   * rolls the api Deployment. Idempotent: clearing an already-cleared
   * key is a no-op success.
   */
  app.delete("/llm/:provider", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown_provider" }, 400);

    try {
      await cfg.store.clearKey(LLM_PROVIDER_ENV[provider]);
      await cfg.store.rolloutRestartApi();
    } catch (err) {
      return errorResponse(c, err);
    }

    // process.env on the LIVE pod still has the old value until the
    // rollout completes — but the source-of-truth for "is the
    // platform-secret override set" is now "no", so echo
    // configured: false. UI shows the restart banner regardless.
    return c.json({
      provider,
      configured: false,
      restart: "pending",
    });
  });

  /** GET /llm/:provider — single-provider status. Used by the UI to
   * re-check the badge without re-fetching the whole list. */
  app.get("/llm/:provider", (c) => {
    const provider = parseProvider(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown_provider" }, 400);
    return c.json(singleStatus(readEnv(), provider));
  });

  return app;
}

function parseProvider(raw: string | undefined): LlmProvider | null {
  if (!raw) return null;
  return LLM_PROVIDERS.find((p) => p === raw) ?? null;
}

function errorResponse(c: Context, err: unknown) {
  if (err instanceof PlatformSecretsUnavailableError) {
    return c.json({ error: err.code }, 503);
  }
  const message = err instanceof Error ? err.message : "unknown_error";
  console.error(`[platform-secrets] write failed: ${message}`);
  return c.json({ error: "internal_error" }, 500);
}
