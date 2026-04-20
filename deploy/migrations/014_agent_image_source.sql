-- 014_agent_image_source
-- Stores the Dockerfile source on every agent_images row so the UI can
-- render the actual file (not just a description) and so the build
-- pipeline (Phase 2) has something to hand Kaniko.
--
-- Presets are seeded with source read from deploy/images/<name>/Dockerfile
-- at api boot. Workspace-authored images populate this at create time
-- via the POST /agent-images endpoint. Existing rows default to '' so
-- the migration is safe to run against a populated table.
--
-- build_status tracks the pipeline: presets are always 'ready' (built
-- by the mise task out-of-band); workspace-authored rows start at
-- 'pending' and move through 'building' -> 'succeeded' / 'failed' as
-- the Kaniko Job runs.

ALTER TABLE agent_images
  ADD COLUMN IF NOT EXISTS dockerfile_source TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS build_status TEXT NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS build_log TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_built_at TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('014_agent_image_source')
  ON CONFLICT DO NOTHING;
