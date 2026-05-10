---
title: Preview spec reference
description: The `.x1agent/preview.yaml` format. What orchestrator agents generate, what Preview Providers validate.
sidebar:
  order: 2
---

`.x1agent/preview.yaml` tells a [Preview Provider](/providers/preview) how to deploy a repo into a [preview environment](/architecture/preview-environments). The file is checked into the repo, written by the orchestrator agent (or a human) once per repo, validated by the provider on every deploy.

This page is the binding reference for **v1**. The canonical implementation
lives in `packages/providers/preview/src/preview-spec.ts`; when this page and
the parser disagree, the parser wins.

## File location

```
<repo-root>/.x1agent/preview.yaml
```

One file per repo. The file describes the default deploy of the repo. Per-branch overrides are not a thing in v1 — different branches that need different deploys use different PEs (different URLs), not different specs on the same URL. See [preview environments](/architecture/preview-environments#cross-session-workflow-patterns).

## Minimal file

```yaml
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: my-app
spec:
  entrypoint:
    kind: dockerfile
    path: ./Dockerfile
  runtime:
    port: 3000
```

Everything else is optional and has defaults. This deploys a container built from `./Dockerfile`, exposes port 3000 as the HTTP entry, runs as the image's default user, has no dependencies, reads no secrets.

## Full structure (v1)

```yaml
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: string                   # K8s DNS-1123 label (see metadata.name below)
spec:
  entrypoint:                    # required — v1: dockerfile only
    kind: dockerfile
    path: string                 # relative to repo root, e.g. "./Dockerfile"
    buildContext: string         # default: "." (repo root)
  runtime:                       # required
    port: integer                # 1024-65535
    healthcheck:
      path: string               # default: "/"
      initialDelaySeconds: integer  # default: 15
      periodSeconds: integer     # default: 10
  env:                           # optional
    - name: string
      value: string              # for literal values (no `from`)
      from: preview.self_url | secret:<UPPER_NAME>
  resources:                     # optional
    requests:
      cpu: string                # default: "200m"
      memory: string             # default: "512Mi"
    limits:
      cpu: string                # default: "1"
      memory: string             # default: "1Gi"
```

## Field reference

### `apiVersion` and `kind`

Always `x1agent.io/v1` and `PreviewSpec` for now. A future v2 will move over the apiVersion and keep v1 parsing for transition.

### `metadata.name`

Used as a DNS-1123 label in K8s resource names. Must match `^[a-z][a-z0-9-]{0,62}$` — lowercase letters/digits/hyphens, must start with a letter, max 63 chars. **No underscores, no uppercase.** (The 64-char "alphanumeric + dashes + underscores" claim in the previous version of this doc was incorrect — orchestrator agents emitting names with uppercase letters or underscores will hit a hard validator error.)

### `spec.entrypoint.kind`

v1: only `dockerfile` is supported. The provider builds the image via Kaniko
and rolls a Deployment. Other kinds (`compose`, `helm`, `kustomize`,
`manifest`) are planned but not yet implemented; specifying them today fails
validation with `spec.entrypoint.kind: v1 only supports kind='dockerfile', got
...`.

### `spec.entrypoint.path`

Relative to the repo root. Must not contain `..`, must not be absolute, must resolve to a file (or directory, for `helm` and `manifest`). The validator checks existence.

### `spec.entrypoint.buildContext`

Defaults to `"."` (repo root), not the Dockerfile's parent directory. Relative to repo root.

### `spec.entrypoint.args`

Planned. Not parsed in v1.

### `spec.runtime.port`

The single HTTP entry port the PE's URL maps to. Must be in 1024–65535. The provider exposes this port through its ingress; other ports declared in manifests are in-cluster-only unless you opt into additional ingress rules via `spec.ingress` (advanced).

### `spec.runtime.healthcheck`

Fields parsed: `path` (must start with `/`), `initialDelaySeconds` (default 15), `periodSeconds` (default 10). `timeoutSeconds` and `failureThreshold` are documented in some agent prompts but **not parsed today** — silently dropped if present.

### `spec.env`

Environment variables for the runtime container. Each entry has a `name` and either a literal `value` (no `from`) or a `from` source:

| `from` | What it resolves to |
|---|---|
| (omit `from`) | Use the literal `value` field. Never use this for secrets. |
| `preview.self_url` | The preview environment's durable URL. Useful for `NEXT_PUBLIC_APP_URL`, OAuth redirect bases, webhook self-registration. |
| `secret:<NAME>` | The value of the named workspace secret. `<NAME>` MUST match `^[A-Z_][A-Z0-9_]{0,63}$` (uppercase letters, digits, underscore; max 64 chars; cannot start with a digit). Provider injects via `secretKeyRef` so the value never lands in the rendered pod spec. |

Other `from` values from earlier drafts (`preview.share_base_url`, `dep:<index>.<field>`, the literal string `literal`) are **not parsed in v1** and trigger a validator error.

### `spec.resources`

Standard Kubernetes resource quantities. Defaults: `requests {cpu: "200m", memory: "512Mi"}`, `limits {cpu: "1", memory: "1Gi"}`. `ephemeralStorage` is documented in some agent prompts but **not parsed today**.

### Planned (not yet in v1)

The following fields appear in earlier drafts of this doc and may ship in a future version, but are **not parsed today**: `metadata.description`, `entrypoint.{compose,helm,kustomize,manifest}` kinds, `entrypoint.args`, `runtime.protocol`, `runtime.path`, `runtime.healthcheck.{timeoutSeconds,failureThreshold}`, `dependencies` (postgres/redis/mcp), `env.from: preview.share_base_url`, `env.from: dep:<index>.<field>`, `volumes`, `ingress`, `resources.ephemeralStorage`. Orchestrator agents that emit these fields will get a hard validator error or have them silently dropped depending on the field — see `packages/providers/preview/src/preview-spec.ts`.

## Placeholder resolution

`preview.self_url` and `preview.share_base_url` are resolved by the provider at deploy time, *after* the PE's URL is known. The orchestrator agent does not need to know the URL when writing the spec — it just declares the dependency via the placeholder.

`dep:<index>.<field>` placeholders are resolved against the `dependencies` list in order (0-indexed). Each dependency kind exposes specific fields:

- `postgres`: `url`, `host`, `port`, `database`, `user`, `password`.
- `redis`: `url`, `host`, `port`, `password`.
- `mcp`: `url`, `name`.

## Example: a Next.js app with Postgres

```yaml
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: my-app
  description: Customer-facing marketing site
spec:
  entrypoint:
    kind: dockerfile
    path: ./Dockerfile
  runtime:
    port: 3000
    healthcheck:
      path: /api/health
      initialDelaySeconds: 20
  dependencies:
    - kind: postgres
      shared: true
      provides: [DATABASE_URL]
  env:
    - name: NEXT_PUBLIC_APP_URL
      from: preview.self_url
    - name: ANTHROPIC_API_KEY
      from: secret:anthropic_api_key
    - name: NODE_ENV
      from: literal
      value: production
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits:   { cpu: 500m, memory: 512Mi }
```

## Example: a Helm-based microservice

```yaml
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: payments-svc
spec:
  entrypoint:
    kind: helm
    path: ./deploy/helm
    args:
      image.tag: latest
      service.port: "8080"
  runtime:
    port: 8080
    protocol: http2
    healthcheck:
      path: /healthz
  dependencies:
    - kind: redis
      shared: true
      provides: [REDIS_URL]
    - kind: postgres
      shared: true
      provides: [PGURL]
  env:
    - name: STRIPE_SECRET_KEY
      from: secret:stripe_test_key
```

## What agents need to know to write this file

The orchestrator agent's responsibility is to read the target repo and produce a `.x1agent/preview.yaml` that validates. Practically, an orchestrator prompt might look like:

1. Scan the repo for build entrypoints (Dockerfile, Chart.yaml, docker-compose.yaml, kustomization.yaml, plain manifests).
2. Pick one by priority: `dockerfile` > `compose` > `helm` > `kustomize` > `manifest`.
3. Infer the port from the app's source (look for `listen`/`EXPOSE`/`server.port`).
4. Inspect dependencies: `package.json` / `requirements.txt` / `go.mod` references to Postgres / Redis / MCP clients.
5. Inspect env vars the app reads (`process.env.X`, `os.environ["X"]`, etc.) and classify each as secret, placeholder, or literal.
6. Write `spec.env` entries with the correct `from` clause per classification.
7. Run `preview.validate` against the composed spec. If it fails, fix and retry until it passes.
8. Commit the file.

Steps 5 and 6 are where judgment happens — whether an env var is a secret or a literal is a human-ish call. Orchestrator prompts should encode a conservative default: if the name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or `PAT`, treat it as `from: secret:<lowercase_name>`. Everything else, ask or treat as `literal`.

## What happens if the file is missing

If a repo has no `.x1agent/preview.yaml`, a deploy attempt fails with:

```
validation error: no .x1agent/preview.yaml in <repo>@<branch>@<sha>
hint: the orchestrator should generate this file; see /reference/preview-spec
```

The validator never guesses. A repo with no spec deploys nothing.

## Related reading

- [Preview environments](/architecture/preview-environments) — the concept, the URL-as-identity model, the claim lifecycle.
- [Preview Provider](/providers/preview) — what actually reads this spec and deploys it.
- [Secrets management](/security/secrets) — where the `secret:<name>` references resolve to.
- [Shared agent resources](/architecture/shared-agent-resources) — what `kind: postgres` / `kind: redis` + `shared: true` attach to.
