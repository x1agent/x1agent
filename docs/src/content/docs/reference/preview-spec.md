---
title: Preview spec reference
description: The `.x1agent/preview.yaml` format. What orchestrator agents generate, what Preview Providers validate.
sidebar:
  order: 2
---

`.x1agent/preview.yaml` tells a [Preview Provider](/providers/preview) how to deploy a repo into a [preview environment](/architecture/preview-environments). The file is checked into the repo, written by the orchestrator agent (or a human) once per repo, validated by the provider on every deploy.

This page is the binding reference. Everything in it is JSONSchema-backed; the schema itself lives at `packages/domains/previews/schema/preview-spec.v1.schema.json` and is the source of truth when human prose and schema disagree. Agents should read this page to know *how* to write the file, and (via the schema) to validate what they wrote.

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

## Full structure

```yaml
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: string                   # display name, no special chars
  description: string | null     # free text shown in UI
spec:
  entrypoint:                    # required
    kind: dockerfile | compose | helm | kustomize | manifest
    path: string                 # relative to repo root
    buildContext: string | null  # default: path's parent directory
    args:                        # build args, kind-specific
      KEY: value
  runtime:                       # required
    port: integer                # 1024-65535
    protocol: http | http2 | tcp # default: http
    path: string                 # default: "/" — root path the app serves
    healthcheck:
      path: string               # default: "/"
      initialDelaySeconds: integer  # default: 15
      periodSeconds: integer     # default: 10
      timeoutSeconds: integer    # default: 3
      failureThreshold: integer  # default: 3
  dependencies:                  # optional
    - kind: postgres | redis | mcp
      shared: bool               # use workspace shared resource
      name: string               # for kind=mcp, the attached MCP name
      required: bool             # default: true
      provides:                  # env var names this dep fills in
        - DATABASE_URL
  env:                           # optional
    - name: string
      from: literal | secret:<name> | preview.self_url | preview.share_base_url | dep:<dep-index>.<field>
      value: string              # when from: literal
  resources:                     # optional
    requests:
      cpu: string                # e.g. "100m"
      memory: string             # e.g. "256Mi"
    limits:
      cpu: string
      memory: string
    ephemeralStorage: string     # e.g. "1Gi", default: 512Mi
  volumes:                       # optional
    - name: string
      kind: emptyDir | tmpfs
      mountPath: string
      sizeLimit: string          # e.g. "100Mi"
  ingress:                       # optional, overrides provider defaults
    stripPath: bool              # default: true for subpath-hosted setups
    additionalHeaders:
      X-Custom: value
```

## Field reference

### `apiVersion` and `kind`

Always `x1agent.io/v1` and `PreviewSpec` for now. A future v2 will move over the apiVersion and keep v1 parsing for transition.

### `metadata.name`

Display name only. Does not have to match the repo name, does not have to be unique across the workspace. Alphanumeric, dashes, underscores, 1–64 chars.

### `spec.entrypoint.kind`

Five values, each with its own `path` semantics:

| kind | What `path` points at | Build model |
|---|---|---|
| `dockerfile` | A `Dockerfile` | Provider builds the image via Kaniko / docker / native equivalent, rolls a Deployment. |
| `compose` | A `docker-compose.yaml` (or `.yml`, or `compose.yaml`) | Provider runs Kompose to translate to K8s manifests (local-k8s only). |
| `helm` | A `Chart.yaml` or the chart directory | Provider runs `helm template` with supplied `args` as values, applies output. |
| `kustomize` | A `kustomization.yaml` | Provider runs `kubectl kustomize` or `kustomize build`, applies output. |
| `manifest` | A `.yaml` file or directory of them | Provider applies the raw manifests. Most control, least portability. |

Not every provider supports every kind. The [Preview Provider reference](/providers/preview) describes the matrix per provider. Validation fails fast if a repo's `kind` is not supported by the target environment's `provider_kind`.

### `spec.entrypoint.path`

Relative to the repo root. Must not contain `..`, must not be absolute, must resolve to a file (or directory, for `helm` and `manifest`). The validator checks existence.

### `spec.entrypoint.buildContext`

For `kind: dockerfile` only. Defaults to the directory containing the Dockerfile. Relative to repo root.

### `spec.entrypoint.args`

Kind-specific:

- `dockerfile`: passed as `--build-arg KEY=value` to the build.
- `helm`: passed as `--set key=value` to `helm template`.
- `kustomize` / `manifest`: unused (warning emitted if set).
- `compose`: passed as environment variables to the Compose substitution process (not to the containers).

### `spec.runtime.port`

The single HTTP entry port the PE's URL maps to. Must be in 1024–65535. The provider exposes this port through its ingress; other ports declared in manifests are in-cluster-only unless you opt into additional ingress rules via `spec.ingress` (advanced).

### `spec.runtime.protocol`

- `http` — the normal case.
- `http2` — for apps that speak h2c or gRPC-web. Provider configures the ingress accordingly.
- `tcp` — raw TCP. Most providers won't support this (ingress is almost always HTTP); validator rejects on unsupported providers.

### `spec.runtime.healthcheck`

Used by the provider both for readiness (don't route traffic until healthy) and for liveness (restart if unhealthy). Same fields as a Kubernetes HTTP probe.

### `spec.dependencies`

Declarative list of things the app needs from the workspace. Each entry is either:

**`kind: postgres` / `kind: redis`** — the workspace's [shared agent resources](/architecture/shared-agent-resources). `shared: true` is required for now (dedicated-per-preview is future work). The provider mints a per-environment database + role (for Postgres) or per-environment user + key-prefix (for Redis), and populates the listed `provides` env vars with the connection string.

```yaml
dependencies:
  - kind: postgres
    shared: true
    provides: [DATABASE_URL]
```

**`kind: mcp`** — an MCP server attached to the running agent. `name` must match an attached MCP. The provider doesn't deploy anything (MCPs are attached via the agent config); it validates that the named MCP exists and that the declared secrets are present.

```yaml
dependencies:
  - kind: mcp
    name: notion
    provides: [NOTION_MCP_URL]
```

Missing dependencies surface as validator errors at dry-run. If you declare a shared Postgres but the workspace doesn't have one installed, validation fails with `dependency_not_available`; the orchestrator can then decide whether to install one first.

### `spec.env`

Environment variables for the runtime container. Every entry has a `name` and one of four `from` sources:

| `from` | What it resolves to |
|---|---|
| `literal` | The `value` field literally. Never use this for secrets. |
| `secret:<name>` | The value of the named workspace secret. Never appears in the rendered pod spec — provider injects via `secretKeyRef`. |
| `preview.self_url` | The preview environment's durable URL. Useful for `NEXT_PUBLIC_APP_URL`, OAuth redirect bases, webhook self-registration. |
| `preview.share_base_url` | Where the api serves shares for this session. For embedded dashboards that link to share artifacts. |
| `dep:<dep-index>.<field>` | A field from the resolved dependency. `dep:0.url` returns the first dependency's provided URL. |

Validation refuses duplicate names, refuses `literal` + `value` missing, refuses `from: secret:X` where secret X doesn't exist.

### `spec.resources`

Standard Kubernetes resource quantities. Provider enforces the workspace's preview quota as a ceiling — requests above the quota fail validation with actionable numbers.

### `spec.volumes`

Limited to `emptyDir` (disk-backed scratch space) and `tmpfs` (RAM-backed — `emptyDir` with `medium: Memory`). No `hostPath`, no `persistentVolumeClaim`, no `secret`, no `configMap` at the spec level. If your app needs something more exotic, switch `entrypoint.kind` to `manifest` and declare it yourself — with the understanding that the validator's security checks apply.

### `spec.ingress`

Rarely needed. Only used when the app has non-standard routing requirements. Most apps leave this unset and inherit the provider's defaults.

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
