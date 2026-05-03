# Production image for @x1agent/app. Multi-stage:
#   1. deps    — install workspace deps from frozen lockfile
#   2. builder — astro build → static + SSR bundle in dist/
#   3. runtime — minimal alpine + bun + just the built artifacts
#
# Astro's "node" adapter ships a server bundle; we run it with bun.
# If the app config switches to "static" output later, the runtime stage
# becomes nginx serving dist/client/ and this Dockerfile shrinks.

FROM oven/bun:1.2.16-alpine AS deps

RUN apk add --no-cache bash
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY packages/kernel/package.json packages/kernel/tsconfig.json ./packages/kernel/
COPY packages/observability/package.json packages/observability/tsconfig.json ./packages/observability/
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json packages/api/tsconfig.json ./packages/api/
COPY packages/app/package.json packages/app/tsconfig.json ./packages/app/
COPY packages/cli/package.json ./packages/cli/
COPY packages/agent/package.json packages/agent/tsconfig.json ./packages/agent/
COPY packages/domains/auth/package.json packages/domains/auth/tsconfig.json ./packages/domains/auth/
COPY packages/domains/workspaces/package.json packages/domains/workspaces/tsconfig.json ./packages/domains/workspaces/
COPY packages/domains/invitations/package.json packages/domains/invitations/tsconfig.json ./packages/domains/invitations/
COPY packages/domains/agents/package.json packages/domains/agents/tsconfig.json ./packages/domains/agents/
COPY packages/domains/github/package.json packages/domains/github/tsconfig.json ./packages/domains/github/
COPY packages/domains/sessions/package.json packages/domains/sessions/tsconfig.json ./packages/domains/sessions/
COPY packages/domains/permissions/package.json packages/domains/permissions/tsconfig.json ./packages/domains/permissions/
COPY packages/domains/messaging/package.json packages/domains/messaging/tsconfig.json ./packages/domains/messaging/
COPY packages/domains/graph/package.json packages/domains/graph/tsconfig.json ./packages/domains/graph/
COPY packages/domains/vector/package.json packages/domains/vector/tsconfig.json ./packages/domains/vector/
COPY packages/domains/collections/package.json packages/domains/collections/tsconfig.json ./packages/domains/collections/
COPY packages/domains/agent-resources/package.json packages/domains/agent-resources/tsconfig.json ./packages/domains/agent-resources/
COPY packages/domains/agent-resources-postgres/package.json packages/domains/agent-resources-postgres/tsconfig.json ./packages/domains/agent-resources-postgres/
COPY packages/domains/workspace-secrets/package.json packages/domains/workspace-secrets/tsconfig.json ./packages/domains/workspace-secrets/
COPY packages/domains/mcp-catalog/package.json packages/domains/mcp-catalog/tsconfig.json ./packages/domains/mcp-catalog/
COPY packages/domains/agent-env/package.json packages/domains/agent-env/tsconfig.json ./packages/domains/agent-env/
COPY packages/domains/agent-resources-redis/package.json packages/domains/agent-resources-redis/tsconfig.json ./packages/domains/agent-resources-redis/
COPY packages/providers/messaging-slack/package.json packages/providers/messaging-slack/tsconfig.json ./packages/providers/messaging-slack/
COPY packages/providers/graph-surrealdb/package.json packages/providers/graph-surrealdb/tsconfig.json ./packages/providers/graph-surrealdb/
COPY packages/providers/preview/package.json packages/providers/preview/tsconfig.json ./packages/providers/preview/
COPY docs/package.json ./docs/

RUN bun install --frozen-lockfile --ignore-scripts

# ── builder ───────────────────────────────────────────────────────────
# Real Node 22.13+ for `astro build`. The bun:1.2.16-alpine deps stage
# bundles Node 22.6.0 which Astro 6 rejects (>=22.12.0 required).
# bun:1.2.21-alpine bundles Node 24 but segfaults under Rosetta amd64
# emulation on Apple Silicon. Cleanest workaround: bun for dep
# resolution (lockfile compat), real Node for the build.
FROM node:22.13-alpine AS builder

WORKDIR /app

# Carry installed deps + manifests forward from the bun deps stage.
# node_modules is portable across runtimes (no native bun-only modules
# in this dep tree).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json /app/bun.lock /app/tsconfig.base.json ./
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/docs ./docs

# Source for the app + the packages astro imports from.
COPY packages/kernel/ ./packages/kernel/
COPY packages/shared/ ./packages/shared/
COPY packages/app/ ./packages/app/

# PUBLIC_API_URL is baked into the static bundle by Astro's import.meta
# substitution. Pass it as a build-arg so different installs get
# different URLs. The installer wires this from .env.local at build time.
ARG PUBLIC_API_URL=https://api.x1agent.com
ARG PUBLIC_URL=https://app.x1agent.com
ARG PUBLIC_NATS_WS_URL=wss://nats.x1agent.com
# Sentry — DSN is baked into the browser bundle (no runtime config for
# import.meta.env). Auth token is build-time only for source-map upload;
# never carried in the runtime image.
ARG PUBLIC_SENTRY_DSN_APP=
ARG SENTRY_AUTH_TOKEN=
ARG SENTRY_RELEASE=
ENV PUBLIC_API_URL=${PUBLIC_API_URL}
ENV PUBLIC_URL=${PUBLIC_URL}
ENV PUBLIC_NATS_WS_URL=${PUBLIC_NATS_WS_URL}
ENV PUBLIC_SENTRY_DSN_APP=${PUBLIC_SENTRY_DSN_APP}
ENV SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN}
ENV SENTRY_RELEASE=${SENTRY_RELEASE}

# Workspace bins live at root /app/node_modules/.bin (not per-package).
# npx walks ancestor node_modules/.bin until it finds astro, then runs
# it under real Node 22.13 (sidesteps bun's old emulated-Node version).
RUN cd packages/app && npx astro build

# ── runtime ───────────────────────────────────────────────────────────
FROM oven/bun:1.2.16-alpine AS runtime

RUN apk add --no-cache bash tini ca-certificates && \
    (deluser bun 2>/dev/null || true) && \
    (delgroup bun 2>/dev/null || true) && \
    addgroup -g 1000 agent && \
    adduser  -u 1000 -G agent -s /bin/bash -D -h /home/agent agent

WORKDIR /app

# node_modules is needed at runtime for the SSR adapter's dependencies.
COPY --from=builder --chown=agent:agent /app/node_modules ./node_modules
COPY --from=builder --chown=agent:agent /app/package.json /app/bun.lock ./
COPY --from=builder --chown=agent:agent /app/packages/app/dist ./packages/app/dist
COPY --from=builder --chown=agent:agent /app/packages/app/package.json ./packages/app/

USER agent
EXPOSE 4322
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4322

# Carry Sentry config into the SSR runtime — sentry.server.config.ts
# reads these via process.env at request time. Distinct from the build-
# time ARG/ENV above which only feeds the browser bundle's
# import.meta.env substitution. Multi-stage builds drop ENV between
# stages, so re-declare here.
ARG PUBLIC_SENTRY_DSN_APP=
ARG SENTRY_RELEASE=
ENV PUBLIC_SENTRY_DSN_APP=${PUBLIC_SENTRY_DSN_APP}
ENV SENTRY_RELEASE=${SENTRY_RELEASE}

ENTRYPOINT ["tini", "--"]
# Astro node-adapter entry. If app/astro.config switches to static, this
# becomes a nginx Dockerfile serving dist/client/ instead.
CMD ["bun", "run", "packages/app/dist/server/entry.mjs"]
