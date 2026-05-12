---
title: Quickstart
description: Run x1agent locally in under five minutes
sidebar:
  order: 0
---

This guide stands up a fully functional x1agent stack on your laptop using OrbStack Kubernetes. You'll end up with a running cluster, one seeded admin account, the secrets your sessions need, and a browser tab showing your first agent session.

## Prerequisites

You need these on your machine. No other assumptions.

- **OrbStack** with Kubernetes enabled. The `orbstack` kube context is what x1agent targets in local dev. (`orbctl start k8s` if it isn't already up.)
- **mise** (`brew install mise` or equivalent). Every task runs through `mise run`.
- **Docker** — OrbStack provides the daemon.
- **kubectl** — the repo's `mise.toml` pins your `KUBECONFIG` to OrbStack so nothing targets the wrong cluster.

No Google Cloud account, no AWS credentials, no Vault, no SMTP server. The local quickstart runs entirely on your machine.

## What you'll need to know before you start

You'll be asked for a few things during setup. Have them ready:

- **An email address and a password** for the admin account x1agent seeds. Any valid email works — it's never sent anywhere.
- An **OpenAI API key** (optional) — only needed if you want to use collections with vector embeddings.
- A **GitHub personal access token** (optional) — only needed if you want agents to clone private repos. For public repos, skip it.

## Run the quickstart

```bash
git clone https://github.com/x1agent/x1agent.git
cd x1agent
mise run quickstart
```

`mise run quickstart` launches a small terminal wizard that walks you through the setup. The wizard is idempotent — rerun it any time to add more secrets or reset the admin password.

### What the wizard does, screen by screen

**1. Preflight checks.** Verifies that `~/.orbstack/k8s/config.yml` exists, the current kube context is `orbstack`, and `kubectl cluster-info` succeeds. If anything is red, the wizard tells you what to run and stops without touching the cluster. (Postgres/NATS readiness is checked later by `mise run dev`, not by the wizard.)

**2. Admin account.** Email + password (masked). The wizard hashes the password with argon2id before it ever touches the database. You'll use these credentials to sign in to the web UI.

**3. Anthropic API key.** You're prompted for your key (starts with `sk-ant-`). Paste it once; the wizard writes it as a Kubernetes Secret in the dedicated `x1agent-secrets` namespace and creates an `ExternalSecret` reference so agent pods can mount it on demand. The plaintext never lands anywhere else — not in the wizard's config file, not in the repo, not in any log.

**4. Optional secrets.** OpenAI and GitHub PAT are offered next. You can skip either and add them later through the web UI. The wizard flags which features won't work without each: "Vector collections will be inactive without OpenAI", "Agents can only clone public repos without GitHub".

**5. Install + apply.** The wizard:
- Creates the `x1agent` and `x1agent-secrets` namespaces.
- Installs the [External Secrets Operator](https://external-secrets.io/) via Helm into the `external-secrets` namespace.
- Writes the secrets you provided as `Secret` objects under `x1agent-secrets` (`x1-secret-anthropic-api-key`, `x1-secret-openai-api-key` if you supplied one, `x1-secret-github-pat` if you supplied one).

The wizard does NOT yet:
- Apply a `ClusterSecretStore` (planned: a `x1-local` store using ESO's `kubernetes` provider).
- Materialize per-workspace `ExternalSecret` resources (planned).
- Seed your admin user (planned — for now sign in via the dev auth bypass).
- Bring up the api/app — that is `mise run dev`, run separately in its own terminal.

**6. Finish.** Prints the next-step instructions and the command to tail the cluster logs (`mise run dev:cluster:logs`) if something breaks.

After the wizard completes, in another terminal:

```bash
mise run dev          # brings up postgres, nats, api, app via devspace
```

Then open `https://app.local.x1agent.dev`. The local CA created by `mise run dev:cert-manager` is trusted in your macOS keychain, so the cert is valid.

Total time on a warm machine: about three minutes.

## Your first session

1. Open `https://app.local.x1agent.dev`. Until the admin-seed step lands, sign in via the dev auth bypass at `/auth/dev-bypass` (set `AUTH_BYPASS=true` and `TEST_USER=you@example.com` in `.env.local` first — see `.env.example`).
2. The first workspace (`default`) is seeded empty. Click **Agents** in the sidebar → **New agent**. Give it a name and runtime (`claude_code` is the only option today), leave the schedule as "Manual only", save.
3. On the agent detail page, use the **Run** card at the top. Type something like "Write a markdown hello-world and share it" and hit **Run with prompt**.
4. You should see events stream in as the agent thinks, writes a file under `/workspace`, and emits a share card inline.

If no events arrive, see [Troubleshooting](#troubleshooting) below.

## How secrets flow at runtime (planned)

> The flow below describes the intended end-state. Today the wizard writes
> Secrets directly to `x1agent-secrets` via `kubectl`, and there is no
> per-workspace `ExternalSecret` machinery yet. Track the gap in the
> "wizard polish" milestone.

The wizard's work ends when the stack is up. What the quickstart actually delivers is a loop that looks like this:

```mermaid
graph LR
    user["You"] -->|types secret once| api["api"]
    api -->|writes once| k8s["Secret in<br/>x1agent-secrets"]
    api -->|writes reference| es["ExternalSecret in<br/>workspace namespace"]
    es -->|reconciles| eso["External Secrets<br/>Operator"]
    eso -->|materializes| podSec["Secret in<br/>workspace namespace"]
    podSec -->|secretKeyRef| pod["Agent pod<br/>(env var)"]
```

The value transits the api exactly once — on the wizard's write. From then on, it lives inside the cluster and is delivered to pods by ESO, never re-read by x1agent code. You can verify with `kubectl -n x1agent-secrets get secrets` that the values are present and `kubectl -n x1agent-ws-<id> get externalsecret,secret` that the references and materialized copies look right.

This matches the production topology. When you later want to swap the in-cluster storage for Vault, AWS Secrets Manager, or another external backend, you change the `ClusterSecretStore`'s provider config — nothing in x1agent's code, and nothing in your workspaces or agent definitions, changes. See [Secrets management](/security/secrets) for the full model and [Production deployment](/deployment/kubernetes) for the upgrade path.

## Adding more secrets after setup

Two equivalent paths:

- **Web UI** — Workspace → Settings → Secrets. Paste the value; x1agent writes the Secret + ExternalSecret as described above.
- **CLI** — `mise run quickstart` again. Detects existing setup, skips everything already configured, offers the not-yet-set secrets.

## Re-running the wizard

`mise run quickstart` is idempotent. Rerun it to:

- Change the admin password.
- Add optional secrets you skipped.
- Reseed a secret whose value changed.
- Reapply Helm values after a repo upgrade.

It never destroys state. If you want a clean slate, delete the cluster namespaces (`kubectl delete namespace x1agent x1agent-secrets 'x1agent-ws-*'`) and rerun.

## What's not in the quickstart

The local install is a single-operator, single-machine configuration. It explicitly does not cover:

- **TLS / ingress** — everything runs on `localhost`. Production deployments need ingress + certs; see [Production deployment](/deployment/kubernetes).
- **External secrets backend** — local uses the K8s provider, keeping everything in etcd. Production usually points ESO at Vault, AWS Secrets Manager, GCP Secret Manager, or similar.
- **Password reset flow** — there's no SMTP dependency. If you forget the admin password, rerun the wizard.
- **High availability** — one replica of each service. Fine for local development, not for prod.
- **Backups** — etcd is the source of truth for all local state. Back up your cluster volumes if anything matters.

## Troubleshooting

**OrbStack API stalls.** Symptoms: `kubectl` hangs or times out. Fix: `orbctl stop k8s && orbctl start k8s`, or fully restart the OrbStack app. Do not fall back to raw Docker containers — local dev requires OrbStack.

**OrbStack VM wedges after a long session.** Symptoms: pods restart in tight loops, `kubectl logs` prints `rpc error: code = Unknown desc = docker does not support reopening container log files`, node disk fills up. Cause: OrbStack's Kubernetes uses Docker + cri-dockerd, and cri-dockerd's `ReopenContainerLog` CRI method is a [stub that always fails](https://github.com/Mirantis/cri-dockerd/issues/337). When any container's log file exceeds kubelet's `containerLogMaxSize` (10Mi by default), kubelet tries to rotate via `ReopenContainerLog` every 10 seconds and never succeeds. The file grows without bound on the container's original fd.

The fix is to configure Docker's json-file log driver to rotate **before** kubelet's threshold, so kubelet never has a reason to call the broken method. Edit `~/.orbstack/config/docker.json`:

```json
{
  "features": { "buildkit": true },
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "20"
  }
}
```

Then restart OrbStack (`orbctl stop && orbctl start`). Existing containers keep their old log config — the restart recreates them. Verify with `docker inspect <container-id> --format '{{json .HostConfig.LogConfig}}'`; the output should show `max-size: 10m, max-file: 20`.

This is an OrbStack-local workaround. Production Kubernetes with containerd has no such bug.

**Postgres says "too many clients already".** Restart the api pod: `kubectl -n x1agent rollout restart deploy/api`. A known dev-mode issue when many hot reloads stack tick loops — the fix is a single restart.

**Pod stuck on `(Still waiting...)` after a cluster restart.** The `api-devspace` or `app-devspace` pod logs just repeat `(Still waiting...)` and never boot. Cause: devspace's `devspace-restart-helper` watches for a `/.devspace/start` marker that the devspace client writes once the initial file-sync completes. After an OrbStack / kubelet restart the helper is re-running inside the new container but devspace's client-side sync state has already flipped to "synced," so the marker never arrives. Fix: `kubectl -n x1agent delete pod <pod-name>` — devspace's watch reconciles against the fresh pod, the sync runs again, the marker lands, the app boots. Affects any deployment listed under `devspace.yaml`'s `dev:` block.

**New MCP tool or sidecar route not visible in a session.** The `x1agent-agent` and `x1agent-sidecar` images are built once and referenced verbatim by every session Job — `devspace dev`'s file-sync only overlays long-running pods (api, app), not Jobs. Changes under `packages/agent/` or `packages/sidecar/` need a manual image rebuild before new session pods pick them up. Run `mise run images:session` to rebuild and tag both images, then cancel + restart the session that needs the change.

**Agent pod stuck in "pending".** Usually a missing image. Rebuild from the repo: `mise run images:session` (rebuilds agent + sidecar) or `devspace build -b agent,sidecar -n x1agent`. New sessions pick up the rebuild; in-flight sessions keep their old image.

**Session starts but agent says "Not logged in · Please run /login".** The Anthropic key wasn't set correctly. Rerun `mise run quickstart` and re-enter the key at the secrets step.

**Blank session viewer.** Usually Vite's pre-bundle cache is stale. Hard refresh the browser (`Cmd+Shift+R`); if it persists, restart the app pod.

## Next steps

- [Secrets management](/security/secrets) — the full model behind what the wizard just did.
- [Production deployment](/deployment/kubernetes) — take this stack to a real cluster.
- [Security model](/security/overview) — trust boundaries, credential isolation, permission grants.
