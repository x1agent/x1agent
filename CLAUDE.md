# x1agent

Open-source, Kubernetes-native agent platform. Runs LLM agents in isolated pods with a security-first sidecar pattern and pluggable provider architecture.

## First principles

1. **Documentation first.** Every feature starts with documentation. Check out a branch, write the docs, then implement. A PR without doc updates is incomplete. The docs in `docs/` are the source of truth for what the system does and why. Code examples in docs must be real -- if you show a config snippet, it must work.

2. **Never work on main.** All work happens on feature branches. Create a branch, do the work, open a PR. Direct commits to main are only for releases (automated by semantic-release). Branch naming: `feat/short-description`, `fix/short-description`, `docs/short-description`.

3. **Docs are the product.** The `docs/` directory builds into the public documentation site. Write for operators and contributors, not for ourselves. No internal jargon without definition. No "see Slack" references. Everything a reader needs is in the docs or linked from them.

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
docs/                   Documentation site content (Astro Starlight)
packages/               Framework packages (core, runtime, sidecar, api, app, etc.)
deploy/                 Helm charts, docker-compose, migrations
examples/               Reference implementations (gitignored, symlinked)
```

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
