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

The composition root at `packages/api/src/composition/index.ts` constructs
a single `AuthProvider` instance and passes it to `createAuthRoutes`. Today
the only production adapter is `GoogleAuthProvider`; selection is implicit
(no env switch yet).

Adding a second prod adapter is a ~3-line change:

1. Construct your adapter alongside `google`.
2. Branch on a new env var (`AUTH_PROVIDER=github` or similar).
3. Pass the chosen adapter to `createAuthRoutes({ authProvider, ... })`.

A future `providers.auth.type` Helm key plus a chart-level switch is on
the roadmap but not yet implemented; until then, prod selection lives in
the api's environment.

## NATS-backed providers

For domains that use NATS (graph, files, messaging, etc.), the provider runs as a separate deployment:

1. Subscribe to the domain's NATS subject prefix (`x1.provider.<domain>.*`).
2. Implement the request/reply schema documented in the domain package.
3. For any external API call that requires user credentials, send a proxy request through the sidecar — see [Credential Proxy](/security/credential-proxy).
4. Package as an OCI image.
5. Add a Helm value binding the domain to your provider type.

The same in-process contract test runs against the adapter that the NATS
handler delegates to (e.g. `SlackMessagingProvider`). An embedded-NATS
harness for end-to-end subject handling is on the roadmap; today the wire
layer is exercised by integration tests against a real NATS instance in
the dev cluster.

See [Provider System](/providers/overview) for the full list of domains and their contracts.
