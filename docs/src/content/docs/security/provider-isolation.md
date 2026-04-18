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
| NetworkPolicy effective | No (intra-pod) | Yes (standard pod isolation) |

## NATS subject ACLs

Each provider's NATS credentials restrict which subjects it can publish and subscribe to:

```
# Graph provider permissions
subscribe: x1.provider.graph.>
publish:   x1.provider.graph.>
publish:   x1.session.*.proxy.request

# Graph provider CANNOT:
# subscribe: x1.session.*.events       (agent output)
# publish:   x1.session.*.input        (user injection)
# subscribe: x1.provider.files.>       (other domains)
```

A compromised graph provider can only interact with graph-related subjects. It cannot read agent output, inject user messages, or interfere with other provider domains.

## Network policy

Provider pods have restrictive egress rules:

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

For deployments that require transport-level security, NATS supports mTLS. Each provider gets its own client certificate. The NATS server verifies the certificate and maps it to the provider's subject permissions.

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

This eliminates shared token auth and provides cryptographic identity verification. See [Configuration: NATS mTLS](/configuration/nats-mtls) for setup details.

The default deployment uses NATS token auth, which is simpler to set up. mTLS is recommended for production deployments with security-conscious operators.
