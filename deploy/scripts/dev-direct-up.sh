#!/usr/bin/env bash
# Brings up the x1agent dev stack WITHOUT devspace.
#
# Why: devspace's hot-reload + image-build orchestration sometimes
# masks problems that only show up at boot — and rebuilding session
# images / sidecar code through devspace has been flaky. This is the
# deterministic baseline: plain `docker build` + `kubectl apply`.
#
# Steps:
#   1. Build all 5 dev images locally (parallel docker build).
#      OrbStack shares its docker daemon with k8s, so the kubelet
#      sees the new images directly — no registry push needed.
#   2. Create the Secret/x1agent-dev-secrets from a filtered set of
#      env vars (only the keys the manifests opt into via envFrom).
#   3. kubectl apply -f deploy/k8s/dev/.
#   4. kubectl rollout restart on app deployments to force fresh pods
#      that pick up both the new image tag and the new envFrom.
#   5. kubectl rollout status on each, fail fast on hangs.
#
# Idempotent. Safe to re-run. Does not touch agent/sidecar images
# (those go through `mise run images:session`).

set -euo pipefail

NS="${NAMESPACE:-x1agent}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Hard guard — only run against OrbStack.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./dev-preflight.sh
source "$SCRIPT_DIR/dev-preflight.sh"
kc() { kubectl "${KCTX_ARGS[@]}" "$@"; }

echo "[dev:direct] context: $(kc config current-context)"
echo "[dev:direct] namespace: $NS"

# 1. Build images. All 5 in parallel — bun + alpine layers cache well
#    after the first build, so re-runs are fast.
build_one() {
  local name="$1" dockerfile="$2"
  echo "[dev:direct] [$name] build start"
  if DOCKER_BUILDKIT=1 docker build \
      -f "$ROOT/$dockerfile" \
      -t "x1agent-$name:latest" \
      "$ROOT" > "/tmp/dev-direct-build-$name.log" 2>&1; then
    echo "[dev:direct] [$name] build ok"
  else
    echo "[dev:direct] [$name] build FAILED — see /tmp/dev-direct-build-$name.log" >&2
    return 1
  fi
}

declare -a BUILDS=(
  "api:deploy/docker/api.dev.Dockerfile"
  "app:deploy/docker/app.dev.Dockerfile"
  "provider-messaging-slack:deploy/docker/messaging-slack.dev.Dockerfile"
  "provider-graph-surrealdb:deploy/docker/graph-surrealdb.dev.Dockerfile"
  "provider-preview:deploy/docker/preview.dev.Dockerfile"
)

pids=()
for spec in "${BUILDS[@]}"; do
  name="${spec%%:*}"; df="${spec#*:}"
  build_one "$name" "$df" &
  pids+=($!)
done
fail=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then fail=1; fi
done
[ "$fail" -eq 0 ] || { echo "[dev:direct] one or more builds failed"; exit 1; }

# 2. Secret from env. Filtered list — we deliberately don't dump the
#    whole .env.local into the cluster.
SECRET_KEYS=(
  JWT_SECRET
  GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET
  ALLOWED_DOMAINS PLATFORM_ADMIN_EMAILS AUTH_BYPASS TEST_USER
  GITHUB_APP_ID GITHUB_APP_SLUG GITHUB_APP_CLIENT_ID GITHUB_APP_CLIENT_SECRET
  GITHUB_APP_PRIVATE_KEY GITHUB_APP_WEBHOOK_SECRET
  ANTHROPIC_API_KEY API_INTERNAL_TOKEN
  HOST_HOME_DIR HOST_CLAUDE_CREDENTIALS_FILE
  SLACK_BOT_TOKEN
)

TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENV"' EXIT
for k in "${SECRET_KEYS[@]}"; do
  v="${!k:-}"
  printf '%s=%s\n' "$k" "$v" >> "$TMP_ENV"
done

echo "[dev:direct] applying Secret/x1agent-dev-secrets (${#SECRET_KEYS[@]} keys, values not printed)"
kc create secret generic x1agent-dev-secrets \
  -n "$NS" \
  --from-env-file="$TMP_ENV" \
  --dry-run=client -o yaml | kc apply -n "$NS" -f -

# 3. Apply all dev manifests. preview.yaml carries cross-namespace
#    RBAC for x1-previews — the namespace must exist first.
kc get ns x1-previews >/dev/null 2>&1 || kc create ns x1-previews

echo "[dev:direct] applying deploy/k8s/dev/"
kc apply -n "$NS" -f "$ROOT/deploy/k8s/dev/"

# 4. Force a fresh roll on app pods so they pick up the just-built
#    images + envFrom. Infra pods (postgres/nats/registry/surrealdb)
#    are stable; only roll them if they're not already Ready.
ROLL_DEPLOYS=(api app preview messaging-slack graph-surrealdb)
for d in "${ROLL_DEPLOYS[@]}"; do
  if kc -n "$NS" get deploy "$d" >/dev/null 2>&1; then
    kc -n "$NS" rollout restart "deploy/$d"
  fi
done

# 5. Wait for everything. infra first, then apps.
WAIT_DEPLOYS=(postgres nats surrealdb x1-registry api app preview messaging-slack graph-surrealdb)
for d in "${WAIT_DEPLOYS[@]}"; do
  if ! kc -n "$NS" get deploy "$d" >/dev/null 2>&1; then continue; fi
  echo "[dev:direct] waiting for deploy/$d"
  if ! kc -n "$NS" rollout status "deploy/$d" --timeout=300s; then
    echo "[dev:direct] $d failed to roll — recent events:" >&2
    kc -n "$NS" get events --sort-by=.lastTimestamp | tail -20
    kc -n "$NS" describe deploy "$d" | tail -40 >&2
    exit 1
  fi
done

echo "[dev:direct] stack is up"
echo "[dev:direct]   app  → https://app.local.x1agent.dev"
echo "[dev:direct]   api  → https://api.local.x1agent.dev"
