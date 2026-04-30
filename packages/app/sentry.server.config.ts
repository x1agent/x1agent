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

if (dsn) {
  Sentry.init({
    dsn,
    release,
    environment: process.env.NODE_ENV,
    sendDefaultPii: true,
    tracesSampleRate: 0.1,
  });
}
