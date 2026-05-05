#!/usr/bin/env bash
# Drop into an interactive psql shell against the active deployment's
# in-cluster postgres. Convenience wrapper for ad-hoc support tasks
# (e.g. wiping a stale DCR client when an MCP rotates its registration).
#
# Reads the deployment config from installs/<base-domain>.local — same
# resolution rule as `mise run logs`. Writes a per-deployment kubeconfig
# at ~/.kube/config.x1agent.<projectId> so this never pollutes OrbStack.
#
# Usage (via mise):
#   mise run psql:prod
#
# Inside the shell, common one-shots:
#   \dt                                     # list tables
#   SELECT * FROM workspaces;
#   \q                                      # quit

set -euo pipefail

INSTALLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../installs" && pwd)"

# Pick the active install — explicit X1AGENT_DEPLOYMENT wins, otherwise
# the single non-example file in installs/.
if [[ -n "${X1AGENT_DEPLOYMENT:-}" ]]; then
  ENV_FILE="$INSTALLS_DIR/${X1AGENT_DEPLOYMENT}.local"
else
  CANDIDATES=("$INSTALLS_DIR"/*.local)
  ACTIVE=""
  for c in "${CANDIDATES[@]}"; do
    base="$(basename "$c")"
    [[ "$base" == "example.local" ]] && continue
    if [[ -n "$ACTIVE" ]]; then
      echo "[psql:prod] multiple deployments under installs/. Set X1AGENT_DEPLOYMENT=<basedomain> to pick one." >&2
      ls -1 "$INSTALLS_DIR" | grep -v example | sed 's/\.local$//; s/^/  /' >&2
      exit 1
    fi
    ACTIVE="$c"
  done
  if [[ -z "$ACTIVE" ]]; then
    echo "[psql:prod] no deployment files in $INSTALLS_DIR" >&2
    exit 1
  fi
  ENV_FILE="$ACTIVE"
fi

# Extract just the keys we need; tolerate missing/quoted values.
val() {
  local key="$1"
  awk -F= -v k="$key" '$1==k { sub(/^"/, "", $2); sub(/"$/, "", $2); print $2 }' "$ENV_FILE"
}

PROJECT_ID="$(val GCP_PROJECT_ID)"
REGION="$(val GCP_REGION)"
[[ -z "$REGION" ]] && REGION="us-central1"
CLUSTER="$(val GKE_CLUSTER_NAME)"
[[ -z "$CLUSTER" ]] && CLUSTER="x1agent"
NAMESPACE="$(val K8S_NAMESPACE)"
[[ -z "$NAMESPACE" ]] && NAMESPACE="x1agent"

if [[ -z "$PROJECT_ID" ]]; then
  echo "[psql:prod] GCP_PROJECT_ID missing in $ENV_FILE" >&2
  exit 1
fi

KCFG="$HOME/.kube/config.x1agent.$PROJECT_ID"

echo "[psql:prod] deployment: $(basename "$ENV_FILE" .local)"
echo "[psql:prod] cluster:    $CLUSTER ($REGION)"
echo "[psql:prod] namespace:  $NAMESPACE"
echo "[psql:prod] kubeconfig: $KCFG"

# Refresh creds. gcloud is no-op when the token is fresh; cheap.
KUBECONFIG="$KCFG" gcloud container clusters get-credentials "$CLUSTER" \
  --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 || {
    echo "[psql:prod] gcloud get-credentials failed. Try: gcloud auth login" >&2
    exit 1
  }

# Drop in. POSTGRES_USER / POSTGRES_DB come from the chart and are
# stable (both 'x1agent'); pull from pod env so a future rename doesn't
# break this script.
exec env KUBECONFIG="$KCFG" kubectl -n "$NAMESPACE" exec -it sts/postgres -- \
  bash -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
