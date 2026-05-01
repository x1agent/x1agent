# x1agent

Open-source, Kubernetes-native agent platform. Runs LLM agents in isolated pods with a security-first sidecar pattern and pluggable provider architecture.

## First principles

1. **Documentation first.** Every feature starts with documentation. Check out a branch, write the docs, then implement. A PR without doc updates is incomplete. The docs in `docs/` are the source of truth for what the system does and why. Code examples in docs must be real -- if you show a config snippet, it must work.

   **The architecture described in `docs/architecture/` and `docs/providers/` is binding on the code.** Every provider domain named in the docs (`auth`, `graph`, `files`, `messaging`, `calendar`, `email`, `ai`, `storage`, `vector`) is a swappable contract, not a hardcoded integration. Any code path that assumes a specific implementation -- "Google OAuth only", "SurrealDB only", "GCS only" -- is a bug to be fixed, not shipped. If implementation reality diverges from the docs, update the docs first (propose the new boundary), then refactor.

2. **Domain-driven design.** Each bounded context (auth, workspaces, invitations, agents, sessions) lives in its own `packages/domains/<name>/` with a four-layer structure: `domain/` (pure entities and value objects, zero I/O), `application/` (use cases that orchestrate domain logic), `ports/` (interfaces for everything external), `adapters/` (implementations of those ports -- one per infrastructure choice). Cross-cutting value objects (`Email`, `Role`, `WorkspaceSlug`, etc.) live in `packages/kernel/`. The `packages/api/` Hono service is a composition root: it wires adapters together but contains no domain logic. See [Testing] below for what each layer must prove.

3. **Test coverage for every layer.** Domain logic is 100% unit-tested with no I/O. Application services are unit-tested with mocked ports. Adapters have integration tests against the real infrastructure they adapt (Postgres, NATS, HTTP). Every port with multiple adapters has a **contract-test suite** in the port's package; every adapter runs that suite to prove it satisfies the contract. "I'll add tests later" is not acceptable for merged code.

4. **Never work on main.** All work happens on feature branches. Create a branch, do the work, open a PR. Direct commits to main are only for releases (automated by semantic-release). Branch naming: `feat/short-description`, `fix/short-description`, `docs/short-description`.

5. **Docs are the product.** The `docs/` directory builds into the public documentation site. Write for operators and contributors, not for ourselves. No internal jargon without definition. No "see Slack" references. Everything a reader needs is in the docs or linked from them.

6. **Local dev runs in OrbStack K8s via devspace.** Postgres, NATS, provider deployments, and (eventually) agent session Jobs all run as real Kubernetes resources in OrbStack, deployed and hot-reloaded by `devspace`. API + app are served by `devspace` with file-sync so code changes reflect without restart. All tests and local verification MUST go through `mise run dev` against OrbStack — never fall back to bare docker containers, never run a service-under-test on the host just because the cluster is slow. If OrbStack is broken, fix OrbStack (`orbctl stop k8s && orbctl start k8s`, or a full OrbStack app restart), don't route around it. The `mise.toml` `KUBECONFIG` override ensures every tool launched through mise can only see the `orbstack` context, so "accidentally deploying to prod" is not a failure mode — stalled-cluster symptoms are.

7. **`mise run install` and `mise run deploy` are the artifact under test, not workflows you patch around.** They are what customers will run on their own clouds. If either fails on a clean (or partially-rebuilt) cluster, the install path itself is broken and the bug must be fixed inside the install/chart/Dockerfile/Terraform source — not by reaching for `helm uninstall && helm upgrade --install ...` or `kubectl apply` or `kubectl patch` to make this one cluster come up. Hand-fixes mask real install bugs, leave the path broken for the next operator, and break the dogfooding contract that says "x1agent.com runs the same install a customer does." Read-only diagnostics (`kubectl logs`, `kubectl describe`, `helm status`, `gcloud ... list`) are encouraged for *understanding* a failure; the fix lives in the chart, the Dockerfile, the Terraform module, or the installer CLI source. Once fixed, re-run from scratch and the install must succeed end-to-end with no manual steps. If it doesn't, that's another bug, fix it the same way.

## Commits

This project uses [Conventional Commits](https://www.conventionalcommits.org/) and [semantic-release](https://github.com/semantic-release/semantic-release) for automated versioning.

Every commit message must follow this format:

```
type(scope): description

[optional body]

[optional footer]
```

**Types that trigger a release:**
- `feat` -- new feature (minor version bump)
- `fix` -- bug fix (patch)
- `perf` -- performance improvement (patch)
- `refactor` -- code restructuring (patch)
- `revert` -- reverts a previous commit (patch)

**Types that do NOT trigger a release:**
- `docs` -- documentation only
- `style` -- formatting, no code change
- `test` -- adding or updating tests
- `build` -- build system or dependencies
- `ci` -- CI/CD configuration
- `chore` -- maintenance tasks

**Breaking changes:** Add `BREAKING CHANGE:` in the commit footer or `!` after the type (e.g., `feat!: redesign provider API`). Triggers a major version bump.

Examples:
```
feat(providers): add NATS request/reply contract for graph domain
fix(sidecar): prevent token leak in credential proxy error path
docs(security): add credential proxy sequence diagram
ci: add pre-push review hook
```

## Code review

A pre-push hook runs an automated Claude code review before pushing. The review uses parallel specialized agents (security, logic, boundary, error-handling, data-flow, contracts) that each focus on a narrow concern. Security scanning for exposed secrets runs first and blocks the push if anything is found.

To run a review manually: `mise run review`

The review agents are in `.claude/commands/`. The pre-push hook is in `.githooks/pre-push`.

## Repository structure

```
docs/                   Documentation site content (Astro Starlight). Architecture binding.
packages/
  kernel/               Shared value objects (Email, Role, WorkspaceSlug, Clock)
  domains/              Bounded contexts — each one is domain/application/ports/adapters
    auth/
    workspaces/
    invitations/
    agents/
    sessions/
  infrastructure/       Shared infrastructure adapters (postgres, nats, kubernetes)
  api/                  Hono composition root — wires adapters, owns HTTP surface
  app/                  Astro + React + zustand frontend
  shared/               Wire DTOs shared with the browser (types only)
deploy/                 Helm charts, manifests, migrations, devspace
examples/               Reference implementations (gitignored, symlinked)
```

A package either belongs to a bounded context (under `domains/`) or supports them (kernel, infrastructure, api, app). There is no "utils" or "lib" dumping ground. Shared code that crosses domains lives in `kernel/`; shared infrastructure lives under `infrastructure/`.

## Documentation site

The `docs/` directory contains the content for the x1agent documentation site, built with Astro Starlight. Docs are organized by audience and purpose:

- `docs/src/content/docs/` -- all documentation content (Starlight convention)
- Frontmatter in each `.md` or `.mdx` file controls title, sidebar position, etc.

When adding or modifying documentation:
- Write for the operator or contributor who has never seen this project
- Use mermaid diagrams to illustrate architecture, not walls of text
- Code examples must be copy-pasteable and correct
- Configuration examples must reflect real Helm values or manifest structures
- No emojis

## Stack

- **Runtime**: Claude Agent SDK (TypeScript), extensible to other agent runtimes
- **Sidecar**: Rust (Axum + async-nats)
- **API**: Hono (TypeScript)
- **Frontend**: Astro + React + shadcn/ui + Tailwind v4
- **Event bus**: NATS (with mTLS support)
- **State**: PostgreSQL
- **Orchestration**: Kubernetes (Jobs for sessions, optional operator with CRDs)
- **Docs site**: Astro Starlight

## Key architectural decisions

- Agent container is **untrusted**. Sidecar is the trust boundary. Credentials never enter the agent container.
- Providers communicate over **NATS**, not HTTP-in-pod. Providers are standalone deployments, not sidecar containers.
- Provider selection is driven by **Helm values**. Switching providers is a config change, not a code change.
- Security features (mTLS, NetworkPolicy, pod security contexts) are **first-class**, not afterthoughts.
- The default path must work out of the box. The hardened path must be well-documented and CI-tested.
