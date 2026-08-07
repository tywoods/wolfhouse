-- 066_tenant_email_delta_page_commit_journal.sql
-- Extend 065 recovery journal for durable page_commit attribution (prerequisite).
-- No routes/runtime/worker/scheduler activation. No seed/backfill of page commits.
--
-- Safest schema: keep tenant_email_delta_recovery_operations as the single journal.
-- Adds operation_kind page_commit + actor_kind staff|worker coupling without
-- weakening existing staff restart_generation / reconcile_page_commit rows.
--
-- Actor model:
--   actor_kind = staff  → actor_staff_user_id NOT NULL, worker_id NULL,
--                         kind IN (restart_generation, reconcile_page_commit)
--   actor_kind = worker → actor_staff_user_id NULL, worker_id exact
--                         'sunset-email-delta-worker', kind = page_commit
--
-- Existing 065 rows migrate deterministically actor_kind='staff' (DEFAULT).
-- actor_staff_user_id becomes nullable for worker rows; staff FK remains
-- tenant-safe when present (NULL worker rows skip FK).
--
-- page_commit:
--   target_operation_id IS NULL
--   committed requires result triple (generation/version/phase after CAS)
--   journaled by commitPageEvents in the same exclusive-client TX as events+cursor
--
-- No mailbox/provider/cursor/message/email/subject/token/free-text/JSON columns.
-- Rollback: 066_tenant_email_delta_page_commit_journal_down.sql (fail-closed)

BEGIN;

-- ── actor_kind: staff (existing) | worker (page_commit only) ──────────────
ALTER TABLE tenant_email_delta_recovery_operations
  ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'staff';

ALTER TABLE tenant_email_delta_recovery_operations
  ADD COLUMN worker_id TEXT NULL;

-- Worker rows need nullable staff actor; staff FK remains when non-null.
ALTER TABLE tenant_email_delta_recovery_operations
  ALTER COLUMN actor_staff_user_id DROP NOT NULL;

-- Drop constraints that expand under 066 (recreated below).
ALTER TABLE tenant_email_delta_recovery_operations
  DROP CONSTRAINT tenant_email_delta_recovery_operations_kind_values;

ALTER TABLE tenant_email_delta_recovery_operations
  DROP CONSTRAINT tenant_email_delta_recovery_operations_target_coupling;

ALTER TABLE tenant_email_delta_recovery_operations
  DROP CONSTRAINT tenant_email_delta_recovery_operations_outcome_result_coupling;

-- Expanded kinds: page_commit joins restart_generation / reconcile_page_commit.
ALTER TABLE tenant_email_delta_recovery_operations
  ADD CONSTRAINT tenant_email_delta_recovery_operations_kind_values
  CHECK (operation_kind IN (
    'restart_generation',
    'reconcile_page_commit',
    'page_commit'
  ));

-- Target coupling: page_commit has no target (like restart).
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
    OR (
      operation_kind = 'page_commit'
      AND target_operation_id IS NULL
    )
  );

-- Actor coupling: staff ops remain staff-only; page_commit is worker-only with
-- source-pinned worker id sunset-email-delta-worker (bounded 1..128, exact pin).
ALTER TABLE tenant_email_delta_recovery_operations
  ADD CONSTRAINT tenant_email_delta_recovery_operations_actor_kind_values
  CHECK (actor_kind IN ('staff', 'worker'));

ALTER TABLE tenant_email_delta_recovery_operations
  ADD CONSTRAINT tenant_email_delta_recovery_operations_actor_coupling
  CHECK (
    (
      actor_kind = 'staff'
      AND actor_staff_user_id IS NOT NULL
      AND worker_id IS NULL
      AND operation_kind IN ('restart_generation', 'reconcile_page_commit')
    )
    OR (
      actor_kind = 'worker'
      AND actor_staff_user_id IS NULL
      AND worker_id IS NOT NULL
      AND char_length(worker_id) >= 1
      AND char_length(worker_id) <= 128
      AND worker_id = 'sunset-email-delta-worker'
      AND operation_kind = 'page_commit'
    )
  );

-- Outcome/result coupling: page_commit committed stores result triple for replay.
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
      outcome = 'committed'
      AND operation_kind = 'page_commit'
      AND result_generation IS NOT NULL
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

COMMENT ON COLUMN tenant_email_delta_recovery_operations.actor_kind IS
  'staff (restart_generation/reconcile_page_commit) or worker (page_commit only). Existing 065 rows default staff.';

COMMENT ON COLUMN tenant_email_delta_recovery_operations.worker_id IS
  'Worker actor id; required and exact sunset-email-delta-worker when actor_kind=worker. NULL for staff.';

COMMENT ON COLUMN tenant_email_delta_recovery_operations.actor_staff_user_id IS
  'Tenant-safe staff actor when actor_kind=staff (composite FK). NULL when actor_kind=worker.';

COMMENT ON TABLE tenant_email_delta_recovery_operations IS
  'Recovery journal: restart_generation / reconcile_page_commit (staff) + page_commit (worker sunset-email-delta-worker). No mailbox/cursor/PII/JSON.';

COMMIT;
