# messaging-slack provider Helm chart (prod path)

Placeholder. The prod chart will live here when we cut the first
release. It covers:

- Deployment of the messaging-slack provider subscribing to
  `x1.provider.messaging.*` on the cluster's NATS
- Bot token via K8s Secret sourced from External Secrets Operator
  (Phase 2 migrates to per-workspace OAuth installations; this env
  path stays as a fallback for single-workspace setups)
- NATS mTLS client cert (see `docs/configuration/nats-mtls.md`)
- NetworkPolicy: egress to Slack API + NATS only
- PodSecurityContext: non-root, read-only root filesystem, no
  privilege escalation — provider holds the Slack token so the
  blast radius matters

Not needed for local dev. Local dev uses
`deploy/k8s/dev/messaging-slack.yaml` applied via devspace, with
`SLACK_BOT_TOKEN` injected from `.env.local` — see the provider
entry in `devspace.yaml`.
