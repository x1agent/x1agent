-- 071_runtime_model_default
-- Preserve the harness-reported account default without guessing from sort
-- order or model-family names.

ALTER TABLE runtime_models
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS resolved_model_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS runtime_models_one_default_idx
  ON runtime_models(runtime_type)
  WHERE is_default = TRUE;

INSERT INTO schema_migrations (version) VALUES ('071_runtime_model_default')
  ON CONFLICT DO NOTHING;
