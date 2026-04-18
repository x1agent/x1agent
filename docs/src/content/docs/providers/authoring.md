---
title: Writing a Provider
description: Build an x1agent provider from the port contract outward
sidebar:
  order: 2
---

A provider is an adapter for a port defined by one of the domains. Providers for NATS-backed domains (`graph`, `files`, `messaging`, `calendar`, `email`, `storage`, `vector`) ship as standalone deployments that speak the domain's NATS request/reply contract. Providers for the `auth` domain run as in-process adapters because the trust boundary runs through the API, not through NATS.

This page walks through a simple case: adding a new `AuthProvider`. The same shape applies to other domains.

## 1. Find the port

Every provider implements a port defined in a domain package. For auth:

```ts
// packages/domains/auth/src/ports/auth-provider.ts
export interface AuthProvider {
  readonly id: string;
  getAuthorizeUrl(redirectUri: string, state?: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<AuthProfile>;
}
```

`AuthProfile` is a normalized identity: email, name, avatar URL, provider-scoped user ID, provider ID. Everything provider-specific stays inside your adapter.

## 2. Read the contract tests

Before writing any code, find the contract suite for your port:

```
packages/domains/auth/src/contract-tests/auth-provider.contract.ts
```

The suite is the definition of "correct" for every adapter. It exports `runAuthProviderContract(fixture)`. Your adapter's test file passes a fixture (factory + a valid code + an invalid code) and gets the full conformance run for free.

## 3. Write the adapter

```ts
// packages/domains/auth/src/adapters/github/github-auth-provider.ts
import { Email } from "@x1agent/kernel";
import type { AuthProvider } from "../../ports/auth-provider.js";
import type { AuthProfile } from "../../domain/auth-profile.js";

export class GitHubAuthProvider implements AuthProvider {
  readonly id = "github";

  constructor(private cfg: { clientId: string; clientSecret: string }) {}

  getAuthorizeUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      scope: "read:user user:email",
    });
    if (state) params.set("state", state);
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<AuthProfile> {
    // Exchange, fetch user + primary email, return AuthProfile with id: "github"
  }
}
```

## 4. Run the contract

```ts
// packages/domains/auth/src/adapters/github/github-auth-provider.test.ts
import { runAuthProviderContract } from "../../contract-tests/auth-provider.contract.js";
import { GitHubAuthProvider } from "./github-auth-provider.js";

runAuthProviderContract({
  name: "GitHubAuthProvider",
  factory: () => new GitHubAuthProvider({ clientId: "...", clientSecret: "..." }),
  validExchange: { code: "test-code", expected: { /* ... */ } },
  invalidCode: "not-a-code",
});
```

For adapters that call remote APIs, stub the remote at this level. The contract test stays offline.

## 5. Wire it into composition

A provider isn't live until the composition root selects it. In `packages/api/src/composition/index.ts`:

```ts
const github = new GitHubAuthProvider({
  clientId: env.githubClientId,
  clientSecret: env.githubClientSecret,
});

const authRoutes = createAuthRoutes({
  authProvider: env.authProvider === "github" ? github : google,
  ...
});
```

In production, the selection is driven by Helm values:

```yaml
providers:
  auth:
    type: github
    config:
      clientId: "..."
```

## NATS-backed providers

For domains that use NATS (graph, files, messaging, etc.), the provider runs as a separate deployment:

1. Subscribe to the domain's NATS subject prefix (`x1.provider.<domain>.*`).
2. Implement the request/reply schema documented in the domain package.
3. For any external API call that requires user credentials, send a proxy request through the sidecar — see [Credential Proxy](/security/credential-proxy).
4. Package as an OCI image.
5. Add a Helm value binding the domain to your provider type.

The contract test pattern still applies — domains with NATS adapters include a contract suite that brings up an embedded NATS server and verifies the provider's subject handling.

See [Provider System](/providers/overview) for the full list of domains and their contracts.
