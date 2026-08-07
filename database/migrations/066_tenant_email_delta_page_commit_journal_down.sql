-- Explicit down/rollback for 066_tenant_email_delta_page_commit_journal.
-- Fail closed when any page_commit or worker-actor journal rows exist —
-- never silently drop durable page-commit evidence.
-- When only staff 065-compatible rows remain, precisely restore 065 shape.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM tenant_email_delta_recovery_operations
     WHERE operation_kind = 'page_commit'
        OR actor_kind = 'worker'
        OR worker_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      '066_down_refused: page_commit or worker journal rows present — refuse silent evidence loss';
  END IF;

  -- Staff rows must still carry a staff actor before restoring NOT NULL.
  IF EXISTS (
    SELECT 1
      FROM tenant_email_delta_recovery_operations
     WHERE actor_staff_user_id IS NULL
  ) THEN
    RAISE EXCEPTION
      '066_down_refused: null actor_staff_user_id rows present — refuse silent evidence loss';
  END IF;
END $$;

-- Drop 066 constraints first.
ALTER TABLE tenant_email_delta_recovery_operations
  DROP CONSTRAINT tenant_email_delta_recovery_operations_actor_coupling;

ALTER TABLE tenant_email_delta_recovery_operations
  DROP CONSTRAINT tenant_email_delta_recovery_operations_actor_kind_values;

ALTER TABLE tenant_email_delta_recovery_operations
  DROP CONSTRAINT tenant_email_delta_recovery_operations_outcome_result_coupling;

ALTER TABLE tenant_email_delta_recovery_operations
  DROP CONSTRAINT tenant_email_delta_recovery_operations_target_coupling;

ALTER TABLE tenant_email_delta_recovery_operations
  DROP CONSTRAINT tenant_email_delta_recovery_operations_kind_values;

-- Drop 066 columns (no page_commit/worker rows remain).
ALTER TABLE tenant_email_delta_recovery_operations
  DROP COLUMN worker_id;

ALTER TABLE tenant_email_delta_recovery_operations
  DROP COLUMN actor_kind;

-- Restore 065 staff actor NOT NULL.
ALTER TABLE tenant_email_delta_recovery_operations
  ALTER COLUMN actor_staff_user_id SET NOT NULL;

-- Restore exact 065 kind / target / outcome-result coupling.
ALTER TABLE tenant_email_delta_recovery_operations
  ADD CONSTRAINT tenant_email_delta_recovery_operations_kind_values
  CHECK (operation_kind IN ('restart_generation', 'reconcile_page_commit'));

ALTER TABLE tenant_email_delta_recovery_operations
  ADD CONSTRAINT tenant_email_delta_recovery_operations_target_coupling
  CHECK (
    (
      operation_kind = 'restart_generation'
      AND target_operation_id IS NULL
    )
    OR (
      operation_kind = 'reconcile_page_commit'
      AND target_operation_id IS NOT NULL
    )
  );

ALTER TABLE tenant_email_delta_recovery_operations
  ADD CONSTRAINT tenant_email_delta_recovery_operations_outcome_result_coupling
  CHECK (
    (
      outcome = 'committed'
      AND operation_kind = 'restart_generation'
      AND result_generation IS NOT NULL
    )
    OR (
      outcome = 'committed'
      AND operation_kind = 'reconcile_page_commit'
      AND result_generation IS NULL
    )
    OR (
      outcome IN (
        'claimed',
        'not_committed',
        'commit_outcome_unknown',
        'conflict',
        'evidence_unavailable'
      )
      AND result_generation IS NULL
      AND result_state_version IS NULL
      AND result_phase IS NULL
    )
  );

COMMENT ON TABLE tenant_email_delta_recovery_operations IS
  'Offline recovery journal for restart_generation / reconcile_page_commit. Empty on migrate. No mailbox/cursor/PII/JSON. Tenant-safe actor via staff_users (client_id, id).';

COMMENT ON COLUMN tenant_email_delta_recovery_operations.actor_staff_user_id IS
  'Tenant-safe staff actor: composite FK (client_id, actor_staff_user_id) → staff_users (client_id, id).';

COMMIT;
