import { Hono } from "hono";
import { readCapabilitiesFromEnv } from "./capabilities.js";

/**
 * GET /api/capabilities — snapshot of which provider domains are
 * installed in this deployment. Public-ish: no PII, just feature
 * flags. Frontend reads this once at boot to gate UI surfaces.
 *
 * Cache headers are short — operators can flip a provider on by
 * helm-upgrading and want the UI to reflect it within a minute.
 */
export function capabilitiesRoutes() {
  const app = new Hono();
  app.get("/", (c) => {
    c.header("Cache-Control", "public, max-age=30");
    return c.json(readCapabilitiesFromEnv());
  });
  return app;
}
