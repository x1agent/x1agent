/**
 * Sentry init. Imported as the FIRST thing from index.ts (before
 * `import { Hono }` etc.) so the Sentry SDK can wrap the http +
 * postgres + node-fetch instrumentations before they load.
 *
 * SENTRY_DSN_API gates the whole thing — when unset, init() is a
 * no-op and the SDK doesn't intercept anything. Operators flip it
 * on by setting the env var via the helm chart's secret bindings
 * (see external-secrets.yaml).
 *
 * Release tag tracks the image tag (IMAGE_TAG env, set by the
 * deployment Pod spec) so Sentry can group errors by deploy and
 * deep-link source maps once the app side is wired.
 */
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN_API;
if (dsn) {
  Sentry.init({
    dsn,
    release: process.env.SENTRY_RELEASE || process.env.IMAGE_TAG,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    // Default 0.1 — sample 10% of transactions for performance traces.
    // Bump to 1.0 in dev when actively debugging perf, drop to 0 if
    // ingestion volume becomes a billing concern.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    sendDefaultPii: true,
  });
  console.log(`[sentry] api initialised — release=${process.env.IMAGE_TAG ?? "unset"}`);
} else {
  console.log("[sentry] api SENTRY_DSN_API unset — Sentry disabled");
}
