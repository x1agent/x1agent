# syntax=docker/dockerfile:1.7-labs
# Dev image for @x1agent/api. Code is NOT copied in — devspace sync
# mounts packages/ from the host at /app/packages at dev time. This image
# only provides the runtime + the workspace lockfile + installed deps.
FROM oven/bun:1.2.16-alpine

RUN apk add --no-cache bash tini

WORKDIR /app

# Glob in every workspace manifest so a new package can't silently break
# `bun install --frozen-lockfile`. Mirrors the prod Dockerfile.
COPY package.json bun.lock tsconfig.base.json ./
COPY --parents packages/**/package.json packages/**/tsconfig.json ./
COPY --parents docs/package.json docs/tsconfig.json ./

# --ignore-scripts skips the root `prepare` script that runs `git config`
# — there's no git in the image and the hook path is developer-only.
RUN bun install --frozen-lockfile --ignore-scripts

# Deploy migrations live here and the api binary loads them from a path
# relative to packages/api, so bake them into the image.
COPY deploy/migrations/ ./deploy/migrations/

# Platform-preset Dockerfiles. The seed reads these at boot so the
# container-registry detail view can show the actual Dockerfile to
# admins. Small text files — baking them in costs nothing.
COPY deploy/images/ ./deploy/images/
COPY packages/agent-claude/Dockerfile ./deploy/images/runtime-core/Dockerfile

# Devspace sync replaces packages/* at dev time; this COPY is just so the
# image is runnable on its own outside devspace (useful for CI smoke tests).
COPY packages/ ./packages/

EXPOSE 30001
ENV API_PORT=30001

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "--cwd", "packages/api", "src/index.ts"]
