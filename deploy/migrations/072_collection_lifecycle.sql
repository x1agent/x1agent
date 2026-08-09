ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS provisioning_status text NOT NULL DEFAULT 'ready'
    CHECK (provisioning_status IN (
      'pending', 'provisioning', 'ready', 'failed', 'deleting'
    )),
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS last_error_message text,
  ADD COLUMN IF NOT EXISTS provision_attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_provisioned_at timestamptz;

CREATE TABLE IF NOT EXISTS collection_provision_operations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('provision', 'deprovision')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collection_provision_operations_ready_idx
  ON collection_provision_operations (available_at, created_at)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS collection_provision_operations_active_uq
  ON collection_provision_operations (collection_id, operation)
  WHERE status IN ('pending', 'processing');

INSERT INTO schema_migrations (version) VALUES ('072_collection_lifecycle')
  ON CONFLICT DO NOTHING;
