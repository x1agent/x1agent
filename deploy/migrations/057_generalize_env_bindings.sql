-- Generalize agent_env_bindings → env_bindings with a scope discriminator.
--
-- Today every env-var binding is owned by an agent (zone-2 injection at
-- session start). The same shape now needs to serve preview environments
-- and workspace-wide bindings: a workspace admin sets DATABASE_URL once
-- against the workspace, and either an agent session OR a preview deploy
-- can opt into it by selecting the binding name.
--
-- Schema change:
--   * Table renamed agent_env_bindings → env_bindings.
--   * Polymorphic owner: scope ('agent' | 'preview_environment' | 'workspace')
--     plus scope_id UUID. FK is on neither column directly — the application
--     layer enforces that scope_id resolves to a real row in the target
--     table for that scope; ON DELETE behaviour is handled by per-scope
--     cleanup hooks (agent delete cascades env_bindings WHERE scope='agent'
--     AND scope_id=agents.id, etc.).
--   * Uniqueness moves from (agent_id, env_name) to (scope, scope_id, env_name).
--
-- Migration shape: rename the table, add columns, backfill scope='agent'
-- with scope_id from agent_id, drop agent_id, add the new unique. Safe to
-- run online: the table is small (one row per agent×env-var) and no
-- read traffic happens during the migrate hook window.

ALTER TABLE agent_env_bindings RENAME TO env_bindings;

-- Drop the old unique on (agent_id, env_name). It moved.
ALTER TABLE env_bindings DROP CONSTRAINT IF EXISTS agent_env_bindings_agent_id_env_name_key;

ALTER TABLE env_bindings
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'agent',
  ADD COLUMN scope_id UUID;

UPDATE env_bindings SET scope_id = agent_id WHERE scope_id IS NULL;

ALTER TABLE env_bindings ALTER COLUMN scope_id SET NOT NULL;
ALTER TABLE env_bindings ALTER COLUMN scope DROP DEFAULT;

-- agent_id was the only FK link; drop it after the backfill is in place.
ALTER TABLE env_bindings DROP COLUMN agent_id;

ALTER TABLE env_bindings
  ADD CONSTRAINT env_bindings_scope_check
  CHECK (scope IN ('agent', 'preview_environment', 'workspace'));

ALTER TABLE env_bindings
  ADD CONSTRAINT env_bindings_scope_scope_id_env_name_key
  UNIQUE (scope, scope_id, env_name);

-- Replace the per-agent index — same shape under the new schema.
DROP INDEX IF EXISTS agent_env_bindings_agent_id_idx;
CREATE INDEX env_bindings_scope_idx ON env_bindings (scope, scope_id);

-- Cascade delete on owner: agents already had ON DELETE CASCADE via the
-- foreign key we just dropped. Reinstate equivalent behaviour with
-- per-scope triggers — keeps the cleanup invariant without needing
-- conditional FKs (Postgres doesn't support polymorphic FKs natively).
CREATE OR REPLACE FUNCTION env_bindings_cascade_agent_delete()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM env_bindings WHERE scope = 'agent' AND scope_id = OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER env_bindings_cascade_on_agent_delete
  BEFORE DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION env_bindings_cascade_agent_delete();

CREATE OR REPLACE FUNCTION env_bindings_cascade_preview_environment_delete()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM env_bindings WHERE scope = 'preview_environment' AND scope_id = OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER env_bindings_cascade_on_preview_environment_delete
  BEFORE DELETE ON preview_environments
  FOR EACH ROW EXECUTE FUNCTION env_bindings_cascade_preview_environment_delete();

CREATE OR REPLACE FUNCTION env_bindings_cascade_workspace_delete()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM env_bindings WHERE scope = 'workspace' AND scope_id = OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER env_bindings_cascade_on_workspace_delete
  BEFORE DELETE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION env_bindings_cascade_workspace_delete();

-- Add the selected-bindings list to preview_environments. Each preview env
-- opts into a subset of workspace-scoped bindings by name; agent-scoped
-- bindings stay owned by the agent and are looked up via the agent's
-- scope rows (agent has its own picker). v1: name array; future v2 may
-- swap to (scope, name) pairs to allow cross-borrowing.
ALTER TABLE preview_environments
  ADD COLUMN env_var_names JSONB NOT NULL DEFAULT '[]'::jsonb;
