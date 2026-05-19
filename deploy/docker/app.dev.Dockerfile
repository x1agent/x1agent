# syntax=docker/dockerfile:1.7-labs
# Dev image for @x1agent/app. Code is NOT copied in — devspace sync
# mounts packages/ from the host at /app/packages at dev time. This image
# only provides the runtime + the workspace lockfile + installed deps.
#
# The app runs in the cluster (not on the host) so it can be reached
# through ingress-nginx at https://app.local.x1agent.dev, sharing the
# cookie domain with the api.
#
# Base image choice mirrors app.prod.Dockerfile's `builder` stage:
# astro >= 6 requires Node >= 22.12. The bun:1.2.16-alpine image bundles
# Node 22.6, so `astro dev` exits immediately. Solution: real Node base,
# bun installed on top for `bun install`.
FROM node:22.13-alpine

RUN apk add --no-cache bash tini curl unzip && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.2.16" && \
    ln -sf /usr/local/bin/bun /usr/local/bin/bunx

WORKDIR /app

# Glob in every workspace manifest so a new package can't silently break
# `bun install --frozen-lockfile`. Mirrors the prod Dockerfile.
COPY package.json bun.lock tsconfig.base.json ./
COPY --parents packages/**/package.json packages/**/tsconfig.json ./
COPY --parents docs/package.json docs/tsconfig.json ./

RUN bun install --ignore-scripts

# Devspace sync replaces packages/* at dev time; this COPY is just so the
# image is runnable on its own outside devspace.
COPY packages/ ./packages/

EXPOSE 4322

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "--cwd", "packages/app", "dev"]
