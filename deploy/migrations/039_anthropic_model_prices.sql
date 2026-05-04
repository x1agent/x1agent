-- Per-model price overrides on top of the tier-classifier default.
--
-- The cost calculator in postgres-token-usage-repository.ts derives
-- input/output rates and cache multipliers from a substring match
-- on the model id ("opus" / "sonnet" / "haiku") so a fresh install
-- works without any operator action. These columns let admins
-- override the default for a specific model id when Vertex changes
-- a SKU rate, the operator negotiates enterprise pricing, or a new
-- tier ships that the classifier doesn't recognise.
--
-- All four columns are nullable. NULL means "use the tier default
-- at compute time"; a non-null value pins the override and the
-- rollup respects it. Mixing nulls and non-nulls per row is fine —
-- you can pin only the input rate and let the cache multipliers
-- follow the default.
--
-- NUMERIC chosen over DOUBLE PRECISION: prices show up in
-- customer-visible cost numbers and we don't want float drift.

ALTER TABLE anthropic_model_overrides
  ADD COLUMN input_usd_per_million  NUMERIC(10, 4),
  ADD COLUMN output_usd_per_million NUMERIC(10, 4),
  ADD COLUMN cache_read_multiplier  NUMERIC(6, 4),
  ADD COLUMN cache_write_multiplier NUMERIC(6, 4);
