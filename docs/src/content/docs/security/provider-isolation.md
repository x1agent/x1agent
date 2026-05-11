---
title: Provider Isolation
description: Why providers run as separate services, not in the session pod
sidebar:
  order: 3
---

Providers communicate with the sidecar over NATS, not HTTP on localhost. They run as standalone Kubernetes Deployments, not as additional containers in the session pod. This is a deliberate security decision.

## Why not containers in the pod?

Kubernetes NetworkPolicy operates at the pod level, not the container level. All containers in a pod share a network namespace. If a provider container runs inside the session pod:

- It has localhost access to the sidecar's full HTTP API (`:9090`), not just the proxy endpoint
- It has localhost access to the agent's inject endpoint (`:8788`), allowing it to manipulate the conversation
- It can probe every port on localhost
- NetworkPolicy cannot restrict intra-pod traffic

A compromised provider container inside the pod could inject messages into the agent, call sidecar endpoints it shouldn't, or exfiltrate data through the agent's SSE stream.

## NATS-based isolation

With providers as separate pods communicating over NATS:

| Attack vector | In-pod (HTTP) | Separate pod (NATS) |
|---------------|--------------|-------------------|
| Access agent inject endpoint | Yes (localhost) | No (different pod) |
| Access sidecar HTTP API | Yes (localhost) | No (different pod) |
| Access databases | Depends on pod-level NetworkPolicy | Blocked by NetworkPolicy |
| Snoop other sessions | Shares pod with one session | Blocked by NATS subject ACLs |
| NetworkPolicy effective | No (intra-pod) | Yes if cluster CNI enforces and chart is rendered with NetworkPolicy enabled (today: not shipped in helm) |

## NATS subject ACLs

Today, every provider deployment shares one mTLS client cert with
`CN=x1agent-provider`. That cert's NATS permissions are:

```
publish:   ["_INBOX.>", "x1.audit.>"]
subscribe: ["x1.provider.>", "_INBOX.>"]
```

So providers cannot publish to session subjects (no agent injection),
cannot read session events (no agent output), and cannot inject user
input. They CAN, however, subscribe to every other provider's domain
— a compromised messaging-slack provider can sniff graph-provider
traffic.

**Per-provider certs (`CN=provider-graph`, `CN=provider-messaging`)**
are the v2 tightening: each provider gets its own cert and the NATS
ACLs narrow to its own domain. Tracked as a follow-up.

## Network policy

**Status: not enforced in the helm chart today.** A reference NetworkPolicy
exists at `deploy/k8s/dev/networkpolicy.yaml` but is not part of any
`helm install`. OrbStack's CNI doesn't enforce NetworkPolicy at all.
Production CNIs (Calico / Cilium / GKE Dataplane v2 / etc.) will enforce
the manifests below if you `kubectl apply` them yourself; ship-in-helm
is a follow-up gated by `networkPolicy.enabled` (TODO).

The intended shape:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: provider-egress
spec:
  podSelector:
    matchLabels:
      x1agent.io/component: provider
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: nats
      ports:
        - port: 4222
    # Provider's own backing service (e.g., Neo4j)
    # Added per-provider via additional NetworkPolicy
```

Providers can reach NATS and their own backing service. Nothing else. No direct internet access. All external API calls go through the sidecar's credential proxy.

## mTLS on NATS

The chart-shipped NATS deployment requires mTLS — there is no token-auth
path. cert-manager issues the server cert and per-component client certs
(api, sidecar, providers) from an internal CA. The NATS server runs
with `verify_and_map: true`, which extracts the client cert's CN and
matches it against the `authorization.users` block.

```
# nats-server.conf
tls {
  cert_file:  "/certs/server-cert.pem"
  key_file:   "/certs/server-key.pem"
  ca_file:    "/certs/ca.pem"
  verify:     true
}

authorization {
  users = [
    { user: "CN=sidecar",        permissions: { publish: ">", subscribe: ">" } }
    { user: "CN=graph-provider",  permissions: { publish: "x1.provider.graph.>", subscribe: "x1.provider.graph.>" } }
    { user: "CN=files-provider",  permissions: { publish: "x1.provider.files.>", subscribe: "x1.provider.files.>" } }
  ]
}
```

See [Configuration: NATS mTLS](/configuration/nats-mtls) for cert-manager
wiring and the per-component cert layout.
