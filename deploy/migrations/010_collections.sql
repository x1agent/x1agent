-- 010_collections
-- Workspace-scoped knowledge stores. Each collection has a backing
-- provider (today: surrealdb; future: neo4j, pgvector-only, whatever).
-- `provider_type` picks the Helm-configured provider; `backend_handle`
-- is the provider's opaque identifier for where it stored the data.
-- See docs/providers/overview.md — graph + vector are separate domains
-- that a single provider may implement.

CREATE TABLE IF NOT EXISTS collections (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  -- Which provider owns this collection's data. Written on create,
  -- immutable afterwards — swapping providers is a re-provision, not
  -- a metadata edit.
  provider_type TEXT NOT NULL,
  -- Provider-opaque backing-store id (SurrealDB db name, Neo4j label,
  -- etc). Derived from workspace slug + collection slug at create
  -- time; never user-editable.
  backend_handle TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT collections_slug_lowercase
    CHECK (slug = lower(slug))
);

-- Slug uniqueness is per workspace — two workspaces can each have a
-- "general" collection without colliding. A global index would leak
-- the existence of other workspaces' slugs via 409s.
CREATE UNIQUE INDEX IF NOT EXISTS collections_workspace_slug_uq
  ON collections(workspace_id, slug);

-- Main list query: one workspace, newest-first.
CREATE INDEX IF NOT EXISTS collections_workspace_created_at_idx
  ON collections(workspace_id, created_at DESC);

-- Agents attach to collections the way they attach to GitHub repos:
-- a many-to-many with a default flag. `is_default` picks the write
-- target for tools that don't name a collection; any other attached
-- collection is still readable.
CREATE TABLE IF NOT EXISTS agent_collections (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  is_default BOOLEAN NOT NULL DEFAULT false,
  attached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, collection_id)
);

-- At most one default per agent — enforced by a partial unique index
-- rather than a trigger, so a plain UPSERT that flips `is_default`
-- surfaces the conflict cleanly if two rows race.
CREATE UNIQUE INDEX IF NOT EXISTS agent_collections_one_default_per_agent
  ON agent_collections(agent_id)
  WHERE is_default = true;

-- Hot path: "which collections does this agent have attached" —
-- called once per session pod launch.
CREATE INDEX IF NOT EXISTS agent_collections_agent_idx
  ON agent_collections(agent_id);

INSERT INTO schema_migrations (version) VALUES ('010_collections')
  ON CONFLICT DO NOTHING;
