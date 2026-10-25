-- Independent, renewable prepare ownership. Existing open rows predate a
-- control-plane worker and cannot safely be rerun, so make them immediately
-- reconcilable to terminal unknown. Nullable historical terminal rows remain.
BEGIN;
UPDATE luna_v3_prepare_attempts
SET owner_released_at = COALESCE(owner_released_at, now()),
    lease_expires_at = COALESCE(lease_expires_at, now()),
    heartbeat_at = COALESCE(heartbeat_at, created_at)
WHERE outcome = 'started' AND receipt IS NULL
  AND (execution_owner IS NULL OR lease_expires_at IS NULL);

CREATE INDEX IF NOT EXISTS luna_v3_prepare_attempts_control_reconcile_idx
  ON luna_v3_prepare_attempts(lease_expires_at, owner_released_at)
  WHERE outcome = 'started' AND receipt IS NULL;
COMMIT;