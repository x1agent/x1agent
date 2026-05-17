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
const env = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "production";
// Operators' local devspace deploys pass the shared DSN through. Without
// this gate, every dev tick (e.g. a scheduler running against a stale
// migration-less DB) reports up and pollutes the prod error stream —
// the X1AGENT-API-B `idle_timeout_seconds` flood was 4879 events from
// one operator's local environment. Force-enable via SENTRY_FORCE_INIT=1
// when you genuinely want a non-prod environment to report.
const isDevLike = /^(local|dev|development|test)/i.test(env);
const force = process.env.SENTRY_FORCE_INIT === "1";

if (dsn && (!isDevLike || force)) {
  Sentry.init({
    dsn,
    release: process.env.SENTRY_RELEASE || process.env.IMAGE_TAG,
    environment: env,
    // Default 0.1 — sample 10% of transactions for performance traces.
    // Bump to 1.0 in dev when actively debugging perf, drop to 0 if
    // ingestion volume becomes a billing concern.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    sendDefaultPii: true,
  });
  console.log(`[sentry] api initialised — env=${env} release=${process.env.IMAGE_TAG ?? "unset"}`);
} else if (dsn && isDevLike) {
  console.log(`[sentry] api init skipped — env=${env} looks dev-shaped. Set SENTRY_FORCE_INIT=1 to opt in.`);
} else {
  console.log("[sentry] api SENTRY_DSN_API unset — Sentry disabled");
}
