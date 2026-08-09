#!/usr/bin/env bash
# Back up the stateful datastores for exactly one configured production install.
#
# Usage:
#   X1AGENT_DEPLOYMENT=x1agent.com mise run install:prod:backup
#
# The backup is written to backups/<deployment>/<UTC timestamp>/ and contains:
#   - Postgres globals plus one custom-format dump for every non-template DB
#   - One SurrealQL export for every SurrealDB namespace/database pair
#   - kubernetes-secrets.json.gpg — AES-256 encrypted namespace Secret export
#   - manifest.txt with the target, discovered databases, and checksums
#
# This script does not uninstall, scale, or mutate any Kubernetes resource.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLS_DIR="$ROOT/installs"

if [[ -z "${X1AGENT_DEPLOYMENT:-}" ]]; then
  echo "[install:prod:backup] set X1AGENT_DEPLOYMENT=<base-domain>; refusing to guess between installs." >&2
  exit 1
fi

DEPLOYMENT="$X1AGENT_DEPLOYMENT"
ENV_FILE="$INSTALLS_DIR/$DEPLOYMENT.local"
if [[ ! -f "$ENV_FILE" || "$DEPLOYMENT" == */* || "$DEPLOYMENT" == .* ]]; then
  echo "[install:prod:backup] deployment file not found: $ENV_FILE" >&2
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

if [[ -z "$PROJECT_ID" ]]; then
  echo "[install:prod:backup] GCP_PROJECT_ID missing in $ENV_FILE" >&2
  exit 1
fi
for tool in gcloud kubectl curl jq gpg openssl; do
  command -v "$tool" >/dev/null || {
    echo "[install:prod:backup] required command not found: $tool" >&2
    exit 1
  }
done

if [[ -n "${X1AGENT_BACKUP_KUBECONFIG:-}" ]]; then
  KCFG="$X1AGENT_BACKUP_KUBECONFIG"
  REMOVE_KCFG=false
else
  KCFG="$ROOT/.local/kubeconfig.$DEPLOYMENT"
  REMOVE_KCFG=true
fi
BACKUP_ROOT="${X1AGENT_BACKUP_DIR:-$INSTALLS_DIR/$DEPLOYMENT/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_ROOT/$STAMP"
mkdir -p "$(dirname "$KCFG")"
mkdir -p "$BACKUP_ROOT"
mkdir "$OUT"
mkdir "$OUT/postgres" "$OUT/surrealdb"
chmod 700 "$OUT" "$OUT/postgres" "$OUT/surrealdb"
PORT_FORWARD_PID=""
cleanup() {
  if [[ -n "$PORT_FORWARD_PID" ]]; then
    kill "$PORT_FORWARD_PID" 2>/dev/null || true
    wait "$PORT_FORWARD_PID" 2>/dev/null || true
  fi
  if [[ "$REMOVE_KCFG" == "true" ]]; then
    rm -f "$KCFG"
  fi
}
trap cleanup EXIT

echo "[install:prod:backup] deployment: $DEPLOYMENT"
echo "[install:prod:backup] cluster:    $CLUSTER ($REGION)"
echo "[install:prod:backup] namespace:  $NAMESPACE"
echo "[install:prod:backup] output:     $OUT"

KUBECONFIG="$KCFG" gcloud container clusters get-credentials "$CLUSTER" \
  --region "$REGION" --project "$PROJECT_ID" >/dev/null

kubectl_cmd=(kubectl --kubeconfig "$KCFG" --namespace "$NAMESPACE")

echo "[install:prod:backup] discovering PostgreSQL databases…"
PG_DATABASES=()
while IFS= read -r db; do
  [[ -n "$db" ]] && PG_DATABASES+=("$db")
done < <(
  "${kubectl_cmd[@]}" exec sts/postgres -- \
    psql -U x1agent -d x1agent -Atqc \
    "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname"
)
if [[ "${#PG_DATABASES[@]}" -eq 0 ]]; then
  echo "[install:prod:backup] PostgreSQL discovery returned no databases." >&2
  exit 1
fi

echo "[install:prod:backup] backing up PostgreSQL globals…"
"${kubectl_cmd[@]}" exec sts/postgres -- pg_dumpall -U x1agent --globals-only \
  > "$OUT/postgres/globals.sql"
chmod 600 "$OUT/postgres/globals.sql"

for db in "${PG_DATABASES[@]}"; do
  [[ -n "$db" ]] || continue
  if [[ ! "$db" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
    echo "[install:prod:backup] unsupported PostgreSQL database name: $db" >&2
    exit 1
  fi
  file_db="$db"
  echo "[install:prod:backup] pg_dump $db"
  "${kubectl_cmd[@]}" exec sts/postgres -- pg_dump -U x1agent -Fc \
    --no-owner --no-privileges --dbname="$db" > "$OUT/postgres/$file_db.dump"
  chmod 600 "$OUT/postgres/$file_db.dump"
done

SURR_TARGETS=()
if ! "${kubectl_cmd[@]}" get service surrealdb >/dev/null 2>&1; then
  echo "[install:prod:backup] SurrealDB service is not installed; skipping it"
else
echo "[install:prod:backup] discovering SurrealDB databases…"
SURREAL_PASS="$(val SURREALDB_ROOT_PASSWORD)"
SURREAL_PASS="${SURREAL_PASS:-x1agent-surreal-root}"

SURR_PORT="${X1AGENT_BACKUP_SURREAL_PORT:-18080}"
PORT_LOG="$OUT/surrealdb/port-forward.log"
"${kubectl_cmd[@]}" port-forward "svc/surrealdb" "$SURR_PORT:8000" > "$PORT_LOG" 2>&1 &
PORT_FORWARD_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$SURR_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:$SURR_PORT/health" >/dev/null 2>&1; then
  echo "[install:prod:backup] SurrealDB port-forward did not become ready." >&2
  cat "$PORT_LOG" >&2
  exit 1
fi

SURR_ROOT_JSON="$OUT/surrealdb/root-info.json"
curl -fsS -u "root:$SURREAL_PASS" \
  -H 'Accept: application/json' -H 'Surreal-NS: x1agent' -H 'Surreal-DB: x1agent' \
  --data 'INFO FOR ROOT;' "http://127.0.0.1:$SURR_PORT/sql" > "$SURR_ROOT_JSON"
chmod 600 "$SURR_ROOT_JSON"

SURR_NAMESPACES=()
while IFS= read -r db; do
  [[ -n "$db" ]] && SURR_NAMESPACES+=("$db")
done < <(
  jq -r '.[0].result.namespaces | keys[]' "$SURR_ROOT_JSON" | sort -u
)
if [[ "${#SURR_NAMESPACES[@]}" -eq 0 ]]; then
  echo "[install:prod:backup] no SurrealDB namespaces found." >&2
  echo "[install:prod:backup] root discovery was saved at $SURR_ROOT_JSON" >&2
  exit 1
fi

for ns in "${SURR_NAMESPACES[@]}"; do
  if [[ ! "$ns" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
    echo "[install:prod:backup] unsupported SurrealDB namespace name: $ns" >&2
    exit 1
  fi
  ns_file="$(printf '%s' "$ns" | tr -c 'A-Za-z0-9_.-' '_')"
  ns_json="$OUT/surrealdb/namespace-$ns_file.json"
  curl -fsS -u "root:$SURREAL_PASS" \
    -H 'Accept: application/json' -H "Surreal-NS: $ns" -H 'Surreal-DB: x1agent' \
    --data 'INFO FOR NS;' "http://127.0.0.1:$SURR_PORT/sql" > "$ns_json"
  chmod 600 "$ns_json"
  while IFS= read -r db; do
    [[ -n "$db" ]] && SURR_TARGETS+=("$ns|$db")
  done < <(jq -r '.[0].result.databases | keys[]' "$ns_json" | sort -u)
done
if [[ "${#SURR_TARGETS[@]}" -eq 0 ]]; then
  echo "[install:prod:backup] no SurrealDB databases found." >&2
  echo "[install:prod:backup] root discovery was saved at $SURR_ROOT_JSON" >&2
  exit 1
fi

for target in "${SURR_TARGETS[@]}"; do
  ns="${target%%|*}"
  db="${target#*|}"
  if [[ ! "$ns" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ || ! "$db" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
    echo "[install:prod:backup] unsupported SurrealDB target name: $ns/$db" >&2
    exit 1
  fi
  file_ns="$ns"
  file_db="$db"
  echo "[install:prod:backup] surreal export $ns/$db"
  curl -fsS -u "root:$SURREAL_PASS" \
    -H "Surreal-NS: $ns" -H "Surreal-DB: $db" \
    -H 'Accept: application/json' \
    "http://127.0.0.1:$SURR_PORT/export" > "$OUT/surrealdb/${file_ns}__${file_db}.surql"
  chmod 600 "$OUT/surrealdb/${file_ns}__${file_db}.surql"
done

kill "$PORT_FORWARD_PID" 2>/dev/null || true
wait "$PORT_FORWARD_PID" 2>/dev/null || true
PORT_FORWARD_PID=""
fi

BACKUP_KEY="${X1AGENT_BACKUP_KEY:-$INSTALLS_DIR/$DEPLOYMENT/backup.key}"
if [[ ! -f "$BACKUP_KEY" ]]; then
  echo "[install:prod:backup] generating $BACKUP_KEY"
  (umask 077 && openssl rand -hex 32 > "$BACKUP_KEY")
fi
chmod 600 "$BACKUP_KEY"

echo "[install:prod:backup] exporting Kubernetes Secrets (encrypted with $BACKUP_KEY)…"
"${kubectl_cmd[@]}" get secrets -o json \
  | gpg --batch --yes --pinentry-mode loopback \
      --passphrase-file "$BACKUP_KEY" --symmetric --cipher-algo AES256 \
      --output "$OUT/kubernetes-secrets.json.gpg"
chmod 600 "$OUT/kubernetes-secrets.json.gpg"

{
  echo "deployment=$DEPLOYMENT"
  echo "project=$PROJECT_ID"
  echo "cluster=$CLUSTER"
  echo "region=$REGION"
  echo "namespace=$NAMESPACE"
  echo "created_at_utc=$STAMP"
  echo
  echo "postgres_databases:"
  printf '  - %s\n' "${PG_DATABASES[@]}"
  echo
  echo "surrealdb_targets:"
  if [[ "${#SURR_TARGETS[@]}" -gt 0 ]]; then
    printf '  - %s\n' "${SURR_TARGETS[@]}"
  fi
  echo
  echo "sha256:"
  (
    cd "$OUT"
    shopt -s nullglob
    backup_files=(kubernetes-secrets.json.gpg postgres/* surrealdb/*)
    shasum -a 256 "${backup_files[@]}"
  )
} > "$OUT/manifest.txt"
chmod 600 "$OUT/manifest.txt"

echo "[install:prod:backup] complete: $OUT"
