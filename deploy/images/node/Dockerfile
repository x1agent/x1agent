# x1agent preset: Node.js 22 LTS
#
# Node 22 ("Jod") is the current Active LTS. runtime-core already ships
# Node 22 + tsx, so this preset is a thin extension that adds TypeScript
# CLI (`tsc`) and the pnpm package manager — the two tools that most
# TypeScript codebases assume are globally available.
#
# BASE_IMAGE default: the local runtime-core tag.

ARG BASE_IMAGE=x1agent/runtime-core:v1
FROM ${BASE_IMAGE}

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
      ripgrep \
      jq \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g typescript@5 pnpm@9 \
  && node --version \
  && npm --version \
  && tsc --version \
  && pnpm --version

USER node
