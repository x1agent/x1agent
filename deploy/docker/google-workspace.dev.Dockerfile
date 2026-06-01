# syntax=docker/dockerfile:1.7-labs
# Dev image for @x1agent/provider-google-workspace. Mirrors the
# messaging-slack provider shape: manifests first for caching, then
# source. devspace sync overlays packages/ at runtime for hot reload.
FROM oven/bun:1.2.16-alpine

RUN apk add --no-cache bash tini

WORKDIR /app

# Glob in every workspace manifest so a new package can't silently break
# `bun install --frozen-lockfile`. Mirrors the prod Dockerfile.
COPY package.json bun.lock tsconfig.base.json ./
COPY --parents packages/**/package.json packages/**/tsconfig.json ./
COPY --parents docs/package.json docs/tsconfig.json ./

RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/ ./packages/

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "--cwd", "packages/providers/google-workspace", "src/index.ts"]
