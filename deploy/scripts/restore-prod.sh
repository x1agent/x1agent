#!/usr/bin/env bash
# Restore one explicit production install from a backup created by
# deploy/scripts/backup-prod.sh.
#
# Usage:
#   X1AGENT_DEPLOYMENT=x1agent.com \
#     mise run install:prod:restore -- installs/x1agent.com/backups/<timestamp>
#
# This is intentionally confirmation-gated and destructive at the object/table
# level. It restores Kubernetes Secrets, PostgreSQL databases, and SurrealDB
# databases; External Secrets may subsequently reconcile Secrets from GSM.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLS_DIR="$ROOT/installs"

if [[ -z "${X1AGENT_DEPLOYMENT:-}" ]]; then
  echo "[install:prod:restore] set X1AGENT_DEPLOYMENT=<base-domain>; refusing to guess between installs." >&2
  exit 1
fi
DEPLOYMENT="$X1AGENT_DEPLOYMENT"
ENV_FILE="$INSTALLS_DIR/$DEPLOYMENT.local"
if [[ ! -f "$ENV_FILE" || "$DEPLOYMENT" == */* || "$DEPLOYMENT" == .* ]]; then
  echo "[install:prod:restore] deployment file not found: $ENV_FILE" >&2
  exit 1
fi

BACKUP_DIR="${1:-${X1AGENT_BACKUP_PATH:-}}"
if [[ -z "$BACKUP_DIR" || ! -d "$BACKUP_DIR" ]]; then
  echo "usage: X1AGENT_DEPLOYMENT=$DEPLOYMENT mise run install:prod:restore -- <backup-directory>" >&2
  exit 1
fi
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
MANIFEST="$BACKUP_DIR/manifest.txt"
if [[ ! -f "$MANIFEST" ]]; then
  echo "[install:prod:restore] missing manifest: $MANIFEST" >&2
  exit 1
fi
if ! grep -qx "deployment=$DEPLOYMENT" "$MANIFEST"; then
  echo "[install:prod:restore] backup deployment does not match X1AGENT_DEPLOYMENT=$DEPLOYMENT" >&2
  exit 1
fi

val() {
  local key="$1"
  awk -v k="$key" '$0 ~ "^" k "=" { sub(/^[^=]*=/, ""); sub(/^"/, ""); sub(/"$/, ""); print; exit }' "$ENV_FILE"
}
PROJECT_ID="$(val GCP_PROJECT_ID)"
REGION="$(val GCP_REGION)"
CLUSTER="$(val GKE_CLUSTER_NAME)"
NAMESPACE="$(val K8S_NAMESPACE)"
REGION="${REGION:-us-central1}"
CLUSTER="${CLUSTER:-x1agent}"
NAMESPACE="${NAMESPACE:-x1agent}"

for tool in gcloud kubectl curl jq gpg shasum; do
  command -v "$tool" >/dev/null || {
    echo "[install:prod:restore] required command not found: $tool" >&2
    exit 1
  }
done
if [[ -z "$PROJECT_ID" ]]; then
  echo "[install:prod:restore] GCP_PROJECT_ID missing in $ENV_FILE" >&2
  exit 1
fi

for target in \
  "project|$PROJECT_ID" \
  "cluster|$CLUSTER" \
  "region|$REGION" \
  "namespace|$NAMESPACE"; do
  key="${target%%|*}"
  expected="${target#*|}"
  actual="$(awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$MANIFEST")"
  if [[ "$actual" != "$expected" ]]; then
    echo "[install:prod:restore] manifest $key=$actual does not match target $key=$expected" >&2
    exit 1
  fi
done

CHECKSUMS="$(awk 'found { print } /^sha256:$/ { found=1 }' "$MANIFEST")"
if [[ -z "$CHECKSUMS" ]]; then
  echo "[install:prod:restore] manifest contains no checksums" >&2
  exit 1
fi
while IFS= read -r checksum; do
  if [[ ! "$checksum" =~ ^[0-9a-f]{64}\ \ [A-Za-z0-9_./-]+$ ]]; then
    echo "[install:prod:restore] invalid checksum entry: $checksum" >&2
    exit 1
  fi
  checksum_path="${checksum#*  }"
  if [[ "$checksum_path" == /* || "/$checksum_path/" == *"/../"* ]]; then
    echo "[install:prod:restore] unsafe checksum path: $checksum_path" >&2
    exit 1
  fi
done <<< "$CHECKSUMS"
echo "[install:prod:restore] verifying backup checksums…"
if ! (cd "$BACKUP_DIR" && printf '%s\n' "$CHECKSUMS" | shasum -a 256 --check --status); then
  echo "[install:prod:restore] backup checksum verification failed" >&2
  exit 1
fi

BACKUP_KEY="${X1AGENT_BACKUP_KEY:-$INSTALLS_DIR/$DEPLOYMENT/backup.key}"
if [[ ! -f "$BACKUP_KEY" ]]; then
  echo "[install:prod:restore] backup key not found: $BACKUP_KEY" >&2
  exit 1
fi
chmod 600 "$BACKUP_KEY"

if [[ "${X1AGENT_RESTORE_YES:-}" != "1" ]]; then
  echo "This will overwrite database objects and Kubernetes Secrets in $DEPLOYMENT from:"
  echo "  $BACKUP_DIR"
  printf 'Type %s to continue: ' "$DEPLOYMENT"
  read -r confirmation
  [[ "$confirmation" == "$DEPLOYMENT" ]] || {
    echo "[install:prod:restore] cancelled." >&2
    exit 1
  }
fi

if [[ -n "${X1AGENT_RESTORE_KUBECONFIG:-}" ]]; then
  KCFG="$X1AGENT_RESTORE_KUBECONFIG"
  REMOVE_KCFG=false
else
  KCFG="$ROOT/.local/kubeconfig.$DEPLOYMENT"
  REMOVE_KCFG=true
fi
mkdir -p "$(dirname "$KCFG")"
tmp_secrets=""
cleanup_files() {
  if [[ "$REMOVE_KCFG" == "true" ]]; then
    rm -f "$KCFG"
  fi
  [[ -z "$tmp_secrets" ]] || rm -f "$tmp_secrets"
}
trap cleanup_files EXIT
KUBECONFIG="$KCFG" gcloud container clusters get-credentials "$CLUSTER" \
  --region "$REGION" --project "$PROJECT_ID" >/dev/null
kubectl_cmd=(kubectl --kubeconfig "$KCFG" --namespace "$NAMESPACE")

SECRETS="$BACKUP_DIR/kubernetes-secrets.json.gpg"
if [[ -f "$SECRETS" ]]; then
  echo "[install:prod:restore] decrypting and applying Kubernetes Secrets…"
  tmp_secrets="$(mktemp)"
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_KEY" \
    --decrypt "$SECRETS" \
    | jq -c '.items[] | {apiVersion:"v1",kind:"Secret",metadata:{name:.metadata.name,namespace:.metadata.namespace,labels:.metadata.labels,annotations:.metadata.annotations},type:.type,data:.data,stringData:.stringData}' \
    > "$tmp_secrets"
  jq -s '{apiVersion:"v1",kind:"List",items:.}' "$tmp_secrets" \
    | "${kubectl_cmd[@]}" apply -f -
fi

PG_DIR="$BACKUP_DIR/postgres"
if [[ -f "$PG_DIR/globals.sql" ]]; then
  echo "[install:prod:restore] restoring PostgreSQL roles/globals…"
  "${kubectl_cmd[@]}" exec -i sts/postgres -- psql -U x1agent -d postgres \
    -v ON_ERROR_STOP=0 < "$PG_DIR/globals.sql" >/dev/null
fi
for dump in "$PG_DIR"/*.dump; do
  [[ -f "$dump" ]] || continue
  db="$(basename "$dump" .dump)"
  [[ "$db" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || {
    echo "[install:prod:restore] unsafe database filename: $dump" >&2
    exit 1
  }
  exists="$("${kubectl_cmd[@]}" exec sts/postgres -- psql -U x1agent -d postgres -Atqc \
    "SELECT 1 FROM pg_database WHERE datname = '$db'")"
  if [[ "$exists" != "1" ]]; then
    "${kubectl_cmd[@]}" exec sts/postgres -- psql -U x1agent -d postgres -c \
      "CREATE DATABASE \"$db\"" >/dev/null
  fi
  echo "[install:prod:restore] restoring PostgreSQL $db"
  "${kubectl_cmd[@]}" exec -i sts/postgres -- pg_restore -U x1agent \
    --dbname="$db" --clean --if-exists --no-owner --no-privileges \
    --exit-on-error < "$dump" >/dev/null
done

SURR_TARGETS=()
while IFS='|' read -r ns db; do
  [[ -n "$ns" && -n "$db" ]] || continue
  [[ "$ns" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ && "$db" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || {
    echo "[install:prod:restore] unsafe SurrealDB target in manifest: $ns/$db" >&2
    exit 1
  }
  SURR_TARGETS+=("$ns|$db")
done < <(awk '/^  - [^|]+\|[^|]+$/ { sub(/^  - /, ""); print }' "$MANIFEST")

if [[ "${#SURR_TARGETS[@]}" -gt 0 ]]; then
  SURREAL_PASS="$(val SURREALDB_ROOT_PASSWORD)"
  SURREAL_PASS="${SURREAL_PASS:-x1agent-surreal-root}"
  SURR_PORT="${X1AGENT_RESTORE_SURREAL_PORT:-18081}"
  PORT_LOG="$(mktemp "${TMPDIR:-/tmp}/x1agent-restore-port-forward.XXXXXX")"
  "${kubectl_cmd[@]}" port-forward svc/surrealdb "$SURR_PORT:8000" > "$PORT_LOG" 2>&1 &
  PORT_FORWARD_PID=$!
  cleanup() {
    kill "$PORT_FORWARD_PID" 2>/dev/null || true
    wait "$PORT_FORWARD_PID" 2>/dev/null || true
    rm -f "$PORT_LOG"
    cleanup_files
  }
  trap cleanup EXIT
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsS "http://127.0.0.1:$SURR_PORT/health" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -fsS "http://127.0.0.1:$SURR_PORT/health" >/dev/null; then
    echo "[install:prod:restore] SurrealDB port-forward did not become ready" >&2
    cat "$PORT_LOG" >&2
    exit 1
  fi

  for target in "${SURR_TARGETS[@]}"; do
    ns="${target%%|*}"
    db="${target#*|}"
    file_ns="$ns"
    file_db="$db"
    file="$BACKUP_DIR/surrealdb/${file_ns}__${file_db}.surql"
    [[ -f "$file" ]] || { echo "[install:prod:restore] missing SurrealDB export: $file" >&2; exit 1; }
    echo "[install:prod:restore] importing SurrealDB $ns/$db"
    curl -fsS -u "root:$SURREAL_PASS" \
      -H "Surreal-NS: $ns" -H "Surreal-DB: $db" \
      -H 'Accept: application/json' --data-binary "@$file" \
      "http://127.0.0.1:$SURR_PORT/import" >/dev/null
  done
fi

echo "[install:prod:restore] complete: $DEPLOYMENT from $BACKUP_DIR"
