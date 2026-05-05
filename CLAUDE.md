# x1agent

Open-source, Kubernetes-native agent platform. Runs LLM agents in isolated pods with a security-first sidecar pattern and pluggable provider architecture.

## First principles

1. **Documentation first.** Every feature starts with documentation. Check out a branch, write the docs, then implement. A PR without doc updates is incomplete. The docs in `docs/` are the source of truth for what the system does and why. Code examples in docs must be real -- if you show a config snippet, it must work.

   **The architecture described in `docs/architecture/` and `docs/providers/` is binding on the code.** Every provider domain named in the docs (`auth`, `graph`, `files`, `messaging`, `calendar`, `email`, `ai`, `storage`, `vector`) is a swappable contract, not a hardcoded integration. Any code path that assumes a specific implementation -- "Google OAuth only", "SurrealDB only", "GCS only" -- is a bug to be fixed, not shipped. If implementation reality diverges from the docs, update the docs first (propose the new boundary), then refactor.

2. **Domain-driven design.** Each bounded context (auth, workspaces, invitations, agents, sessions) lives in its own `packages/domains/<name>/` with a four-layer structure: `domain/` (pure entities and value objects, zero I/O), `application/` (use cases that orchestrate domain logic), `ports/` (interfaces for everything external), `adapters/` (implementations of those ports -- one per infrastructure choice). Cross-cutting value objects (`Email`, `Role`, `WorkspaceSlug`, etc.) live in `packages/kernel/`. The `packages/api/` Hono service is a composition root: it wires adapters together but contains no domain logic. See [Testing] below for what each layer must prove.

3. **Test coverage for every layer.** Domain logic is 100% unit-tested with no I/O. Application services are unit-tested with mocked ports. Adapters have integration tests against the real infrastructure they adapt (Postgres, NATS, HTTP). Every port with multiple adapters has a **contract-test suite** in the port's package; every adapter runs that suite to prove it satisfies the contract. "I'll add tests later" is not acceptable for merged code.

   **Frontend code in `packages/app/` follows the same rule.** Any new component that calls a store action, mutates server state, or contains non-trivial conditional rendering ships with a test in `packages/app/src/__tests__/` using React Testing Library + happy-dom. The minimum bar for a feature PR:
   - Component test that renders the feature with a populated store and asserts the visible output.
   - Interaction test that simulates the primary action (click Attach / Save / Connect) and asserts the right store action was called — catches nested-form bugs and event bubbling regressions.
   - For zustand selectors that compose values (`s.byKey[k] ?? []`), a unit test asserting referential stability across renders — catches the "selector returns new `[]` each render → React error #185 / black screen" foot-gun.
   - For form / multi-step flows, an end-to-end test against OrbStack via the chrome-devtools-tester subagent.

   When the user reports a UI bug, the FIRST move is to ask for the network tab + console error + relevant pod log slice. Don't ship speculative fixes based on guesses; each cycle wastes a deploy and erodes trust. After confirming the root cause, write the regression test that would have caught it, then ship the fix.

4. **Never work on main.** All work happens on feature branches. Create a branch, do the work, open a PR. Direct commits to main are only for releases (automated by semantic-release). Branch naming: `feat/short-description`, `fix/short-description`, `docs/short-description`.

5. **Docs are the product.** The `docs/` directory builds into the public documentation site. Write for operators and contributors, not for ourselves. No internal jargon without definition. No "see Slack" references. Everything a reader needs is in the docs or linked from them.

6. **Local dev runs in OrbStack K8s via devspace.** Postgres, NATS, provider deployments, and (eventually) agent session Jobs all run as real Kubernetes resources in OrbStack, deployed and hot-reloaded by `devspace`. API + app are served by `devspace` with file-sync so code changes reflect without restart. All tests and local verification MUST go through `mise run dev` against OrbStack — never fall back to bare docker containers, never run a service-under-test on the host just because the cluster is slow. If OrbStack is broken, fix OrbStack (`orbctl stop k8s && orbctl start k8s`, or a full OrbStack app restart), don't route around it. The `mise.toml` `KUBECONFIG` override ensures every tool launched through mise can only see the `orbstack` context, so "accidentally deploying to prod" is not a failure mode — stalled-cluster symptoms are.

7. **Workspace tenant isolation is sacred.** Workspace A must not be able to see, name, reference, or affect anything in workspace B. This applies at every layer:

   - **API surface.** Any input that names a resource by id (agent_id, bot_id, repo_id, secret_id, mcp_id, etc.) must be validated to belong to the same workspace as the caller's authenticated workspace context. The route handler resolves the workspace from the URL slug + the actor's membership; every other id in the request body is then a *claim* that has to be re-checked against that workspace before the operation runs. Trusting an id from the body without a workspace re-check is a cross-tenant IDOR — assume an attacker is sending you ids belonging to a different tenant.
   - **Application layer.** Use cases that take more than one resource id — e.g. "pair this bot with this agent", "attach this repo to this agent", "grant this user permission to this collection" — are responsible for verifying that **all** the ids share a workspace. The check belongs in the use case (so every adapter is forced through it), not in the route. Add a port like `AgentWorkspaceReader` if you need to read a sibling domain's workspace mapping; don't reach across domain boundaries directly.
   - **Data layer.** Every list/read query must scope by workspace_id. Foreign keys to user-controllable tables (`agents`, `repos`, `slack_bot_configs`, etc.) are not enough — the FK accepts any uuid in the table, regardless of workspace. The `WHERE workspace_id = $1` is the load-bearing line.
   - **UI.** Pickers, autocomplete, dropdowns, and "select X" interactions must only show resources from the active workspace. A workspace switcher rerenders the picker; it does not just refilter on the client. Don't fetch all-workspaces-the-user-belongs-to and filter client-side — that puts foreign-tenant ids in the DOM.
   - **Tests.** Every multi-id use case ships with a regression test using two distinct workspaces (`WORKSPACE_A`, `WORKSPACE_B`) that asserts the cross-tenant call is rejected with a domain error, not silently succeeds. The pattern is: create resource X in A, attempt to use it from B's actor context, expect `*NotInWorkspaceError` (or equivalent).

   This is non-negotiable because customers will install x1agent precisely to get tenant isolation that SaaS competitors blur. A single cross-tenant IDOR breaks the entire product proposition. Treat tenant isolation as a security boundary on par with authentication itself.

   **Corollary — what's "global" on an install is intentionally tiny.** The only deployment-wide configuration the platform exposes is *who is a platform admin* and *what URLs the install runs on* (base domain, api/app/docs hostnames). Everything else is workspace-scoped — agents, repos, MCP servers, env-var secrets, Slack bots, collections, billing, RBAC. If a new feature feels like it needs a "global" setting that affects all workspaces (e.g. "disable Vertex AI for this workspace", "rate-limit token spend by tenant", "prevent this workspace from spawning more than N concurrent sessions"), that's a **per-workspace setting controlled by a platform admin**, not a deployment-wide flag. Workspace admins govern within their workspace; platform admins govern across workspaces. Adding a per-workspace platform-only setting is preferable to adding a new deployment-wide knob — the latter erodes the "the install is just plumbing, the workspace is the unit of governance" model. When in doubt, scope down: workspace > install. The platform-admin tier is for cross-workspace decisions, not for replacing per-workspace governance.

8. **`mise run install` and `mise run deploy` are the artifact under test, not workflows you patch around.** They are what customers will run on their own clouds. If either fails on a clean (or partially-rebuilt) cluster, the install path itself is broken and the bug must be fixed inside the install/chart/Dockerfile/Terraform source — not by reaching for `helm uninstall && helm upgrade --install ...` or `kubectl apply` or `kubectl patch` to make this one cluster come up. Hand-fixes mask real install bugs, leave the path broken for the next operator, and break the dogfooding contract that says "x1agent.com runs the same install a customer does." Read-only diagnostics (`kubectl logs`, `kubectl describe`, `helm status`, `gcloud ... list`) are encouraged for *understanding* a failure; the fix lives in the chart, the Dockerfile, the Terraform module, or the installer CLI source. Once fixed, re-run from scratch and the install must succeed end-to-end with no manual steps. If it doesn't, that's another bug, fix it the same way.

## Distribution target — how customers install x1agent

We're optimizing for the install pattern most devops teams already run: **a Terraform module in their infra git repo, plus a helm deploy step in CI**, both pinned to versions they bump on their own schedule. Today's `mise run install` orchestrates the whole thing from inside this monorepo because that's the fastest dogfood loop, but it's a temporary shape, not the customer-facing one. Treat that gap as load-bearing direction for ongoing work.

The resting state we are building toward:

- **Terraform module published as a versioned, public module** (e.g. `github.com/x1agent/terraform-x1agent-gcp` with semver tags), so a customer writes 30 lines of HCL referencing `module "x1agent" { source = "github.com/x1agent/terraform-x1agent-gcp?ref=v1.2.0" }` and gets cluster + IAM + secret store + AR + DNS + ingress IP. They keep this in their existing infra repo, alongside their other modules. They never clone the x1agent monorepo.
- **Helm chart published to a versioned OCI registry / helm repo** (e.g. `oci://ghcr.io/x1agent/charts/x1agent`) so a customer's CI runs `helm upgrade --install x1agent oci://... --version 1.2.0 -f values.yaml`. No `helm install ./deploy/helm/x1agent` against a local checkout.
- **Image tags pinned per chart version.** Helm chart `1.2.0` always pulls api/app/sidecar/etc. at the matching image SHA, even if AR has newer tags. A customer who pins `--version 1.2.0` gets reproducible installs months later.
- **Compatibility matrix** documented on docs.x1agent.com: Terraform module `vA.B` is known to work with chart `vX.Y`. Customers consult the matrix when bumping either side.
- **No mise / bun / local CLI required.** Installing x1agent on a customer cloud is plain `terraform apply` plus plain `helm upgrade`. Our wrapper CLI is a dev-loop convenience and a reference orchestrator; it must never be the *only* path.
- **Customer-side configurator output is a values file.** `installs/<basedomain>.local` is our internal shape for now, but the eventual customer artifact is a plain `values.yaml` (and a `terraform.tfvars`) that lives in their own git repo. The configurator's job is generating those, not running them.
- **GitOps from day one.** A customer should be able to put `terraform.tfvars` and `values.yaml` in a private git repo and have CI install x1agent reproducibly — no "click these things in the cloud console first" prerequisites the wizard hasn't already rendered as code.
- **Documentation includes a no-monorepo install path.** docs.x1agent.com must show a copy-pasteable customer install (Terraform block + helm command + values example) that does not reference our internal layout. If the docs' install steps assume our repo is checked out, that's a doc bug.

Each piece of work should be evaluated against this trajectory. New chart features should be tagged versions, not "in main". Cloud-specific Terraform should live in modules a customer can `source =` cleanly. CLI improvements should make this delivery model easier, not deeper coupled. Anything that makes "clone the x1agent monorepo" harder to escape is moving the wrong direction.

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

## Frontend state management

**Use zustand for any state that crosses a component boundary or backs an API call.** The `packages/app` codebase has a consistent pattern of zustand stores in `packages/app/src/stores/` — `useAgentsStore`, `useCollectionsStore`, `useGitHubStore`, `useGrantsStore`, `useAuthStore`, `useCapabilitiesStore` all follow the same shape: a normalized cache keyed by workspace/agent, plus async actions (`load`, `attach`, `detach`, `update`) that hit `apiFetch` and write the result back into the cache.

When adding a new feature that talks to the api:
1. Create or extend a store in `packages/app/src/stores/` for the new domain.
2. Components consume the store with a selector: `const items = useFooStore((s) => s.byKey[k] ?? [])`.
3. Components call store actions, never `apiFetch` directly: `useFooStore.getState().attach(...)`.

Local `useState` is fine for **purely local UI concerns** — open/closed, in-flight submit flag, current text-input value. As soon as the value reflects server state, persists across navigations, or needs to be visible to another component, it belongs in a store.

This matters because:
- Inconsistent patterns make the codebase hard to reason about (one feature uses zustand, another doesn't).
- A store is the natural cross-page cache — the agent detail page's MCP count and the agent edit page's MCP list should share the same source of truth.
- Optimistic updates and post-mutation refetches are uniform when they live in store actions.
- Tests can reset the store between cases instead of mocking `fetch`.

When you find a feature that uses raw `useState` + `apiFetch` for server state, treat it as tech debt — refactor opportunistically when you next touch it.
