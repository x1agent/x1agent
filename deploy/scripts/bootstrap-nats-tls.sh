#!/usr/bin/env bash
# Generate self-signed NATS TLS material for dev and load it into a
# K8s Secret named `nats-tls` in the x1agent namespace.
#
# Idempotent: if the Secret already exists, exits 0 without touching
# anything. Re-running this means you want to rotate — delete the
# Secret first, then re-run.
#
# DEV ONLY. Prod path is cert-manager Issuer + Certificate resources
# in the Helm chart (see deploy/helm/x1agent/README.md).
#
# The cluster runs with ONE CA and ONE client cert today; every
# NATS-connecting pod mounts the same client cert. That's enough to
# stop the agent container (which has no cert) from connecting to
# NATS at all. Per-cert subject ACLs come in a follow-up slice.

set -euo pipefail

# Hard guard: every kubectl call below must hit OrbStack and only OrbStack.
# Without this, a previously-polluted OrbStack kubeconfig (current-context
# flipped to a remote cluster by a stray `gcloud container clusters
# get-credentials`) could route this script's `kubectl create namespace` /
# `kubectl create secret` to the wrong cluster.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./dev-preflight.sh
source "$SCRIPT_DIR/dev-preflight.sh"

NAMESPACE="${NAMESPACE:-x1agent}"
SECRET_NAME="${SECRET_NAME:-nats-tls}"
CERT_DIR="${CERT_DIR:-.local/nats-certs}"
DAYS="${DAYS:-3650}"

# Use --context=orbstack on every kubectl call so we never inherit a
# drifted current-context from the kubeconfig file.
kc() { kubectl "${KCTX_ARGS[@]}" "$@"; }

# Ensure the namespace exists. devspace creates it lazily on first apply,
# but this script may run before that. apply-from-stdin is idempotent and
# silent on "already exists".
kc create namespace "$NAMESPACE" --dry-run=client -o yaml \
  | kc apply -f - >/dev/null

if kc -n "$NAMESPACE" get secret "$SECRET_NAME" >/dev/null 2>&1; then
  echo "[nats-tls] secret $SECRET_NAME already exists in $NAMESPACE — skipping."
  echo "[nats-tls] delete it to rotate: kubectl -n $NAMESPACE delete secret $SECRET_NAME"
  exit 0
fi

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

# ── CA ────────────────────────────────────────────────────
openssl genrsa -out ca.key 4096 2>/dev/null
openssl req -x509 -new -nodes -key ca.key -sha256 -days "$DAYS" \
  -subj "/CN=x1agent-nats-ca-dev" \
  -out ca.crt 2>/dev/null

# ── Server (NATS) ─────────────────────────────────────────
openssl genrsa -out server.key 4096 2>/dev/null
openssl req -new -key server.key \
  -subj "/CN=nats" \
  -out server.csr 2>/dev/null

cat >server.ext <<'EOF'
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = nats
DNS.2 = nats.x1agent
DNS.3 = nats.x1agent.svc
DNS.4 = nats.x1agent.svc.cluster.local
DNS.5 = localhost
IP.1  = 127.0.0.1
EOF

openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days "$DAYS" -sha256 -extfile server.ext 2>/dev/null

# ── Client (shared today; per-caller in phase 2) ──────────
openssl genrsa -out client.key 4096 2>/dev/null
openssl req -new -key client.key \
  -subj "/CN=x1agent-client" \
  -out client.csr 2>/dev/null

cat >client.ext <<'EOF'
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
EOF

openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out client.crt -days "$DAYS" -sha256 -extfile client.ext 2>/dev/null

# ── Secret ────────────────────────────────────────────────
kc -n "$NAMESPACE" create secret generic "$SECRET_NAME" \
  --from-file=ca.crt=ca.crt \
  --from-file=server.crt=server.crt \
  --from-file=server.key=server.key \
  --from-file=client.crt=client.crt \
  --from-file=client.key=client.key

echo "[nats-tls] created secret $SECRET_NAME in namespace $NAMESPACE"
echo "[nats-tls] cert material kept in $CERT_DIR (gitignored)"
