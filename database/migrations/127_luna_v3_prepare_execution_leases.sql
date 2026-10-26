-- Durable ownership for the one execution permitted for each authenticated prepare event.
-- A worker renews this lease at Staff boundaries.  Only an expired lease may be
-- reconciled to unknown; every terminal writer must still own the lease.
ALTER TABLE luna_v3_prepare_attempts
  ADD COLUMN IF NOT EXISTS execution_owner uuid,
  ADD COLUMN IF NOT EXISTS execution_backend_pid integer,
  ADD COLUMN IF NOT EXISTS execution_backend_start timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS luna_v3_prepare_attempts_open_lease_idx
  ON luna_v3_prepare_attempts(lease_expires_at)
  WHERE outcome = 'started' AND receipt IS NULL;
