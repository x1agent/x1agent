#!/usr/bin/env bash
# Idempotent guard called by every dev:* task before it touches the cluster.
# Asserts that:
#   1. KUBECONFIG points at the OrbStack config file (mise.toml sets this).
#   2. That file has an `orbstack` context, and we're using it.
#   3. That context's API server is localhost — i.e. truly OrbStack and not
#      a remote cluster that got merged into the file by a stray
#      `gcloud container clusters get-credentials`.
#
# Source this at the top of any dev script:
#   source "$(dirname "$0")/dev-preflight.sh"
#
# Or call directly to fail fast:
#   bash deploy/scripts/dev-preflight.sh

set -euo pipefail

EXPECTED_KCFG_SUFFIX="/.orbstack/k8s/config.yml"
EXPECTED_CONTEXT="orbstack"

EFFECTIVE_KCFG="${KUBECONFIG:-$HOME/.kube/config}"

case "$EFFECTIVE_KCFG" in
  *"$EXPECTED_KCFG_SUFFIX")
    ;;
  *)
    echo "[dev-preflight] FAIL: KUBECONFIG=$EFFECTIVE_KCFG does not end in $EXPECTED_KCFG_SUFFIX" >&2
    echo "[dev-preflight] mise.toml pins this; if you're not running through mise, do:" >&2
    echo "[dev-preflight]   export KUBECONFIG=\"\$HOME$EXPECTED_KCFG_SUFFIX\"" >&2
    exit 1
    ;;
esac

if ! kubectl --kubeconfig="$EFFECTIVE_KCFG" config get-contexts -o name | grep -qx "$EXPECTED_CONTEXT"; then
  echo "[dev-preflight] FAIL: $EFFECTIVE_KCFG has no '$EXPECTED_CONTEXT' context" >&2
  echo "[dev-preflight] Available contexts:" >&2
  kubectl --kubeconfig="$EFFECTIVE_KCFG" config get-contexts -o name | sed 's/^/  - /' >&2
  echo "[dev-preflight] Is OrbStack k8s running? Try: orb start k8s" >&2
  exit 1
fi

CURRENT="$(kubectl --kubeconfig="$EFFECTIVE_KCFG" config current-context 2>/dev/null || true)"
if [[ "$CURRENT" != "$EXPECTED_CONTEXT" ]]; then
  echo "[dev-preflight] kubeconfig current-context was '$CURRENT' — switching to '$EXPECTED_CONTEXT'"
  kubectl --kubeconfig="$EFFECTIVE_KCFG" config use-context "$EXPECTED_CONTEXT" >/dev/null
fi

SERVER="$(kubectl --context="$EXPECTED_CONTEXT" config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || true)"
case "$SERVER" in
  https://127.0.0.1*|https://localhost*|https://kubernetes.docker.internal*)
    ;;
  *)
    echo "[dev-preflight] FAIL: '$EXPECTED_CONTEXT' context points to $SERVER (not local OrbStack)" >&2
    echo "[dev-preflight] $EFFECTIVE_KCFG has been polluted with a remote cluster." >&2
    echo "[dev-preflight] Restart OrbStack k8s to regenerate it: orb stop k8s && orb start k8s" >&2
    exit 1
    ;;
esac

# Export for sourcing scripts: every kubectl call should use this.
export KCTX_ARGS=(--context="$EXPECTED_CONTEXT")
