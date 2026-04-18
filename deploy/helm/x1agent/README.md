# x1agent Helm chart (prod path)

Placeholder. The prod chart will live here when we cut the first release.
It covers:

- api + app + sidecar + session-pod template
- External Secrets Operator integration (GSM / AWS SM / Vault)
- Managed Postgres connection via K8s Secret (no in-chart Postgres)
- NATS with mTLS + subject ACLs (see `docs/security/provider-isolation`)
- Per-cloud ServiceAccount annotations for Workload Identity (GKE) / IRSA
  (EKS) / Pod Identity (AKS)
- Ingress with TLS via cert-manager (non-GCP) or Google-managed certs (GKE)
- Provider deployments chosen via `providers.<domain>.type` values

Not needed for local dev. Local dev runs through `devspace dev` against
the manifests under `deploy/k8s/dev/` — see `deploy/k8s/dev/README.md`.
