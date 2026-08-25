-- 098_tenant_email_luna_controlled_drafting_staging_test_authorization.sql
-- FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4A: durable server-owned
-- Sunset staging test authorization. NOT a guest-row flag, NOT send
-- authority, NOT a second queue. Empty on migrate.
--
-- Binds one already-persisted 092 issuance / 063 inbound to the exact
-- Sunset staging mailbox/recipient. Env may name the opaque
-- authorization_id; it cannot confer authority. Real 092 guest rows
-- without a matching authorized row fail closed before reserve/tick.
--
-- Mutation: SECURITY DEFINER functions only. Direct table DML denied.
-- 098 does not GRANT and does not CREATE ROLE. PUBLIC revoked.
-- search_path pg_catalog, public. Function owner is the queue table owner.
--
-- Rollback: 098_tenant_email_luna_controlled_drafting_staging_test_authorization_down.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_issuance_material'
       AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION '098_up_refused: issuance material missing — refuse staging test authorization without 092' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_controlled_draft_operations'
       AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION '098_up_refused: controlled-draft operations missing — refuse staging test authorization without 097' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.tenant_email_luna_controlled_drafting_staging_test_authorizations (
  authorization_id uuid PRIMARY KEY,
  client_id uuid NOT NULL,
  location_id uuid NOT NULL,
  location_key text NOT NULL,
  endpoint_id uuid NOT NULL,
  mailbox_id text NOT NULL,
  provider text NOT NULL,
  inbound_event_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  issuance_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  recipient_address text NOT NULL,
  purpose text NOT NULL,
  created_by_role name NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  consumed_at timestamptz NULL,
  revoked_at timestamptz NULL,
  CONSTRAINT cd_staging_test_auth_purpose_chk
    CHECK (purpose = 'controlled_drafting_staging_proof'),
  CONSTRAINT cd_staging_test_auth_status_chk
    CHECK (status IN ('authorized', 'consumed', 'revoked')),
  CONSTRAINT cd_staging_test_auth_provider_chk
    CHECK (provider = 'microsoft_graph'),
  CONSTRAINT cd_staging_test_auth_location_chk
    CHECK (location_key = 'sunset-somo'),
  CONSTRAINT cd_staging_test_auth_status_times_chk
    CHECK (
      (status = 'authorized' AND consumed_at IS NULL AND revoked_at IS NULL)
      OR (status = 'consumed' AND consumed_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL AND consumed_at IS NULL)
    ),
  CONSTRAINT cd_staging_test_auth_recipient_chk
    CHECK (
      recipient_address = lower(recipient_address)
      AND recipient_address ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
      AND char_length(recipient_address) BETWEEN 3 AND 320
    ),
  CONSTRAINT cd_staging_test_auth_mailbox_chk
    CHECK (char_length(mailbox_id) BETWEEN 1 AND 2048),
  CONSTRAINT cd_staging_test_auth_operation_uq
    UNIQUE (operation_id),
  CONSTRAINT cd_staging_test_auth_issuance_uq
    UNIQUE (issuance_id),
  CONSTRAINT cd_staging_test_auth_material_fk
    FOREIGN KEY (operation_id)
    REFERENCES public.tenant_email_luna_automation_issuance_material (operation_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT cd_staging_test_auth_issuance_fk
    FOREIGN KEY (issuance_id)
    REFERENCES public.tenant_email_luna_automation_issuance_material (issuance_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT cd_staging_test_auth_inbound_fk
    FOREIGN KEY (inbound_event_id)
    REFERENCES public.tenant_email_inbound_events (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT cd_staging_test_auth_location_fk
    FOREIGN KEY (client_id, location_id, location_key)
    REFERENCES public.tenant_locations (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE OR REPLACE FUNCTION public.tenant_email_luna_controlled_drafting_staging_test_auth_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '098_delete_refused: staging test authorization rows are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
      OR NEW.client_id IS DISTINCT FROM OLD.client_id
      OR NEW.location_id IS DISTINCT FROM OLD.location_id
      OR NEW.location_key IS DISTINCT FROM OLD.location_key
      OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
      OR NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id
      OR NEW.provider IS DISTINCT FROM OLD.provider
      OR NEW.inbound_event_id IS DISTINCT FROM OLD.inbound_event_id
      OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
      OR NEW.issuance_id IS DISTINCT FROM OLD.issuance_id
      OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
      OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address
      OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.created_by_role IS DISTINCT FROM OLD.created_by_role
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION '098_binding_immutable: staging test authorization binding cannot change' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('consumed', 'revoked') AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION '098_terminal_status: consumed/revoked staging test authorization cannot change' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_email_luna_controlled_drafting_staging_test_auth_protect
  ON public.tenant_email_luna_controlled_drafting_staging_test_authorizations;
CREATE TRIGGER tenant_email_luna_controlled_drafting_staging_test_auth_protect
  BEFORE UPDATE OR DELETE ON public.tenant_email_luna_controlled_drafting_staging_test_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.tenant_email_luna_controlled_drafting_staging_test_auth_protect();

CREATE OR REPLACE FUNCTION public.tenant_email_luna_controlled_draft_staging_schema_ready()
RETURNS TABLE (
  current_database text,
  ledger_097_id text,
  ledger_097_checksum text,
  ledger_097_mode text,
  ledger_098_id text,
  ledger_098_checksum text,
  ledger_098_mode text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT
    pg_catalog.current_database()::text,
    l097.id::text,
    l097.checksum_sha256::text,
    l097.checksum_mode::text,
    l098.id::text,
    l098.checksum_sha256::text,
    l098.checksum_mode::text
  FROM (SELECT 1) AS one
  LEFT JOIN public.schema_migration_ledger l097
    ON l097.id = '097_tenant_email_luna_controlled_draft_operations'
  LEFT JOIN public.schema_migration_ledger l098
    ON l098.id = '098_tenant_email_luna_controlled_drafting_staging_test_authorization';
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_controlled_draft_staging_test_authorize(
  p_authorization_id uuid,
  p_operation_id uuid,
  p_issuance_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_owner name;
  v_material public.tenant_email_luna_automation_issuance_material%ROWTYPE;
  v_provider text;
  v_mailbox text;
BEGIN
  SELECT r.rolname
    INTO v_owner
    FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_class c ON c.relowner = r.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_email_luna_automation_queue'
     AND c.relkind = 'r';
  IF v_owner IS NULL OR session_user IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION '098_authorize_owner_required' USING ERRCODE = '42501';
  END IF;
  IF p_authorization_id IS NULL OR p_operation_id IS NULL OR p_issuance_id IS NULL THEN
    RAISE EXCEPTION '098_authorize_ids_required' USING ERRCODE = '23514';
  END IF;
  SELECT *
    INTO v_material
    FROM public.tenant_email_luna_automation_issuance_material
   WHERE operation_id = p_operation_id
     AND issuance_id = p_issuance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '098_authorize_issuance_missing' USING ERRCODE = '23514';
  END IF;
  IF v_material.location_key IS DISTINCT FROM 'sunset-somo' THEN
    RAISE EXCEPTION '098_authorize_location_refused' USING ERRCODE = '23514';
  END IF;
  SELECT e.provider, e.provider_mailbox_id
    INTO v_provider, v_mailbox
    FROM public.tenant_email_inbound_events e
   WHERE e.id = v_material.inbound_event_id
     AND e.client_id = v_material.client_id
     AND e.location_id = v_material.location_id
     AND e.endpoint_id = v_material.endpoint_id
     AND e.sender_address_normalized = v_material.recipient_address;
  IF NOT FOUND OR v_provider IS DISTINCT FROM 'microsoft_graph' OR v_mailbox IS NULL THEN
    RAISE EXCEPTION '098_authorize_inbound_missing' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.tenant_email_luna_controlled_drafting_staging_test_authorizations (
    authorization_id, client_id, location_id, location_key, endpoint_id,
    mailbox_id, provider, inbound_event_id, conversation_id, issuance_id,
    operation_id, recipient_address, purpose, created_by_role, status
  ) VALUES (
    p_authorization_id,
    v_material.client_id,
    v_material.location_id,
    v_material.location_key,
    v_material.endpoint_id,
    v_mailbox,
    v_provider,
    v_material.inbound_event_id,
    v_material.conversation_id,
    v_material.issuance_id,
    v_material.operation_id,
    v_material.recipient_address,
    'controlled_drafting_staging_proof',
    session_user,
    'authorized'
  );
  RETURN p_authorization_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_controlled_draft_staging_test_prove(
  p_authorization_id uuid,
  p_operation_id uuid,
  p_issuance_id uuid,
  p_recipient_address text
)
RETURNS TABLE (
  ok boolean,
  status text,
  operation_id uuid,
  issuance_id uuid,
  client_id uuid,
  location_id uuid,
  location_key text,
  endpoint_id uuid,
  mailbox_id text,
  provider text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_row public.tenant_email_luna_controlled_drafting_staging_test_authorizations%ROWTYPE;
  v_mapped boolean;
BEGIN
  IF p_authorization_id IS NULL OR p_operation_id IS NULL OR p_issuance_id IS NULL
     OR p_recipient_address IS NULL THEN
    RETURN;
  END IF;
  SELECT *
    INTO v_row
    FROM public.tenant_email_luna_controlled_drafting_staging_test_authorizations
   WHERE authorization_id = p_authorization_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_row.operation_id IS DISTINCT FROM p_operation_id
     OR v_row.issuance_id IS DISTINCT FROM p_issuance_id
     OR v_row.recipient_address IS DISTINCT FROM lower(p_recipient_address)
     OR v_row.purpose IS DISTINCT FROM 'controlled_drafting_staging_proof'
     OR v_row.location_key IS DISTINCT FROM 'sunset-somo'
     OR v_row.provider IS DISTINCT FROM 'microsoft_graph' THEN
    RETURN;
  END IF;
  v_mapped := public.tenant_email_luna_automation_principal_authorized(
    'producer', v_row.client_id, v_row.location_id, v_row.location_key
  ) OR public.tenant_email_luna_automation_principal_authorized(
    'worker', v_row.client_id, v_row.location_id, v_row.location_key
  );
  IF v_mapped IS NOT TRUE THEN
    RETURN;
  END IF;
  ok := (v_row.status = 'authorized');
  status := v_row.status;
  operation_id := v_row.operation_id;
  issuance_id := v_row.issuance_id;
  client_id := v_row.client_id;
  location_id := v_row.location_id;
  location_key := v_row.location_key;
  endpoint_id := v_row.endpoint_id;
  mailbox_id := v_row.mailbox_id;
  provider := v_row.provider;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_controlled_draft_staging_test_consume(
  p_authorization_id uuid,
  p_operation_id uuid,
  p_issuance_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_row public.tenant_email_luna_controlled_drafting_staging_test_authorizations%ROWTYPE;
  v_mapped boolean;
  v_updated integer;
BEGIN
  SELECT *
    INTO v_row
    FROM public.tenant_email_luna_controlled_drafting_staging_test_authorizations
   WHERE authorization_id = p_authorization_id
     AND operation_id = p_operation_id
     AND issuance_id = p_issuance_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  v_mapped := public.tenant_email_luna_automation_principal_authorized(
    'producer', v_row.client_id, v_row.location_id, v_row.location_key
  ) OR public.tenant_email_luna_automation_principal_authorized(
    'worker', v_row.client_id, v_row.location_id, v_row.location_key
  );
  IF v_mapped IS NOT TRUE THEN
    RAISE EXCEPTION '098_consume_unmapped' USING ERRCODE = '42501';
  END IF;
  IF v_row.status IS DISTINCT FROM 'authorized' THEN
    RETURN FALSE;
  END IF;
  UPDATE public.tenant_email_luna_controlled_drafting_staging_test_authorizations
     SET status = 'consumed',
         consumed_at = pg_catalog.now()
   WHERE authorization_id = p_authorization_id
     AND status = 'authorized';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_controlled_draft_staging_test_revoke(
  p_authorization_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_owner name;
  v_updated integer;
BEGIN
  SELECT r.rolname
    INTO v_owner
    FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_class c ON c.relowner = r.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_email_luna_automation_queue'
     AND c.relkind = 'r';
  IF v_owner IS NULL OR session_user IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION '098_revoke_owner_required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.tenant_email_luna_controlled_drafting_staging_test_authorizations
     SET status = 'revoked',
         revoked_at = pg_catalog.now()
   WHERE authorization_id = p_authorization_id
     AND status = 'authorized';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON TABLE public.tenant_email_luna_controlled_drafting_staging_test_authorizations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_drafting_staging_test_auth_protect() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_staging_schema_ready() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_staging_test_authorize(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_staging_test_prove(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_staging_test_consume(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_controlled_draft_staging_test_revoke(uuid) FROM PUBLIC;

COMMIT;
