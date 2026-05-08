# Dev image for @x1agent/provider-graph-surrealdb. Same layering as the
# api image: manifests first for cache, source copied in last, devspace
# sync overlays at runtime for hot reload.
FROM oven/bun:1.2.16-alpine

RUN apk add --no-cache bash tini

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY packages/kernel/package.json packages/kernel/tsconfig.json ./packages/kernel/
COPY packages/domains/image-catalog/package.json packages/domains/image-catalog/tsconfig.json ./packages/domains/image-catalog/
COPY packages/infrastructure/kaniko/package.json packages/infrastructure/kaniko/tsconfig.json ./packages/infrastructure/kaniko/
COPY packages/observability/package.json packages/observability/tsconfig.json ./packages/observability/
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json packages/api/tsconfig.json ./packages/api/
COPY packages/app/package.json packages/app/tsconfig.json ./packages/app/
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
COPY packages/agent/package.json packages/agent/tsconfig.json ./packages/agent/
COPY packages/providers/messaging-slack/package.json packages/providers/messaging-slack/tsconfig.json ./packages/providers/messaging-slack/
COPY packages/providers/graph-surrealdb/package.json packages/providers/graph-surrealdb/tsconfig.json ./packages/providers/graph-surrealdb/
COPY packages/providers/google-workspace/package.json packages/providers/google-workspace/tsconfig.json ./packages/providers/google-workspace/
COPY docs/package.json ./docs/

RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/ ./packages/

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "--cwd", "packages/providers/graph-surrealdb", "src/index.ts"]
