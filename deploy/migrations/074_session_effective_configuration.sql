ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS validation_run boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS validation_task text,
  ADD COLUMN IF NOT EXISTS effective_runtime_type text,
  ADD COLUMN IF NOT EXISTS effective_model text,
  ADD COLUMN IF NOT EXISTS effective_image_ref text,
  ADD COLUMN IF NOT EXISTS agent_configuration_revision timestamptz,
  ADD CONSTRAINT sessions_validation_task_length
    CHECK (validation_task IS NULL OR length(validation_task) <= 32768);

INSERT INTO schema_migrations (version)
VALUES ('074_session_effective_configuration') ON CONFLICT DO NOTHING;
