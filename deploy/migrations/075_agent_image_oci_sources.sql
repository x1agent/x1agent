ALTER TABLE agent_images
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'preset'
    CHECK (source_kind IN ('preset', 'workspace_build', 'external_oci')),
  ADD COLUMN IF NOT EXISTS requested_ref text,
  ADD COLUMN IF NOT EXISTS resolved_digest_ref text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE agent_images SET source_kind = CASE
  WHEN is_preset THEN 'preset' ELSE 'workspace_build' END
WHERE source_kind = 'preset';

CREATE TABLE IF NOT EXISTS agent_image_oci_operations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  image_id uuid NOT NULL REFERENCES agent_images(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  requested_ref text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_image_oci_operations_active_uq
  ON agent_image_oci_operations (image_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS agent_image_oci_operations_ready_idx
  ON agent_image_oci_operations (created_at)
  WHERE status IN ('pending', 'processing');

INSERT INTO schema_migrations (version)
VALUES ('075_agent_image_oci_sources') ON CONFLICT DO NOTHING;
