# Dev image for @x1agent/provider-messaging-slack. Same pattern as the
# api image: manifests first for caching, then source. devspace sync
# overlays packages/ at runtime for hot reload.
FROM oven/bun:1-alpine

RUN apk add --no-cache bash tini

WORKDIR /app

# Manifests for workspace resolution. The install runs against the full
# workspace graph, so every package with a package.json has to be
# present here — even ones the provider doesn't consume at runtime.
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/kernel/package.json packages/kernel/tsconfig.json ./packages/kernel/
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
COPY packages/agent/package.json packages/agent/tsconfig.json ./packages/agent/
COPY packages/providers/messaging-slack/package.json packages/providers/messaging-slack/tsconfig.json ./packages/providers/messaging-slack/
COPY docs/package.json ./docs/

RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/ ./packages/

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "--cwd", "packages/providers/messaging-slack", "src/index.ts"]
