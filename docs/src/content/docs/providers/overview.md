---
title: Provider System
description: How providers work, what types exist, and how to configure them
sidebar:
  order: 1
---

Providers are the pluggable parts of x1agent. Each provider implements a defined contract for a specific domain -- authentication, knowledge graphs, file storage, messaging, and so on. Providers are standalone services that communicate with the core sidecar over NATS.

## Provider domains

| Domain | What it controls | Reference provider | Status |
|--------|------------------|--------------------|--------|
| `auth` | SSO, identity, token issuance | Google OAuth | Port + 2 adapters (`google`, `dev-bypass`); composition is hardcoded — see [authoring](/providers/authoring) |
| `graph` | Knowledge graph storage and queries | SurrealDB | Port + 1 adapter; selectable via `providers.graph` Helm value |
| `vector` | Vector search backend | SurrealDB (co-located with graph in v1) | Port + 1 adapter; locked to `graph` in v1 |
| `messaging` | Chat platform integration | Slack | Port + 1 adapter; not yet Helm-selectable |
| `files` / `documents` / `calendar` / `email` | Drive / Docs+Sheets / Calendar / Gmail | google-workspace provider | NATS-handler-only; no domain port yet |
| `preview` | Ephemeral deploy targets | Local Kubernetes | NATS handler for `provision` only; no domain port yet |
| `ai` | LLM routing | Anthropic direct or Vertex | Runtime toggle (`anthropic.provider` Helm value), not a port |
| `storage` | Object storage for shares | GCS / local | Configured via runtime env, not a port |

Each domain has a defined NATS request/reply contract. A provider implements one or more domains.

## How providers connect

Providers are Kubernetes Deployments that subscribe to NATS subjects. They are not containers in the session pod. This is a deliberate architectural choice -- see [Security: Provider isolation](/security/provider-isolation) for why.

```mermaid
graph TB
    subgraph pod["Session Pod (always 2 containers)"]
        agent["Agent"]
        sidecar["Core Sidecar"]
    end

    nats["NATS"]

    subgraph providers["Provider Deployments"]
        graphProv["Graph Provider"]
        files["File Provider"]
        ms["Microsoft 365 Provider"]
    end

    agent -- "localhost" --> sidecar
    sidecar <--> nats
    nats <--> graphProv
    nats <--> files
    nats <--> ms
```

The sidecar publishes requests to provider subjects (e.g., `x1.provider.graph.query`). The provider subscribes, handles the request, and replies. Standard NATS request/reply.

## Multi-domain providers

A single provider service can implement multiple domains. A Microsoft 365 provider could handle files (OneDrive), calendar (Outlook), email (Outlook), and messaging (Teams) -- all from one deployment. It subscribes to multiple NATS subject prefixes:

```
x1.provider.files.*       -- OneDrive file operations
x1.provider.calendar.*    -- Outlook calendar operations
x1.provider.email.*       -- Outlook email operations
x1.provider.messaging.*   -- Teams messaging operations
```

Domains are filled independently. You can use the Microsoft 365 provider for files and calendar, but Google for email. The sidecar routes each domain to whatever provider subscribes to that subject.

## Configuration

Provider selection today is partial. The shape in `deploy/helm/x1agent/values.yaml`:

```yaml
providers:
  # Singleton domains. "none" disables the capability + skips the
  # provider Deployment. Today the only graph kind is surrealdb,
  # which also implements vector — so vector is locked to graph in v1.
  graph: surrealdb        # or "none"
  vector: surrealdb       # locked to graph in v1

  # Per-kind config block — only the block matching `graph` is consumed.
  graphSurrealdb:
    image:
      repository: ""
      tag: latest
    surrealImage: surrealdb/surrealdb:v2.3
    storageSize: 10Gi
    # …
```

`auth` and `messaging` are not yet Helm-selectable; their adapters are wired in the API composition root and configured via env vars.

## Provider discovery

Providers are discovered through NATS subscriptions. When the sidecar needs to make a graph query, it publishes to `x1.provider.graph.query`. If a provider is subscribed, the request is handled. If nothing is subscribed, the request times out and the sidecar returns an error to the agent.

This means:
- No central provider registry to maintain
- Providers can be added and removed without restarting the sidecar
- Health is observable -- if a provider stops responding, NATS request timeouts surface immediately

## Credential handling

Providers never receive user OAuth tokens directly. When a provider needs to call an external API (OneDrive, Google Calendar, etc.), it sends a proxy request through the sidecar. The sidecar fetches the user's token, injects it into the outbound request, and returns the response. The provider sees the data but never the credential.

See [Security: Credential proxy](/security/credential-proxy) for the full flow.

## Lifecycle hooks

**Status: not yet implemented.** Today the only session subjects are
`x1.session.*.{events,audit,input,presence}`. Lifecycle subjects are
on the roadmap; until they ship, file-sync providers should hook
session-start via the API rather than NATS.

## Writing a provider

See [Provider authoring guide](/providers/authoring) for the full walkthrough. The short version:

1. Pick the domain(s) your provider implements.
2. Subscribe to the corresponding NATS subjects.
3. Implement the request/reply contract for each domain.
4. For external API calls, use the credential proxy.
5. Ship as an OCI image.
6. Document the config your provider needs.

Providers can be written in any language that has a NATS client library.
