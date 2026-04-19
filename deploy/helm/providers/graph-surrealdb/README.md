# graph-surrealdb provider Helm chart (prod path)

Placeholder. Prod chart lands here when the first release cut needs
it. Covers:

- Provider Deployment subscribing to `x1.provider.graph.*` and
  `x1.provider.vector.*` — SurrealDB v3 handles both domains from one
  instance, so one deployment serves both subject trees.
- SurrealDB StatefulSet with persistent storage (RocksDB on a
  default-storage-class PVC, or a managed backend via the
  `storage.backend` values key).
- Credentials via K8s Secret sourced from External Secrets Operator;
  dev-only env-var path (`SURREAL_PASS`) stays supported for
  single-node installs.
- NATS mTLS client cert (`docs/configuration/nats-mtls.md`).
- NetworkPolicy restricting egress to NATS + SurrealDB only; the
  provider holds the only SurrealDB root credential, so blast radius
  is contained if the pod is compromised.

Not needed for local dev. Local dev uses
`deploy/k8s/dev/{surrealdb,graph-surrealdb}.yaml` applied via
devspace; root password is a hardcoded dev default (see manifest).
