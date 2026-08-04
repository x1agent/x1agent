#!/usr/bin/env bash
# Install the local development stack into an already-running single-node
# k3s cluster. This is separate from the OrbStack and GKE paths.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAMESPACE="${X1AGENT_NAMESPACE:-x1agent}"
BASE_DOMAIN="${X1AGENT_LOCAL_BASE_DOMAIN:-agentbox.local}"
APP_HOST="${X1AGENT_APP_HOST:-app.${BASE_DOMAIN}}"
API_HOST="${X1AGENT_API_HOST:-api.${BASE_DOMAIN}}"
URL_SCHEME="${X1AGENT_LOCAL_SCHEME:-http}"
ENABLE_SURREALDB="${X1AGENT_ENABLE_SURREALDB:-false}"
ENV_FILE="${X1AGENT_ENV_FILE:-${ROOT_DIR}/.env.local}"
LOCAL_DIR="${X1AGENT_LOCAL_DIR:-${ROOT_DIR}/.local/k3s}"
CODEX_PROFILE_DIR="${HOST_CODEX_HOME_DIR:-${HOME}/.x1agent-dev/codex-home}"

die() { echo "[install:local:k3s] ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

for command in kubectl docker openssl envsubst bun; do need "$command"; done
kubectl version --request-timeout=10s >/dev/null || die "kubectl cannot reach the configured cluster"
kubectl get nodes >/dev/null || die "kubectl cannot list nodes"

if command -v k3s >/dev/null 2>&1; then
  IMPORT_CMD=(sudo -n k3s ctr -n k8s.io images import -)
else
  die "could not identify the cluster runtime (expected k3s; agentbox is not using k3d)"
fi

[[ -f "$ENV_FILE" ]] || die "missing env file: $ENV_FILE"
[[ "$CODEX_PROFILE_DIR" == /* ]] || die "HOST_CODEX_HOME_DIR must be an absolute path"
mkdir -p "$LOCAL_DIR"
chmod 700 "$LOCAL_DIR"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/x1agent-k3s.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[install:local:k3s] cluster: $(kubectl config current-context 2>/dev/null || echo unknown)"
echo "[install:local:k3s] namespace: $NAMESPACE"
[[ "$URL_SCHEME" == "http" || "$URL_SCHEME" == "https" ]] || die "X1AGENT_LOCAL_SCHEME must be http or https"
[[ "$ENABLE_SURREALDB" == "true" || "$ENABLE_SURREALDB" == "false" ]] || die "X1AGENT_ENABLE_SURREALDB must be true or false"
echo "[install:local:k3s] app: ${URL_SCHEME}://${APP_HOST}"
echo "[install:local:k3s] api: ${URL_SCHEME}://${API_HOST}"

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
X1AGENT_NAMESPACE="$NAMESPACE" bun run "$ROOT_DIR/deploy/scripts/create-local-secrets.ts" "$ENV_FILE" \
  | kubectl apply -f - >/dev/null

if kubectl -n "$NAMESPACE" get secret nats-tls >/dev/null 2>&1; then
  echo "[install:local:k3s] nats-tls already exists; keeping it"
else
  CERT_DIR="$LOCAL_DIR/nats-certs"
  mkdir -p "$CERT_DIR"
  chmod 700 "$CERT_DIR"
  openssl genrsa -out "$CERT_DIR/ca.key" 4096 2>/dev/null
  openssl req -x509 -new -nodes -key "$CERT_DIR/ca.key" -sha256 -days 3650 \
    -subj "/CN=x1agent-nats-ca-local" -out "$CERT_DIR/ca.crt" 2>/dev/null
  openssl genrsa -out "$CERT_DIR/server.key" 4096 2>/dev/null
  openssl req -new -key "$CERT_DIR/server.key" -subj "/CN=nats" -out "$CERT_DIR/server.csr" 2>/dev/null
  cat >"$CERT_DIR/server.ext" <<'EOF'
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt_names
[alt_names]
DNS.1=nats
DNS.2=nats.x1agent
DNS.3=nats.x1agent.svc
DNS.4=nats.x1agent.svc.cluster.local
DNS.5=localhost
IP.1=127.0.0.1
EOF
  openssl x509 -req -in "$CERT_DIR/server.csr" -CA "$CERT_DIR/ca.crt" \
    -CAkey "$CERT_DIR/ca.key" -CAcreateserial -out "$CERT_DIR/server.crt" \
    -days 3650 -sha256 -extfile "$CERT_DIR/server.ext" 2>/dev/null
  openssl genrsa -out "$CERT_DIR/client.key" 4096 2>/dev/null
  openssl req -new -key "$CERT_DIR/client.key" -subj "/CN=x1agent-client" -out "$CERT_DIR/client.csr" 2>/dev/null
  cat >"$CERT_DIR/client.ext" <<'EOF'
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
EOF
  openssl x509 -req -in "$CERT_DIR/client.csr" -CA "$CERT_DIR/ca.crt" \
    -CAkey "$CERT_DIR/ca.key" -CAcreateserial -out "$CERT_DIR/client.crt" \
    -days 3650 -sha256 -extfile "$CERT_DIR/client.ext" 2>/dev/null
  kubectl -n "$NAMESPACE" create secret generic nats-tls \
    --from-file=ca.crt="$CERT_DIR/ca.crt" --from-file=server.crt="$CERT_DIR/server.crt" \
    --from-file=server.key="$CERT_DIR/server.key" --from-file=client.crt="$CERT_DIR/client.crt" \
    --from-file=client.key="$CERT_DIR/client.key"
fi

build_image() {
  local dockerfile="$1" context="$2"
  shift 2
  local tags=("$@")
  local tag_args=()
  local tag
  for tag in "${tags[@]}"; do
    tag_args+=(--tag "$tag")
  done
  echo "[install:local:k3s] building ${tags[*]}"
  docker build "${tag_args[@]}" -f "$ROOT_DIR/$dockerfile" "$ROOT_DIR/$context" >/dev/null
  echo "[install:local:k3s] importing ${tags[*]} into k3s containerd"
  docker save "${tags[@]}" | "${IMPORT_CMD[@]}" >/dev/null
}

build_image deploy/docker/api.dev.Dockerfile . x1agent-api:latest
build_image deploy/docker/app.dev.Dockerfile . x1agent-app:latest
build_image packages/agent-claude/Dockerfile . \
  x1agent-agent:latest \
  x1agent/runtime-core:v1 \
  x1-registry.x1agent.svc.cluster.local:5000/x1agent/runtime-core:v1
build_image packages/agent-codex/Dockerfile . \
  x1agent/runtime-codex:v1 \
  x1-registry.x1agent.svc.cluster.local:5000/x1agent/runtime-codex:v1
build_image packages/sidecar/Dockerfile packages/sidecar x1agent-sidecar:latest
build_image deploy/docker/mcp-oauth-proxy.dev.Dockerfile . x1agent-mcp-oauth-proxy:latest
if [[ "$ENABLE_SURREALDB" == "true" ]]; then
  build_image deploy/docker/graph-surrealdb.dev.Dockerfile . x1agent-provider-graph-surrealdb:latest
fi

echo "[install:local:k3s] applying stateful services and application"
kubectl -n "$NAMESPACE" apply -f "$ROOT_DIR/deploy/k8s/dev/postgres.yaml"
kubectl -n "$NAMESPACE" apply -f "$ROOT_DIR/deploy/k8s/dev/nats.yaml"
if [[ "$ENABLE_SURREALDB" == "true" ]]; then
  kubectl -n "$NAMESPACE" apply -f "$ROOT_DIR/deploy/k8s/dev/surrealdb.yaml"
  kubectl -n "$NAMESPACE" apply -f "$ROOT_DIR/deploy/k8s/dev/graph-surrealdb.yaml"
fi

sed -e "/- name: API_PUBLIC_URL/{n;s#value: .*#value: ${URL_SCHEME}://${API_HOST}#;}" \
    -e "/- name: PUBLIC_URL/{n;s#value: .*#value: ${URL_SCHEME}://${APP_HOST}#;}" \
    "$ROOT_DIR/deploy/k8s/dev/api.yaml" >"$TMP_DIR/api.yaml"
if [[ "$ENABLE_SURREALDB" == "false" ]]; then
  sed -i -e '/name: PROVIDER_GRAPH/{n;s/value: surrealdb/value: none/;}' \
         -e '/name: PROVIDER_VECTOR/{n;s/value: surrealdb/value: none/;}' "$TMP_DIR/api.yaml"
fi
sed -e "/- name: PUBLIC_API_URL/{n;s#value: .*#value: ${URL_SCHEME}://${API_HOST}#;}" \
    -e "/- name: PUBLIC_URL/{n;s#value: .*#value: ${URL_SCHEME}://${APP_HOST}#;}" \
    "$ROOT_DIR/deploy/k8s/dev/app.yaml" >"$TMP_DIR/app.yaml"
APP_HOST="$APP_HOST" API_HOST="$API_HOST" envsubst \
  <"$ROOT_DIR/deploy/k8s/dev/ingress-traefik-local.yaml.template" >"$TMP_DIR/ingress.yaml"
kubectl -n "$NAMESPACE" apply -f "$TMP_DIR/api.yaml"
kubectl -n "$NAMESPACE" apply -f "$TMP_DIR/app.yaml"
kubectl -n "$NAMESPACE" apply -f "$TMP_DIR/ingress.yaml"
kubectl -n "$NAMESPACE" set env deployment/api HOST_CODEX_HOME_DIR="$CODEX_PROFILE_DIR" >/dev/null

if [[ ! -f "$CODEX_PROFILE_DIR/auth.json" ]]; then
  echo "[install:local:k3s] warning: $CODEX_PROFILE_DIR/auth.json is missing; Codex sessions will need login first" >&2
fi

echo
echo "[install:local:k3s] installed in namespace $NAMESPACE"
echo "[install:local:k3s] add this to the browsing machine's hosts file:"
echo "  <agentbox-ip> ${APP_HOST} ${API_HOST}"
echo "[install:local:k3s] check: kubectl -n $NAMESPACE get pods,ingress"
echo "[install:local:k3s] Codex profile: $CODEX_PROFILE_DIR"
echo "[install:local:k3s] local TLS material is in $LOCAL_DIR (mode 700)"
