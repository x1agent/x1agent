# Dev image for @x1agent/api. Code is NOT copied in — devspace sync
# mounts packages/ from the host at /app/packages at dev time. This image
# only provides the runtime + the workspace lockfile + installed deps.
#
# Prod images will be built per-package from a different Dockerfile when
# we cut our first release.
FROM oven/bun:1-alpine

RUN apk add --no-cache bash tini

WORKDIR /app

# Copy only manifests first so layer caching works when source changes.
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
# Agent is a workspace package too (even though the api doesn't require
# it at runtime) — bun install fails --frozen-lockfile if any workspace
# manifest is missing.
COPY packages/agent/package.json packages/agent/tsconfig.json ./packages/agent/
# docs is listed as a workspace in the root package.json; its manifest has
# to be present at install time even though the api image doesn't run it.
COPY docs/package.json ./docs/

# --ignore-scripts skips the root `prepare` script that runs `git config`
# — there's no git in the image and the hook path is developer-only.
RUN bun install --frozen-lockfile --ignore-scripts

# Deploy migrations live here and the api binary loads them from a path
# relative to packages/api, so bake them into the image.
COPY deploy/migrations/ ./deploy/migrations/

# Devspace sync replaces packages/* at dev time; this COPY is just so the
# image is runnable on its own outside devspace (useful for CI smoke tests).
COPY packages/ ./packages/

EXPOSE 30001
ENV API_PORT=30001

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "--cwd", "packages/api", "src/index.ts"]
