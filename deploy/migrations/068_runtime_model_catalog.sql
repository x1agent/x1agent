-- 068_runtime_model_catalog
-- Runtime-owned model catalog and pricing metadata. Runtime adapters may
-- refresh this table from their harness/provider; permissions refer to the
-- stable runtime_type + model_id pair rather than image names.

CREATE TABLE IF NOT EXISTS runtime_models (
  runtime_type TEXT NOT NULL
    CHECK (runtime_type IN ('claude_code', 'codex')),
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  input_usd_per_million NUMERIC(10, 4),
  output_usd_per_million NUMERIC(10, 4),
  cache_read_multiplier NUMERIC(6, 4),
  cache_write_multiplier NUMERIC(6, 4),
  source TEXT,
  discovered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (runtime_type, model_id)
);

CREATE INDEX IF NOT EXISTS runtime_models_enabled_idx
  ON runtime_models(runtime_type, enabled, display_name);

INSERT INTO schema_migrations (version) VALUES ('068_runtime_model_catalog')
  ON CONFLICT DO NOTHING;
