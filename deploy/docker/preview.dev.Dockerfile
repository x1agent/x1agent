# syntax=docker/dockerfile:1.7-labs
# Dev image for @x1agent/provider-preview. Manifests glob first for
# cache, source copied in last, devspace sync overlays at runtime for
# hot reload.
FROM oven/bun:1.2.16-alpine

RUN apk add --no-cache bash tini

WORKDIR /app

# Glob in every workspace manifest so a new package can't silently break
# `bun install --frozen-lockfile`. Mirrors the prod Dockerfile.
COPY package.json bun.lock tsconfig.base.json ./
COPY --parents packages/**/package.json packages/**/tsconfig.json ./
COPY --parents docs/package.json docs/tsconfig.json ./

RUN bun install --ignore-scripts

COPY packages/ ./packages/

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "--cwd", "packages/providers/preview", "src/index.ts"]
