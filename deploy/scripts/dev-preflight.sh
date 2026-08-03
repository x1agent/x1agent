#!/usr/bin/env bash
# Guard for the host-local development cluster. Supports OrbStack on macOS
# and the local k3s server on Linux; production tasks use separate kubeconfigs.
set -euo pipefail

EXPECTED_KCFG_SUFFIX="/.orbstack/k8s/config.yml"
EXPECTED_K3S_KCFG="/etc/rancher/k3s/k3s.yaml"
EFFECTIVE_KCFG="${KUBECONFIG:-$HOME/.kube/config}"

case "$EFFECTIVE_KCFG" in
  *"$EXPECTED_KCFG_SUFFIX") EXPECTED_CONTEXT="orbstack" ;;
  "$EXPECTED_K3S_KCFG") EXPECTED_CONTEXT="default" ;;
  *)
    echo "[dev-preflight] FAIL: unsupported local KUBECONFIG=$EFFECTIVE_KCFG" >&2
    echo "[dev-preflight] Expected OrbStack or /etc/rancher/k3s/k3s.yaml" >&2
    exit 1
    ;;
esac

if ! kubectl --kubeconfig="$EFFECTIVE_KCFG" config get-contexts -o name | grep -qx "$EXPECTED_CONTEXT"; then
  echo "[dev-preflight] FAIL: $EFFECTIVE_KCFG has no '$EXPECTED_CONTEXT' context" >&2
  kubectl --kubeconfig="$EFFECTIVE_KCFG" config get-contexts -o name | sed 's/^/  - /' >&2
  exit 1
fi

CURRENT="$(kubectl --kubeconfig="$EFFECTIVE_KCFG" config current-context 2>/dev/null || true)"
if [[ "$CURRENT" != "$EXPECTED_CONTEXT" ]]; then
  echo "[dev-preflight] switching kube context to '$EXPECTED_CONTEXT'"
  kubectl --kubeconfig="$EFFECTIVE_KCFG" config use-context "$EXPECTED_CONTEXT" >/dev/null
fi

SERVER="$(kubectl --kubeconfig="$EFFECTIVE_KCFG" --context="$EXPECTED_CONTEXT" config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || true)"
case "$SERVER" in
  https://127.0.0.1*|https://localhost*|https://kubernetes.docker.internal*) ;;
  *)
    echo "[dev-preflight] FAIL: '$EXPECTED_CONTEXT' points to $SERVER, not a host-local cluster" >&2
    exit 1
    ;;
esac

export KCTX_ARGS=(--kubeconfig="$EFFECTIVE_KCFG" --context="$EXPECTED_CONTEXT")
