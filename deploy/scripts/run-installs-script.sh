#!/usr/bin/env bash
# Run a script under installs/<active-deployment>/scripts/<name>.sh
# with deployment-scoped cluster credentials wired up. Lets operators
# (and Claude) keep ad-hoc kubectl/psql/surreal diagnostics in the
# gitignored installs/<deployment>/scripts/ tree, then invoke them by
# name without typing the full path:
#
#   mise run script <name> [args...]
#
# Resolves the active deployment the same way psql:prod / logs:prod
# do: X1AGENT_DEPLOYMENT env wins, else the single non-example file
# under installs/. Exports KUBECONFIG + NAMESPACE for the script;
# inner scripts can also re-invoke `mise run psql:prod` if they want
# the existing psql affordance.
#
# Mutates NOTHING by itself. The invoked script decides what to do.

set -euo pipefail

SCRIPT_NAME="${1:-}"
if [[ -z "$SCRIPT_NAME" ]]; then
  echo "[script] usage: mise run script <name> [args...]" >&2
  echo "[script] scripts live at installs/<deployment>/scripts/<name>.sh" >&2
  exit 1
fi
shift

INSTALLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../installs" && pwd)"

# Resolve active deployment.
if [[ -n "${X1AGENT_DEPLOYMENT:-}" ]]; then
  DEPLOYMENT="$X1AGENT_DEPLOYMENT"
else
  CANDIDATES=("$INSTALLS_DIR"/*.local)
  ACTIVE=""
  for c in "${CANDIDATES[@]}"; do
    base="$(basename "$c" .local)"
    [[ "$base" == "example" ]] && continue
    if [[ -n "$ACTIVE" ]]; then
      echo "[script] multiple deployments under installs/. Set X1AGENT_DEPLOYMENT=<basedomain> to pick one." >&2
      exit 1
    fi
    ACTIVE="$base"
  done
  DEPLOYMENT="$ACTIVE"
fi
[[ -n "$DEPLOYMENT" ]] || { echo "[script] no deployment resolved." >&2; exit 1; }

ENV_FILE="$INSTALLS_DIR/$DEPLOYMENT.local"
[[ -f "$ENV_FILE" ]] || { echo "[script] $ENV_FILE missing." >&2; exit 1; }

# Try the script name verbatim first, then with .sh appended — operator
# convenience so `mise run script foo` and `mise run script foo.sh`
# both work.
SCRIPT_PATH="$INSTALLS_DIR/$DEPLOYMENT/scripts/$SCRIPT_NAME"
[[ -f "$SCRIPT_PATH" ]] || SCRIPT_PATH="$INSTALLS_DIR/$DEPLOYMENT/scripts/$SCRIPT_NAME.sh"
if [[ ! -f "$SCRIPT_PATH" ]]; then
  echo "[script] no such script: installs/$DEPLOYMENT/scripts/$SCRIPT_NAME(.sh)" >&2
  ls "$INSTALLS_DIR/$DEPLOYMENT/scripts/" 2>/dev/null | sed 's/^/  /' >&2 || true
  exit 1
fi

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
  echo "[script] GCP_PROJECT_ID missing in $ENV_FILE" >&2
  exit 1
fi

KCFG="$HOME/.kube/config.x1agent.$PROJECT_ID"
export KUBECONFIG="$KCFG"
export NAMESPACE
export X1AGENT_DEPLOYMENT="$DEPLOYMENT"

echo "[script] deployment: $DEPLOYMENT"
echo "[script] script:     installs/$DEPLOYMENT/scripts/$(basename "$SCRIPT_PATH")"
echo

gcloud container clusters get-credentials "$CLUSTER" \
  --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 || {
    echo "[script] gcloud get-credentials failed. Try: gcloud auth login" >&2
    exit 1
  }

chmod +x "$SCRIPT_PATH" 2>/dev/null || true
exec "$SCRIPT_PATH" "$@"
