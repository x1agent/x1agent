---
title: Domain Layout
description: How x1agent organizes code by bounded context with ports and adapters
sidebar:
  order: 2
---

x1agent code is organized by bounded context. Each context (auth, workspaces, invitations, agents, sessions) has the same four-layer shape. A thin `api` package wires adapters together and serves HTTP.

## Package layout

```
packages/
  kernel/                          Value objects, shared primitives
  domains/
    auth/
      src/domain/                  Pure entities + VOs, zero I/O
      src/application/             Use cases (SignIn, VerifySession)
      src/ports/                   Interfaces (AuthProvider, UserRepository, SessionTokenizer)
      src/adapters/                Implementations of the ports
        google/                    Google OAuth AuthProvider
        dev-bypass/                Local-only AuthProvider
        jwt/                       JWT SessionTokenizer
        postgres/                  Postgres UserRepository
        hono/                      HTTP routes + requireAuth middleware
      src/contract-tests/          Shared suites every adapter must pass
    workspaces/                    Same shape
    invitations/                   Same shape
    agents/                        (planned)
    sessions/                      (planned)
  infrastructure/                  Shared infra adapters (postgres, nats, k8s)
  api/                             Hono composition root. Wires adapters. No domain logic.
  app/                             Astro + React + zustand frontend
  shared/                          Wire DTOs shared with the browser (types only)
```

## The four layers

**Domain.** Pure entities, value objects, and invariant checks. No database calls, no HTTP, no environment reads. Domain tests run without a process. If a function needs `await`, it almost certainly belongs in application.

**Application.** Use cases. Orchestrates calls across ports to satisfy a single user-meaningful operation (sign in, send invitation, accept invitation). Application code MAY be async, but every side effect MUST go through a port. Application tests use in-memory fakes.

**Ports.** Interfaces. Every external dependency — database, HTTP client, clock, random number generator, message broker — gets a port. Ports live with the domain that uses them, not with the adapter that implements them. This is the dependency inversion: domains define what they need; adapters show up to satisfy it.

**Adapters.** Implementations of ports. One adapter per infrastructure choice. `postgres/` for Postgres, `jwt/` for JWT, `hono/` for HTTP. Adapters are the only layer allowed to import third-party infrastructure clients.

## Composition root

`packages/api/src/composition/index.ts` instantiates adapters, injects them into use cases, and exposes the Hono routes that wire them to HTTP. It's the single place where "Google" and "Postgres" and "JWT" are mentioned by name.

```ts
const google = new GoogleAuthProvider({ ... });
const users = new PostgresUserRepository(sql);
const tokenizer = new JwtSessionTokenizer({ secret });
const authRoutes = createAuthRoutes({ authProvider: google, users, tokenizer, ... });
```

Swapping Google for GitHub is a one-line change here. Use cases and HTTP routes don't know the difference.

## Contract tests

Every port with multiple adapters has a contract test suite exported from the domain package. Each adapter includes a test file that imports the suite and runs it. If the suite passes, the adapter satisfies the port.

```ts
// packages/domains/auth/src/adapters/dev-bypass/dev-bypass-auth-provider.test.ts
import { runAuthProviderContract } from "../../contract-tests/auth-provider.contract.js";

runAuthProviderContract({
  name: "DevBypassAuthProvider",
  factory: () => new DevBypassAuthProvider({ email: "alice@example.com", name: "Alice" }),
  validExchange: { code: "bypass", expected: { ... } },
  invalidCode: "nope",
});
```

This is how the provider architecture enforces itself. New AuthProvider adapters pick up the same suite for free. If the contract evolves, all adapters fail together until they update — no silent drift.

## Test pyramid

| Layer       | What                                          | Speed     | When runs      |
|-------------|-----------------------------------------------|-----------|----------------|
| Domain      | Pure unit tests on entities + invariants      | Instant   | Every commit   |
| Application | Use cases with in-memory fakes                | Fast      | Every commit   |
| Adapters    | Integration with real Postgres / HTTP         | Seconds   | Every commit   |
| Contract    | Shared suite run per adapter of a port        | Fast      | Every commit   |
| E2E         | `mise run dev` + Chrome interaction           | Minutes   | Before merge   |

All tests run via `bun test` at the package level or from the repo root.

## Adding a new bounded context

1. Create `packages/domains/<name>/` with the four subfolders.
2. Define the domain types and invariants. Write tests first.
3. Define ports for every external dependency.
4. Write use cases that orchestrate the ports. Test with in-memory fakes.
5. Implement at least one adapter per port. If the port has more than one expected adapter, write a contract test suite first.
6. Wire the new domain into `packages/api/src/composition/` — construct adapters, inject into use cases, mount the Hono routes.
7. Update the frontend in `packages/app/src/features/<name>/` with a zustand store and feature components.
8. Add a documentation page for the feature here in `docs/`.

## Cross-domain dependencies

Domains may use types from other domains, but only through narrow local ports. For example, the invitations domain needs workspace-admin checks, so it defines an `AdminGuard` port. The composition root satisfies that port by wrapping the workspaces domain's `MembershipRepository`. Invitations never imports the workspaces package's adapters; it only knows its own port shape.

This keeps the dependency direction one-way and testable in isolation.
