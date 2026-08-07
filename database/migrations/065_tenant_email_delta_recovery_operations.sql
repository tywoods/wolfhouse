-- 065_tenant_email_delta_recovery_operations.sql
-- Offline recovery-journal for admin delta recovery operations (prerequisite only).
-- Empty on migrate (no backfill/seed). No routes/runtime activation.
--
-- Journals restart_generation and reconcile_page_commit attempts only.
-- Identity: client-supplied operation_id UUID PK (idempotency key).
-- Tenant FKs: client/location/endpoint composite to registry tables.
-- Actor: tenant-safe composite FK (client_id, actor_staff_user_id)
--   → staff_users (client_id, id) via staff_users_client_id_id_uq from 060.
--
-- No mailbox/provider/cursor/message/email/subject/token/free-text/JSON columns.
-- requested_generation / requested_state_version fence the current generation CAS.
-- result_* coherent nullable triple for successful restart only.
-- reconcile targets are separate operation rows (target_operation_id); this PR
-- does not journal page commits, so reconcile classifies only durable journal
-- evidence (unjournaled/historical → evidence_unavailable at the store layer).
--
-- Bounds match 064: generations/state versions ≤ JS Number.MAX_SAFE_INTEGER.
-- Rollback: 065_tenant_email_delta_recovery_operations_down.sql

BEGIN;

CREATE TABLE tenant_email_delta_recovery_operations (
  operation_id               UUID PRIMARY KEY,
  client_id                  UUID NOT NULL,
  location_id                UUID NOT NULL,
  endpoint_id                UUID NOT NULL,
  actor_staff_user_id        UUID NOT NULL,

  operation_kind             TEXT NOT NULL,
  requested_generation       BIGINT NOT NULL,
  requested_state_version    BIGINT NOT NULL,
  target_operation_id        UUID NULL,

  outcome                    TEXT NOT NULL,

  result_generation          BIGINT NULL,
  result_state_version       BIGINT NULL,
  result_phase               TEXT NULL,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tenant_email_delta_recovery_operations_location_fk
    FOREIGN KEY (client_id, location_id)
    REFERENCES tenant_locations (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT tenant_email_delta_recovery_operations_endpoint_fk
    FOREIGN KEY (client_id, endpoint_id)
    REFERENCES tenant_channel_endpoints (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT tenant_email_delta_recovery_operations_actor_fk
    FOREIGN KEY (client_id, actor_staff_user_id)
    REFERENCES staff_users (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT tenant_email_delta_recovery_operations_kind_values
    CHECK (operation_kind IN ('restart_generation', 'reconcile_page_commit')),

  CONSTRAINT tenant_email_delta_recovery_operations_outcome_values
    CHECK (outcome IN (
      'claimed',
      'committed',
      'not_committed',
      'commit_outcome_unknown',
      'conflict',
      'evidence_unavailable'
    )),

  -- JS Number.MAX_SAFE_INTEGER upper bound — no bigint fencing risk.
  CONSTRAINT tenant_email_delta_recovery_operations_requested_bounds
    CHECK (
      requested_generation >= 1
      AND requested_generation <= 9007199254740991
      AND requested_state_version >= 1
      AND requested_state_version <= 9007199254740991
    ),

  CONSTRAINT tenant_email_delta_recovery_operations_target_coupling
    CHECK (
      (
        operation_kind = 'restart_generation'
        AND target_operation_id IS NULL
      )
      OR (
        operation_kind = 'reconcile_page_commit'
        AND target_operation_id IS NOT NULL
      )
    ),

  -- Result triple: all-null OR all-present with phase + safe bounds.
  CONSTRAINT tenant_email_delta_recovery_operations_result_coherence
    CHECK (
      (
        result_generation IS NULL
        AND result_state_version IS NULL
        AND result_phase IS NULL
      )
      OR (
        result_generation IS NOT NULL
        AND result_state_version IS NOT NULL
        AND result_phase IS NOT NULL
        AND result_phase IN ('initial', 'tracking', 'reset_required', 'paused')
        AND result_generation >= 1
        AND result_generation <= 9007199254740991
        AND result_state_version >= 1
        AND result_state_version <= 9007199254740991
      )
    ),

  -- committed restart requires result triple; terminal non-success keeps nulls;
  -- claimed is in-TX intermediate (null results).
  CONSTRAINT tenant_email_delta_recovery_operations_outcome_result_coupling
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
    )
);

COMMENT ON TABLE tenant_email_delta_recovery_operations IS
  'Offline recovery journal for restart_generation / reconcile_page_commit. Empty on migrate. No mailbox/cursor/PII/JSON. Tenant-safe actor via staff_users (client_id, id).';

COMMENT ON COLUMN tenant_email_delta_recovery_operations.operation_id IS
  'Client-supplied idempotency key (UUID PK). Same id + identical inputs returns persisted result; mismatch → operation_id_conflict at store layer.';

COMMENT ON COLUMN tenant_email_delta_recovery_operations.actor_staff_user_id IS
  'Tenant-safe staff actor: composite FK (client_id, actor_staff_user_id) → staff_users (client_id, id).';

COMMENT ON COLUMN tenant_email_delta_recovery_operations.target_operation_id IS
  'For reconcile_page_commit only: the page-commit operation id being reconciled. Not a self-FK; page commits are not journaled in this PR.';

COMMENT ON COLUMN tenant_email_delta_recovery_operations.outcome IS
  'claimed|committed|not_committed|commit_outcome_unknown|conflict|evidence_unavailable. Store never infers not_committed from migration 064 cursor_operation_id mismatch.';

CREATE INDEX idx_tenant_email_delta_recovery_ops_endpoint_outcome_time
  ON tenant_email_delta_recovery_operations (client_id, endpoint_id, outcome, created_at DESC);

CREATE TRIGGER tenant_email_delta_recovery_operations_updated_at
  BEFORE UPDATE ON tenant_email_delta_recovery_operations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
