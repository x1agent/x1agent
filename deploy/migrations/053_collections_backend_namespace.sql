-- 053_collections_backend_namespace
-- t03 P0 #2 Layer 2 (security sweep 2026-05-14). Move SurrealDB
-- isolation from a single install-wide namespace down to one
-- namespace per workspace. The database stays per-collection, so:
--
--   - the SurrealDB namespace becomes `ws_<workspace_slug>`
--   - the SurrealDB database stays `col_<workspace>_<collection>`
--     (kept as-is so a legacy collection's data is still reachable
--     under the new namespace without a data move — see migration
--     note below)
--
-- A successful `USE NS x` from agent A no longer lets the connection
-- see workspace B's database, because there is no shared parent
-- namespace anymore.

ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS backend_namespace TEXT;

-- Backfill from the workspace's slug. WorkspaceSlug is kebab-case;
-- SurrealDB namespace identifiers don't permit `-`, so we replace
-- with `_` (same convention as the existing backend_handle builder).
UPDATE collections c
   SET backend_namespace = 'ws_' || replace(w.slug, '-', '_')
  FROM workspaces w
 WHERE w.id = c.workspace_id
   AND c.backend_namespace IS NULL;

-- Tighten the column once backfill is done. New rows must always
-- supply this — `createCollection` writes both columns in one INSERT.
ALTER TABLE collections
  ALTER COLUMN backend_namespace SET NOT NULL;

-- Existing collections in pre-Layer-2 deployments stored data in the
-- shared `x1agent` namespace. Pre-revenue means most installs have
-- zero rows; for the ones that don't, the data is reachable from the
-- new namespace because we ship a one-shot relocate inside
-- SurrealGraphProvider.provision when it detects `info for ns` rows
-- pointing at a legacy db name. See `docs/security/t03-tenancy.md`
-- in the orchestrator repo for the operator-side runbook.

INSERT INTO schema_migrations (version)
  VALUES ('053_collections_backend_namespace')
  ON CONFLICT DO NOTHING;
