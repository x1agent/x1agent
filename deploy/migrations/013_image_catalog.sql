-- 013_image_catalog
-- Minimal image catalog for Phase 1: platform presets referenced from
-- agent configs. Admin-authored images (Dockerfile + Kaniko builds +
-- siblings) come in Phase 2 and add columns to this table; Phase 1
-- tables + FK land now so pod-spec can resolve agent.image_id without
-- hard-coding the agent image at deploy time.
--
-- Binding architecture: docs/architecture/runtime-images.md.

CREATE TABLE IF NOT EXISTS agent_images (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  -- NULL workspace_id = platform preset, visible to every workspace.
  -- A non-null workspace_id scopes the image to that workspace (Phase 2).
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  -- Fully-qualified registry reference including tag or digest. Pod-spec
  -- uses this verbatim as the agent container image.
  built_ref TEXT NOT NULL,
  is_preset BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Platform presets are global; workspace images are workspace-scoped.
CREATE UNIQUE INDEX IF NOT EXISTS agent_images_preset_name_uq
  ON agent_images(name)
  WHERE workspace_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agent_images_workspace_name_uq
  ON agent_images(workspace_id, name)
  WHERE workspace_id IS NOT NULL;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS image_id UUID REFERENCES agent_images(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agents_image_id_idx
  ON agents(image_id)
  WHERE image_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('013_image_catalog')
  ON CONFLICT DO NOTHING;
