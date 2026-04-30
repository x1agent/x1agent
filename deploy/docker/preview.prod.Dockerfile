# Production image for @x1agent/provider-preview. Multi-stage:
#   1. deps    — install workspace deps from frozen lockfile
#   2. runtime — minimal alpine + bun + just the source the provider needs
#
# Same shape as api.prod.Dockerfile, slimmer because the provider only
# needs kernel + shared + the preview package itself at runtime.

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
COPY packages/domains/agent-resources-redis/package.json packages/domains/agent-resources-redis/tsconfig.json ./packages/domains/agent-resources-redis/
COPY packages/providers/messaging-slack/package.json packages/providers/messaging-slack/tsconfig.json ./packages/providers/messaging-slack/
COPY packages/providers/graph-surrealdb/package.json packages/providers/graph-surrealdb/tsconfig.json ./packages/providers/graph-surrealdb/
COPY packages/providers/preview/package.json packages/providers/preview/tsconfig.json ./packages/providers/preview/
COPY packages/web/package.json ./packages/web/
COPY docs/package.json ./docs/

RUN bun install --frozen-lockfile --ignore-scripts

# ── runtime ───────────────────────────────────────────────────────────
FROM oven/bun:1.2.16-alpine AS runtime

RUN apk add --no-cache bash tini ca-certificates && \
    (deluser bun 2>/dev/null || true) && \
    (delgroup bun 2>/dev/null || true) && \
    addgroup -g 1000 agent && \
    adduser  -u 1000 -G agent -s /bin/bash -D -h /home/agent agent

WORKDIR /app

COPY --from=deps --chown=agent:agent /app/node_modules ./node_modules
COPY --from=deps --chown=agent:agent /app/package.json /app/bun.lock /app/tsconfig.base.json ./
COPY --chown=agent:agent packages/kernel/ ./packages/kernel/
COPY --chown=agent:agent packages/shared/ ./packages/shared/
COPY --chown=agent:agent packages/observability/ ./packages/observability/
COPY --chown=agent:agent packages/providers/preview/ ./packages/providers/preview/

USER agent

ENV NODE_ENV=production

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "packages/providers/preview/src/index.ts"]
