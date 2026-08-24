-- Explicit down for 096_tenant_email_luna_automation_public_execute.
-- Restores PostgreSQL default PUBLIC EXECUTE on public-schema functions and
-- the applying owner's default privileges GRANT EXECUTE ON FUNCTIONS TO PUBLIC.
-- Then re-seals Luna functions that 086-095 already revoked from PUBLIC so
-- rollback does not widen those explicit revokes.
-- Refuses if the 086 queue table is absent or if session_user is not the
-- queue table/function owner. Second execution is safe.

BEGIN;

DO $$
DECLARE
  table_owner name;
  fn_ident text;
  fns text[] := ARRAY[
    'tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text)',
    'tenant_email_luna_automation_claim(uuid, uuid)',
    'tenant_email_luna_automation_cancel_pending(uuid, uuid)',
    'tenant_email_luna_automation_cancel_claimed(uuid, uuid)',
    'tenant_email_luna_automation_require_handoff_pending(uuid, uuid)',
    'tenant_email_luna_automation_require_handoff_claimed(uuid, uuid)',
    'tenant_email_luna_automation_handoff(uuid, uuid)',
    'tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid)',
    'tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text)',
    'tenant_email_luna_automation_principals_protect()',
    'tenant_email_luna_automation_journal_handoff_lock(uuid, uuid)',
    'tenant_email_luna_automation_issuance_material_facts_ok(jsonb, text[], uuid, uuid)',
    'tenant_email_luna_automation_issuance_material_protect()',
    'tenant_email_luna_automation_queue_require_issuance_material()',
    'tenant_email_luna_automation_persist_and_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, jsonb)',
    'tenant_email_luna_automation_issuance_material_load(uuid, uuid)',
    'tenant_email_luna_automation_shadow_outcomes_protect()',
    'tenant_email_luna_automation_capture_shadow(uuid, uuid)',
    'tenant_email_luna_automation_shadow_outcome_load(uuid, uuid)',
    'tenant_email_luna_automation_shadow_outcome_project(uuid, uuid)',
    'tenant_email_luna_automation_claim_scoped(uuid, uuid, uuid, text, uuid)'
  ];
BEGIN
  IF to_regclass('public.tenant_email_luna_automation_queue') IS NULL THEN
    RAISE EXCEPTION '096_down_refused: 086 queue table missing' USING ERRCODE = '23514';
  END IF;

  SELECT r.rolname INTO table_owner
    FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_class c ON c.relowner = r.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_email_luna_automation_queue'
     AND c.relkind = 'r';
  IF table_owner IS NULL THEN
    RAISE EXCEPTION '096_down_refused: queue table owner missing' USING ERRCODE = '23514';
  END IF;
  IF session_user IS DISTINCT FROM table_owner
     OR current_user IS DISTINCT FROM table_owner THEN
    RAISE EXCEPTION '096_down_refused: must run as queue table/function owner' USING ERRCODE = '42501';
  END IF;

  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT EXECUTE ON FUNCTIONS TO PUBLIC',
    table_owner
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC',
    table_owner
  );
  EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC';

  FOREACH fn_ident IN ARRAY fns LOOP
    IF to_regprocedure('public.' || fn_ident) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn_ident);
    END IF;
  END LOOP;
END $$;

COMMIT;
