# Dev K8s manifests

These YAML files are applied by `devspace dev` against the OrbStack cluster
for local development only. They are **not** prod.

- `postgres.yaml` — single-instance Postgres with emptyDir storage
- `api.yaml` — api Deployment, Service, ServiceAccount, and RBAC for
  creating session Jobs in this namespace

Prod path lives at `deploy/helm/x1agent/` (Helm chart, externally-managed
Postgres, ESO-backed secrets, cloud-specific annotations, mTLS, etc.). The
two live in separate directories so dev iteration doesn't accidentally
drift the prod chart.

See `CLAUDE.md` → principle #6 for the dev-vs-prod split.
