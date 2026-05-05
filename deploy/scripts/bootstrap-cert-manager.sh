#!/usr/bin/env bash
# Idempotent local-dev TLS setup for *.local.x1agent.dev.
#
# Steps (each is a no-op when already done):
#   1. Preflight — only operate on OrbStack (sourced from dev-preflight.sh).
#   2. helm upgrade --install cert-manager (with --set installCRDs=true).
#      Installed into namespace `cert-manager`, completely separate from
#      the prod helm install which lives in a different cluster anyway.
#   3. Apply deploy/k8s/dev/cert-manager.yaml (Issuer + root Certificate).
#   4. Wait for the root CA secret `x1agent-local-ca-tls` to exist.
#   5. Extract the root cert and add it to the macOS login keychain so
#      browsers trust *.local.x1agent.dev. Skip if already trusted.
#
# This script does NOT create the leaf Certificate or the Ingress — those
# are part of deploy/k8s/dev/ingress.yaml, applied by `devspace dev` /
# `kubectl apply -f deploy/k8s/dev/`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./dev-preflight.sh
source "$SCRIPT_DIR/dev-preflight.sh"
kc() { kubectl "${KCTX_ARGS[@]}" "$@"; }

NAMESPACE="${NAMESPACE:-x1agent}"
CM_NS="cert-manager"
CM_VERSION="${CM_VERSION:-v1.16.2}"
CA_SECRET="x1agent-local-ca-tls"
DEV_K8S_DIR="$(cd "$SCRIPT_DIR/../k8s/dev" && pwd)"

# ─── 1. Install cert-manager (idempotent) ──────────────────────────
if ! kc get crd certificates.cert-manager.io >/dev/null 2>&1; then
  echo "[cert-manager] installing chart $CM_VERSION into $CM_NS"
  # helm uses --kube-context, not --context. repo add/update don't talk
  # to a cluster, so they don't take it at all.
  helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null
  helm repo update >/dev/null
  helm --kube-context=orbstack upgrade --install cert-manager jetstack/cert-manager \
    --namespace "$CM_NS" --create-namespace \
    --version "$CM_VERSION" \
    --set installCRDs=true \
    --wait --timeout 5m
else
  echo "[cert-manager] already installed — skipping helm install"
fi

# ─── 2. Ensure x1agent namespace exists ────────────────────────────
kc create namespace "$NAMESPACE" --dry-run=client -o yaml | kc apply -f - >/dev/null

# ─── 3. Apply Issuer + root Certificate ────────────────────────────
echo "[cert-manager] applying $DEV_K8S_DIR/cert-manager.yaml"
kc apply -f "$DEV_K8S_DIR/cert-manager.yaml"

# ─── 4. Wait for the root CA secret ────────────────────────────────
echo "[cert-manager] waiting for secret/$CA_SECRET (root CA)…"
for i in {1..60}; do
  if kc -n "$NAMESPACE" get secret "$CA_SECRET" >/dev/null 2>&1; then
    break
  fi
  sleep 2
  if [[ $i -eq 60 ]]; then
    echo "[cert-manager] timed out waiting for $CA_SECRET" >&2
    kc -n "$NAMESPACE" describe certificate x1agent-local-ca >&2 || true
    exit 1
  fi
done

# ─── 5. Add root CA to macOS keychain (idempotent) ─────────────────
TMP_CA="$(mktemp -t x1agent-local-ca.XXXXXX.crt)"
trap 'rm -f "$TMP_CA"' EXIT
kc -n "$NAMESPACE" get secret "$CA_SECRET" -o jsonpath='{.data.tls\.crt}' \
  | base64 -d > "$TMP_CA"

# Compare SHA-256 fingerprint against keychain. `security find-certificate
# -Z` prints all SHA-256 fingerprints of matching certs; if ours is in
# the list we skip the trust prompt.
WANT_FP="$(openssl x509 -in "$TMP_CA" -noout -fingerprint -sha256 \
  | tr -d ':' | sed 's/^.*=//' | tr 'A-Z' 'a-z')"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -a -c "x1agent local dev CA" -Z "$KEYCHAIN" 2>/dev/null \
     | awk '/SHA-256 hash:/{print tolower($3)}' \
     | grep -qx "$WANT_FP"; then
  echo "[cert-manager] root CA already trusted in $KEYCHAIN"
else
  echo "[cert-manager] adding root CA to $KEYCHAIN — you'll be prompted for your password"
  security add-trusted-cert -k "$KEYCHAIN" "$TMP_CA"
  echo "[cert-manager] root CA installed. Restart Chrome to drop any HSTS cache."
fi

echo "[cert-manager] done — *.local.x1agent.dev TLS is wired up"
