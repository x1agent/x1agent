#!/usr/bin/env bash
# Build + push the production images (api, app, preview, graph-surrealdb)
# to the install's Artifact Registry.
#
# Provider images (graph-surrealdb today; messaging-slack next) build
# unconditionally — Helm decides whether to actually deploy them based
# on `providers.graph: ...` in the install file. Building unused images
# is cheap (cached layers) and keeps the build matrix simple.
#
# Caller (mise run install orchestrator OR a human running ad-hoc) is
# responsible for handing this script the active deployment file via
# the ENV_FILE env var. We deliberately do NOT re-resolve which file
# is active — single source of truth lives in the caller.
#
# Usage:
#   ENV_FILE=installs/x1agent.com.local ./build-push-prod.sh
#   ENV_FILE=... IMAGE_TAG=v0.2.0 ./build-push-prod.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

: "${ENV_FILE:?ENV_FILE not set — pass the deployment file path, e.g. ENV_FILE=installs/<base-domain>.local}"
[ -f "$ENV_FILE" ] || { echo "[build-push] $ENV_FILE missing." >&2; exit 1; }
echo "[build-push] reading $ENV_FILE"

# Source the deployment file without echoing values.
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

[ "${CLOUD_PROVIDER:-}" = "gcp" ] || { echo "[build-push] CLOUD_PROVIDER=${CLOUD_PROVIDER:-(unset)} — only 'gcp' supported." >&2; exit 1; }
: "${GCP_PROJECT_ID:?GCP_PROJECT_ID not set in deployment file}"
: "${BASE_DOMAIN:?BASE_DOMAIN not set in deployment file}"
REGION="${GCP_REGION:-us-central1}"
AR="${ARTIFACT_REGISTRY:-${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/x1agent}"

TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "[build-push] project: $GCP_PROJECT_ID"
echo "[build-push] AR repo: $AR"
echo "[build-push] tag:     $TAG"

# Make sure docker is authed for AR. Idempotent.
echo "[build-push] configuring docker auth for $REGION-docker.pkg.dev"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

build_push() {
  local name="$1" dockerfile="$2"
  local img="${AR}/${name}:${TAG}"
  local img_latest="${AR}/${name}:latest"
  echo "[build-push] [$name] building $img"
  # --platform linux/amd64 because GKE nodes default to amd64. If you
  # use ARM nodepools, override IMAGE_PLATFORM=linux/arm64.
  DOCKER_BUILDKIT=1 docker build \
    --platform "${IMAGE_PLATFORM:-linux/amd64}" \
    -f "$ROOT/$dockerfile" \
    -t "$img" \
    -t "$img_latest" \
    "$ROOT"
  echo "[build-push] [$name] pushing"
  docker push "$img"
  docker push "$img_latest"
}

# app needs its public URLs as build-args because Astro inlines them.
build_push_app() {
  local img="${AR}/app:${TAG}"
  local img_latest="${AR}/app:latest"
  echo "[build-push] [app] building $img"
  DOCKER_BUILDKIT=1 docker build \
    --platform "${IMAGE_PLATFORM:-linux/amd64}" \
    -f "$ROOT/deploy/docker/app.prod.Dockerfile" \
    --build-arg "PUBLIC_API_URL=https://api.${BASE_DOMAIN}" \
    --build-arg "PUBLIC_URL=https://app.${BASE_DOMAIN}" \
    --build-arg "PUBLIC_SENTRY_DSN_APP=${PUBLIC_SENTRY_DSN_APP:-}" \
    --build-arg "SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN:-}" \
    --build-arg "SENTRY_RELEASE=${TAG}" \
    -t "$img" \
    -t "$img_latest" \
    "$ROOT"
  echo "[build-push] [app] pushing"
  docker push "$img"
  docker push "$img_latest"
}

build_push      api              deploy/docker/api.prod.Dockerfile
build_push_app
build_push      preview          deploy/docker/preview.prod.Dockerfile
build_push      graph-surrealdb  deploy/docker/graph-surrealdb.prod.Dockerfile
build_push      google-workspace deploy/docker/google-workspace.prod.Dockerfile
build_push      mcp-oauth-proxy  deploy/docker/mcp-oauth-proxy.prod.Dockerfile

# agent + sidecar — session pod images. Build context lives in the
# package directory (each owns its own Dockerfile) rather than the
# monorepo root, so they bypass the build_push helper which assumes
# root context.
build_push_session() {
  local name="$1" path="$2"
  local img="${AR}/${name}:${TAG}"
  local img_latest="${AR}/${name}:latest"
  echo "[build-push] [$name] building $img"
  DOCKER_BUILDKIT=1 docker build \
    --platform "${IMAGE_PLATFORM:-linux/amd64}" \
    -f "$ROOT/$path/Dockerfile" \
    -t "$img" \
    -t "$img_latest" \
    "$ROOT/$path"
  docker push "$img"
  docker push "$img_latest"
}
build_push_session agent    packages/agent
build_push_session sidecar  packages/sidecar

echo "[build-push] done"
echo "[build-push] tag pushed: $TAG"
echo "[build-push] next:       INSTALL_IMAGE_TAG=$TAG mise run install:apply"
