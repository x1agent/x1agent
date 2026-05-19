-- Per-user IANA timezone. Drives display of every UTC timestamp in
-- the app (session timestamps, cost rollups, share created_at) and
-- the ScheduleBuilder's local↔UTC conversion when rendering an
-- agent's cron expression.
--
-- Nullable: legacy users without a value get formatted in UTC until
-- they set one. The /account page captures their browser's
-- Intl.DateTimeFormat().resolvedOptions().timeZone on first save.

ALTER TABLE users
  ADD COLUMN timezone TEXT NULL;

COMMENT ON COLUMN users.timezone IS
  'IANA timezone (e.g. America/New_York). NULL → format in UTC.';
