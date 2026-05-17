/**
 * Astro SSR Sentry init. Catches unhandled errors thrown inside
 * .astro pages + SSR endpoints. Distinct from the api's @sentry/node
 * init (different DSN, different project) but uses the same
 * PUBLIC_SENTRY_DSN_APP env so both halves of the same Astro process
 * report to the x1agent-app project.
 */
import * as Sentry from "@sentry/astro";

const dsn = process.env.PUBLIC_SENTRY_DSN_APP;
const release = process.env.SENTRY_RELEASE || process.env.IMAGE_TAG;
const env = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "production";
// See api/src/instrument.ts for rationale — local devspace pods get
// the DSN piped through but shouldn't actually ship events.
const isDevLike = /^(local|dev|development|test)/i.test(env);

if (dsn && !isDevLike) {
  Sentry.init({
    dsn,
    release,
    environment: env,
    sendDefaultPii: true,
    tracesSampleRate: 0.1,
  });
}
