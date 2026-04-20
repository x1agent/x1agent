-- 012_shared_agent_resources
-- Long-running, workspace-scoped backing services that agents connect to
-- (Postgres, Redis, ...). Installed by a workspace admin from a catalog;
-- isolated per (repo, branch) so two agents on two branches never step on
-- each other. See docs/architecture/shared-agent-resources.md for the
-- binding design and the isolation rules that keep these strictly
-- separate from the control-plane database.

-- One row per installed resource in the workspace. v1 enforces "one
-- instance per kind per workspace" via the UNIQUE (workspace_id, kind)
-- constraint; lifting that later is additive and would move to a
-- name-scoped key.
CREATE TABLE IF NOT EXISTS workspace_shared_resources (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Engine identifier. 'postgres' | 'redis' in v1; the catalog in code
  -- decides what's installable.
  kind TEXT NOT NULL,
  -- Engine version ('16', '7', ...). Combined with `kind` to pick the
  -- concrete image at provision time.
  version TEXT NOT NULL,
  -- Adapter id. 'statefulset' in v1; 'cloudnative-pg', 'neon', 'upstash',
  -- etc. in future. Helm values select the default per kind.
  provider TEXT NOT NULL,
  -- Admin-provided config (storage_size, resource requests, etc).
  -- Adapter-specific shape; validated at save time.
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Name of the K8s Secret (in the workspace namespace) holding the
  -- engine's admin credentials. The value is never copied into this
  -- table; only the reference.
  admin_secret_ref TEXT NOT NULL,
  -- provisioning | running | failed. `failed` carries a structured
  -- reason in `status_reason`.
  status TEXT NOT NULL DEFAULT 'provisioning',
  status_reason TEXT,
  installed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind)
);

CREATE INDEX IF NOT EXISTS workspace_shared_resources_workspace_idx
  ON workspace_shared_resources(workspace_id);

-- Per-branch Postgres metadata. One row per (resource, repo, branch).
-- `branch_id` is the sanitized+hashed identifier used as both the DB
-- name and the owner role name — see
-- docs/architecture/shared-agent-resources.md#per-branch-isolation.
CREATE TABLE IF NOT EXISTS workspace_postgres_branches (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  resource_id UUID NOT NULL REFERENCES workspace_shared_resources(id) ON DELETE CASCADE,
  -- agent_repos has a composite PK (agent_id, repo_full_name). We scope
  -- by repo_full_name so the branch DB follows the repo across agents.
  repo_full_name TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reaped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_id, repo_full_name, branch_name)
);

CREATE INDEX IF NOT EXISTS workspace_postgres_branches_resource_idx
  ON workspace_postgres_branches(resource_id)
  WHERE reaped_at IS NULL;

-- Per-branch Redis metadata. Parallel shape to postgres branches; the
-- `branch_id` is the ACL username + key prefix root.
CREATE TABLE IF NOT EXISTS workspace_redis_branches (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  resource_id UUID NOT NULL REFERENCES workspace_shared_resources(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reaped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_id, repo_full_name, branch_name)
);

CREATE INDEX IF NOT EXISTS workspace_redis_branches_resource_idx
  ON workspace_redis_branches(resource_id)
  WHERE reaped_at IS NULL;

INSERT INTO schema_migrations (version) VALUES ('012_shared_agent_resources')
  ON CONFLICT DO NOTHING;
