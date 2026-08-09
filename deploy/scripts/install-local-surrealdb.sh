#!/usr/bin/env bash
# Add the local SurrealDB-backed graph/vector provider to an existing k3s
# installation. This is intentionally additive: it does not rebuild or apply
# the app, NATS, PostgreSQL, agent, or sidecar workloads.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAMESPACE="${X1AGENT_NAMESPACE:-x1agent}"

die() {
  echo "[install:local:surrealdb] ERROR: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

for command in kubectl docker; do
  need "$command"
done

# A mise-managed shell may resolve kubectl to a mise shim. If the checkout is
# not trusted yet, that shim exits before kubectl runs. Prefer the system k3s
# kubectl binary in that case; callers can still override it explicitly.
KUBECTL_CMD="${KUBECTL:-$(command -v kubectl)}"
if [[ "$KUBECTL_CMD" == */.local/share/mise/shims/kubectl ]]; then
  if [[ -x /usr/local/bin/kubectl ]]; then
    KUBECTL_CMD=/usr/local/bin/kubectl
  elif [[ -x /usr/bin/kubectl ]]; then
    KUBECTL_CMD=/usr/bin/kubectl
  else
    die "kubectl resolves to an untrusted mise shim and no system kubectl was found; set KUBECTL=/path/to/kubectl"
  fi
fi

if ! command -v k3s >/dev/null 2>&1; then
  die "k3s was not found; this command is for an existing k3s cluster"
fi

"$KUBECTL_CMD" version --request-timeout=10s >/dev/null || die "kubectl cannot reach the configured cluster"
"$KUBECTL_CMD" get nodes >/dev/null || die "kubectl cannot list nodes"
"$KUBECTL_CMD" get namespace "$NAMESPACE" >/dev/null || die "namespace does not exist: $NAMESPACE"
"$KUBECTL_CMD" -n "$NAMESPACE" get deployment api >/dev/null || die "existing api deployment was not found"
"$KUBECTL_CMD" -n "$NAMESPACE" get service nats >/dev/null || die "existing nats service was not found"

IMPORT_CMD=(sudo -n k3s ctr -n k8s.io images import -)
IMAGE="x1agent-provider-graph-surrealdb:latest"

echo "[install:local:surrealdb] building $IMAGE"
docker build -t "$IMAGE" \
  -f "$ROOT_DIR/deploy/docker/graph-surrealdb.dev.Dockerfile" \
  "$ROOT_DIR"

echo "[install:local:surrealdb] importing $IMAGE into k3s"
docker save "$IMAGE" | "${IMPORT_CMD[@]}"

echo "[install:local:surrealdb] applying SurrealDB and graph provider resources"
"$KUBECTL_CMD" -n "$NAMESPACE" apply -f "$ROOT_DIR/deploy/k8s/dev/surrealdb.yaml"
"$KUBECTL_CMD" -n "$NAMESPACE" apply -f "$ROOT_DIR/deploy/k8s/dev/graph-surrealdb.yaml"

"$KUBECTL_CMD" -n "$NAMESPACE" rollout status statefulset/surrealdb --timeout=180s
"$KUBECTL_CMD" -n "$NAMESPACE" rollout status deployment/graph-surrealdb --timeout=180s

# The dev API manifest uses Recreate. Switch to a zero-downtime rolling
# strategy before changing capability flags, so the old API remains available
# until the new pod is ready.
echo "[install:local:surrealdb] enabling graph/vector capabilities with a rolling API update"
"$KUBECTL_CMD" -n "$NAMESPACE" patch deployment api --type merge -p \
  '{"spec":{"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxUnavailable":0,"maxSurge":1}}}}'
"$KUBECTL_CMD" -n "$NAMESPACE" set env deployment/api \
  PROVIDER_GRAPH=surrealdb \
  PROVIDER_VECTOR=surrealdb
"$KUBECTL_CMD" -n "$NAMESPACE" rollout status deployment/api --timeout=180s

echo "[install:local:surrealdb] complete"
echo "[install:local:surrealdb] graph/vector capabilities are now backed by SurrealDB"
echo "[install:local:surrealdb] verify: kubectl -n $NAMESPACE get pods,svc,pvc"
