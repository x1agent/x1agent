-- Durable preview environments. Each row is a long-lived slot in a
-- workspace that successive preview_deploy calls update in place,
-- giving the operator a stable URL + a list page in the sidebar.
--
-- Lifecycle:
--   1. First preview_deploy({ repo_full_name, branch, commit_sha }) for
--      a (workspace, slug) inserts a row; subsequent deploys UPDATE.
--      Slug is taken from the repo's .x1agent/preview.yaml metadata.name.
--   2. The provider applies the deploy to the cluster and writes back
--      the resulting url/image/build status (`last_deploy_*` columns).
--   3. Workspace admins see the list at /workspaces/:slug/environments
--      and the detail page resolves by env id or slug.
--
-- Out of scope for v1 (will land later):
--   - claim semantics (preview_claims table; force-takeover flow)
--   - per-environment resource bindings (postgres, redis) — these are
--     workspace_shared_resources rows joined via a separate table once
--     the shared-resources subsystem is implemented.
--   - history of past deploys per environment (today: last_deploy_* only).
--
-- Tenancy: workspace_id is on the row and every list/read query MUST
-- WHERE on it. The UNIQUE (workspace_id, slug) constraint prevents two
-- workspaces seeing each other's slugs in the picker and stops
-- collisions when two repos in the same workspace share a slug — second
-- repo's deploy fails with a domain error, operator picks a different
-- slug or rotates one repo's preview.yaml.

CREATE TABLE preview_environments (
  id                       UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Comes from .x1agent/preview.yaml metadata.name. K8s DNS-1123 label
  -- shape; the provider already validates this so we accept it as-is.
  slug                     TEXT NOT NULL,

  -- Operator-facing label. Defaults to slug on first deploy; the UI
  -- lets admins rename without touching the slug (the slug is the
  -- routing key in the URL).
  title                    TEXT NOT NULL,

  -- Source repo for the most recent deploy. Tracked for the list page
  -- and so the UI can offer "redeploy from <branch>@HEAD" without
  -- requiring the operator to re-pass it.
  repo_full_name           TEXT NOT NULL,
  branch                   TEXT NOT NULL,

  -- Most recent deploy outcome. NULL until the first successful provision.
  last_deploy_sha          TEXT,
  last_deploy_url          TEXT,
  last_deploy_image_ref    TEXT,
  last_deploy_status       TEXT NOT NULL DEFAULT 'pending',
    -- pending | provisioning | ready | failed
  last_deploy_status_reason TEXT,
  last_deploy_at           TIMESTAMPTZ,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, slug)
);

-- List page queries by workspace; sorted desc on last_deploy_at to surface
-- recently active environments. Partial index keeps the hot path small.
CREATE INDEX preview_environments_workspace_recent_idx
  ON preview_environments (workspace_id, last_deploy_at DESC NULLS LAST);

-- updated_at maintained by trigger so the application code doesn't have
-- to remember it on every UPDATE.
CREATE OR REPLACE FUNCTION preview_environments_touch_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER preview_environments_updated_at
  BEFORE UPDATE ON preview_environments
  FOR EACH ROW
  EXECUTE FUNCTION preview_environments_touch_updated_at();
