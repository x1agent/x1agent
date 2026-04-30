/**
 * Browser Sentry init. The DSN is baked into the bundle at build time
 * via Astro's import.meta.env substitution — set PUBLIC_SENTRY_DSN_APP
 * as a docker build-arg (see deploy/docker/app.prod.Dockerfile).
 *
 * No-op when the DSN env is unset, so installs without Sentry stay
 * silent rather than spamming the console with init failures.
 */
import * as Sentry from "@sentry/astro";

const dsn = import.meta.env.PUBLIC_SENTRY_DSN_APP as string | undefined;
const release = import.meta.env.PUBLIC_SENTRY_RELEASE as string | undefined;

if (dsn) {
  Sentry.init({
    dsn,
    release,
    environment: import.meta.env.MODE,
    sendDefaultPii: true,
    // 10% perf trace sampling — same default the api uses.
    tracesSampleRate: 0.1,
  });
}
