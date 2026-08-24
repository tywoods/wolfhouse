-- 089_tenant_email_luna_automation_issuance_material.sql
-- FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B1: append-only issuance reconstitution material.
-- One owner. NOT a second queue, journal, or policy. Send-inert. Empty on migrate.
--
-- Canonical key: one row per exact queue operation + policy issuance
-- (operation_id PK, unique issuance_id). Composite FK to the 086 audit authority
-- unique (085/086) and inbound recipient authority (082/086). Exact draft_digest
-- coupling with the 086 queue row.
--
-- Persists only the minimum deterministic reconstitution material:
-- classifier scalars, required_facts, grounded found-field snapshot, author plan
-- enums. Guest subject/body remain on tenant_email_inbound_events (082).
-- quoted_history is not stored (automation reconstitutes ''). Rendered subject/body,
-- policy_text, provider IDs/status/capability, model output, secrets, and arbitrary
-- caller fields are refused.
--
-- Confidential booking codes / payment amounts live only in this table. They must
-- never appear in logs, exceptions, queue, audit, or journal.
--
-- Retention / parent FK:
--   Material → audit ON DELETE RESTRICT / ON UPDATE CASCADE.
--   Material → inbound recipient unique ON DELETE RESTRICT / ON UPDATE CASCADE.
--   Queue INSERT requires matching material (BEFORE INSERT). Queue DELETE remains
--   refused by 086. Do not CASCADE material from queue or audit — that would destroy
--   reconstitution/audit truth. Down refuses while material rows exist.
--   Pre-089 queue rows without material fail this up (no silent claimable gap).
--
-- Mutation: SECURITY DEFINER persist_and_enqueue is the producer-only capability
-- (validates 082/085/086 bindings then inserts material and the queue row
-- atomically). issuance_material_load is the worker-only reconstitution capability
-- (mapped worker session_user authorized in the locking/selection predicate
-- before touching a row). Direct table DML denied. 089 does not GRANT and does
-- not CREATE ROLE. PUBLIC revoked. search_path pg_catalog, public. Function owner
-- is the queue table owner.
--
-- Principal kinds: 089 extends the 088 mapping constraint with exact `producer`.
-- Producer EXECUTE is persist_and_enqueue only. Worker loses persist_and_enqueue
-- EXECUTE and 088 enqueue EXECUTE, and gains issuance_material_load.
-- 089 REVOKEs enqueue from mapped worker principals so producer alone
-- persists+enqueues. Trigger-based inertness is not ACL separation.
-- persist_and_enqueue inserts the queue row directly (SECURITY DEFINER)
-- rather than calling 088 enqueue, because enqueue authorizes worker and
-- must not be rewritten. Down restores worker enqueue EXECUTE.
-- Independent material authenticity is the producer/worker principal split:
-- 085 is not extended (same SQL must not invent and attest a digest).

BEGIN;

ALTER TABLE public.tenant_email_luna_automation_principals
  DROP CONSTRAINT IF EXISTS tenant_email_luna_automation_principals_kind_chk;
ALTER TABLE public.tenant_email_luna_automation_principals
  ADD CONSTRAINT tenant_email_luna_automation_principals_kind_chk
    CHECK (principal_kind IN ('worker', 'operator', 'producer'));

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_principal_authorized(
  p_kind text,
  p_client_id uuid,
  p_location_id uuid,
  p_location_key text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT
    CASE
      WHEN p_kind IS NULL OR p_kind NOT IN ('worker', 'operator', 'producer')
        OR p_client_id IS NULL OR p_location_id IS NULL OR p_location_key IS NULL THEN FALSE
      WHEN session_user IS NOT DISTINCT FROM (
        SELECT r.rolname
          FROM pg_catalog.pg_roles r
          JOIN pg_catalog.pg_class c ON c.relowner = r.oid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'tenant_email_luna_automation_queue'
           AND c.relkind = 'r'
      ) THEN TRUE
      ELSE EXISTS (
        SELECT 1
          FROM public.tenant_email_luna_automation_principals p
         WHERE p.role_name = session_user
           AND p.principal_kind = p_kind
           AND p.client_id = p_client_id
           AND p.location_id = p_location_id
           AND p.location_key = p_location_key
      )
    END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_queue'
       AND c.relkind = 'r'
  ) AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_issuance_material'
       AND c.relkind = 'r'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.tenant_email_luna_automation_queue) THEN
      RAISE EXCEPTION '089_up_refused: luna automation queue rows exist without issuance material — refuse claimable queue without reconstitution material' USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.tenant_email_luna_automation_issuance_material (
  operation_id uuid PRIMARY KEY,
  issuance_id uuid NOT NULL,
  audit_operation_id uuid NOT NULL,
  client_id uuid NOT NULL,
  location_id uuid NOT NULL,
  location_key text NOT NULL,
  endpoint_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  inbound_event_id uuid NOT NULL,
  recipient_address text NOT NULL,
  draft_digest text NOT NULL,
  language text NOT NULL,
  identity text NOT NULL,
  intent text NOT NULL,
  intent_support text NOT NULL,
  requested_location_id uuid NOT NULL,
  explicit_human_request boolean NOT NULL,
  attachment_interpretation_required boolean NOT NULL,
  unsafe_transactional_request boolean NOT NULL,
  required_facts text[] NOT NULL,
  grounded_facts jsonb NOT NULL,
  template_id text NOT NULL,
  tone text NOT NULL,
  question_key text NOT NULL,
  acknowledgment_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT tenant_email_luna_automation_issuance_material_issuance_uq UNIQUE (issuance_id),
  CONSTRAINT tenant_email_luna_automation_issuance_material_bind_uq UNIQUE (
    operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
    endpoint_id, conversation_id, inbound_event_id, recipient_address, draft_digest
  ),
  CONSTRAINT tenant_email_luna_automation_issuance_material_audit_fk
    FOREIGN KEY (
      audit_operation_id, issuance_id, client_id, location_id, location_key,
      endpoint_id, conversation_id, inbound_event_id
    )
    REFERENCES public.tenant_email_luna_policy_audit (
      operation_id, issuance_id, client_id, location_id, location_key,
      endpoint_id, conversation_id, inbound_event_id
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_issuance_material_inbound_fk
    FOREIGN KEY (inbound_event_id, client_id, location_id, endpoint_id, recipient_address)
    REFERENCES public.tenant_email_inbound_events (id, client_id, location_id, endpoint_id, sender_address_normalized)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_issuance_material_location_fk
    FOREIGN KEY (client_id, location_id, location_key)
    REFERENCES public.tenant_locations (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_automation_issuance_material_location_key_shape
    CHECK (location_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(location_key) BETWEEN 1 AND 64),
  CONSTRAINT tenant_email_luna_automation_issuance_material_recipient_shape
    CHECK (
      recipient_address = lower(recipient_address)
      AND recipient_address ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
      AND char_length(recipient_address) BETWEEN 3 AND 320
    ),
  CONSTRAINT tenant_email_luna_automation_issuance_material_draft_digest_shape
    CHECK (draft_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_email_luna_automation_issuance_material_language_values
    CHECK (language IN ('en', 'es')),
  CONSTRAINT tenant_email_luna_automation_issuance_material_identity_values
    CHECK (identity = 'matched'),
  CONSTRAINT tenant_email_luna_automation_issuance_material_intent_values
    CHECK (intent IN (
      'catalog_question', 'availability_question', 'policy_question',
      'booking_status_question', 'payment_status_question'
    )),
  CONSTRAINT tenant_email_luna_automation_issuance_material_intent_support_values
    CHECK (intent_support = 'supported'),
  CONSTRAINT tenant_email_luna_automation_issuance_material_requested_location
    CHECK (requested_location_id = location_id),
  CONSTRAINT tenant_email_luna_automation_issuance_material_flags
    CHECK (
      explicit_human_request IS FALSE
      AND attachment_interpretation_required IS FALSE
      AND unsafe_transactional_request IS FALSE
    ),
  CONSTRAINT tenant_email_luna_automation_issuance_material_required_facts_bounds
    CHECK (
      required_facts IS NOT NULL
      AND array_position(required_facts, NULL) IS NULL
      AND cardinality(required_facts) BETWEEN 1 AND 5
      AND required_facts IN (
        ARRAY['catalog']::text[],
        ARRAY['availability']::text[],
        ARRAY['policy']::text[],
        ARRAY['booking']::text[],
        ARRAY['payment']::text[]
      )
    ),
  CONSTRAINT tenant_email_luna_automation_issuance_material_intent_facts
    CHECK (
      (intent = 'catalog_question' AND required_facts = ARRAY['catalog']::text[])
      OR (intent = 'availability_question' AND required_facts = ARRAY['availability']::text[])
      OR (intent = 'policy_question' AND required_facts = ARRAY['policy']::text[])
      OR (intent = 'booking_status_question' AND required_facts = ARRAY['booking']::text[])
      OR (intent = 'payment_status_question' AND required_facts = ARRAY['payment']::text[])
    ),
  CONSTRAINT tenant_email_luna_automation_issuance_material_template_values
    CHECK (template_id IN (
      'catalog_reply', 'availability_reply', 'policy_reply',
      'booking_status_reply', 'payment_status_reply'
    )),
  CONSTRAINT tenant_email_luna_automation_issuance_material_intent_template
    CHECK (
      (intent = 'catalog_question' AND template_id = 'catalog_reply')
      OR (intent = 'availability_question' AND template_id = 'availability_reply')
      OR (intent = 'policy_question' AND template_id = 'policy_reply')
      OR (intent = 'booking_status_question' AND template_id = 'booking_status_reply')
      OR (intent = 'payment_status_question' AND template_id = 'payment_status_reply')
    ),
  CONSTRAINT tenant_email_luna_automation_issuance_material_tone_values
    CHECK (tone IN ('warm', 'concise')),
  CONSTRAINT tenant_email_luna_automation_issuance_material_ack_values
    CHECK (acknowledgment_key IN ('thanks', 'noted')),
  CONSTRAINT tenant_email_luna_automation_issuance_material_question_values
    CHECK (
      (template_id = 'catalog_reply' AND question_key IN ('none', 'ask_dates'))
      OR (template_id = 'availability_reply' AND question_key IN ('none', 'ask_guest_count'))
      OR (template_id IN ('policy_reply', 'booking_status_reply', 'payment_status_reply') AND question_key = 'none')
    ),
  CONSTRAINT tenant_email_luna_automation_issuance_material_facts_shape
    CHECK (
      pg_catalog.jsonb_typeof(grounded_facts) = 'object'
      AND pg_catalog.octet_length(grounded_facts::pg_catalog.text) BETWEEN 2 AND 4096
      AND NOT (grounded_facts ? 'policy_text')
      AND NOT (grounded_facts ? 'quoted_history')
      AND NOT (grounded_facts ? 'subject')
      AND NOT (grounded_facts ? 'body')
      AND NOT (grounded_facts ? 'body_text')
    )
);

COMMENT ON TABLE public.tenant_email_luna_automation_issuance_material IS
  'Ch4B1 Luna issuance reconstitution material. One append-only row per queue operation/issuance. Classifier, grounded found-fields, and author plan only. No policy prose, quoted history, rendered draft, or guest body duplicate. Confidential booking/payment values live only here. Parent FKs RESTRICT so audit/inbound/queue identity cannot destroy reconstitution truth.';
COMMENT ON COLUMN public.tenant_email_luna_automation_issuance_material.grounded_facts IS
  'Canonical found-field snapshot for required_facts only. No policy_text. Booking codes and payment amounts must not be copied to logs or errors.';
COMMENT ON COLUMN public.tenant_email_luna_automation_issuance_material.inbound_event_id IS
  'Canonical inbound 082 reference. Guest subject/body_text stay on tenant_email_inbound_events; this table does not duplicate them.';
COMMENT ON COLUMN public.tenant_email_luna_automation_issuance_material.draft_digest IS
  'Exact SHA-256 of canonical author subject/body/language. Must equal the 086 queue draft_digest.';

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_issuance_material_facts_ok(
  p_facts jsonb,
  p_required text[],
  p_client uuid,
  p_location uuid
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO pg_catalog, public
AS $$
DECLARE
  fact text;
  obj jsonb;
  keys text[];
BEGIN
  IF p_facts IS NULL OR pg_catalog.jsonb_typeof(p_facts) IS DISTINCT FROM 'object' THEN
    RETURN FALSE;
  END IF;
  IF p_required IS NULL OR cardinality(p_required) IS DISTINCT FROM 1 THEN
    RETURN FALSE;
  END IF;
  IF (SELECT COUNT(*) FROM pg_catalog.jsonb_object_keys(p_facts)) IS DISTINCT FROM 1 THEN
    RETURN FALSE;
  END IF;
  fact := p_required[1];
  IF NOT (p_facts ? fact) THEN
    RETURN FALSE;
  END IF;
  obj := p_facts -> fact;
  IF pg_catalog.jsonb_typeof(obj) IS DISTINCT FROM 'object' THEN
    RETURN FALSE;
  END IF;
  IF (obj ->> 'fact') IS DISTINCT FROM fact
     OR (obj ->> 'status') IS DISTINCT FROM 'found'
     OR (obj ->> 'client_id') IS DISTINCT FROM p_client::text
     OR (obj ->> 'location_id') IS DISTINCT FROM p_location::text THEN
    RETURN FALSE;
  END IF;
  IF obj ? 'policy_text' OR obj ? 'quoted_history' OR obj ? 'subject' OR obj ? 'body' OR obj ? 'body_text' THEN
    RETURN FALSE;
  END IF;
  SELECT pg_catalog.array_agg(k ORDER BY k) INTO keys
    FROM pg_catalog.jsonb_object_keys(obj) AS k;
  IF fact = 'catalog' THEN
    IF keys IS DISTINCT FROM ARRAY['active','amount_cents','client_id','currency','fact','item','label','location_id','status']::text[] THEN
      RETURN FALSE;
    END IF;
    IF pg_catalog.jsonb_typeof(obj -> 'active') IS DISTINCT FROM 'boolean'
       OR pg_catalog.jsonb_typeof(obj -> 'amount_cents') IS DISTINCT FROM 'number'
       OR (obj ->> 'currency') IS DISTINCT FROM 'EUR'
       OR (obj ->> 'item') NOT IN ('board_rental', 'group_lesson')
       OR char_length(obj ->> 'label') NOT BETWEEN 1 AND 128
       OR (obj ->> 'amount_cents')::bigint < 0
       OR (obj ->> 'amount_cents')::bigint > 10000000 THEN
      RETURN FALSE;
    END IF;
  ELSIF fact = 'availability' THEN
    IF keys IS DISTINCT FROM ARRAY['available','capacity','client_id','date','fact','item','label','location_id','slot_time','status']::text[] THEN
      RETURN FALSE;
    END IF;
    IF pg_catalog.jsonb_typeof(obj -> 'available') IS DISTINCT FROM 'boolean'
       OR pg_catalog.jsonb_typeof(obj -> 'capacity') IS DISTINCT FROM 'number'
       OR (obj ->> 'item') NOT IN ('board_rental', 'group_lesson')
       OR char_length(obj ->> 'label') NOT BETWEEN 1 AND 128
       OR (obj ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$'
       OR (obj ->> 'slot_time') !~ '^(?:[01]\d|2[0-3]):[0-5]\d$'
       OR (obj ->> 'capacity')::bigint < 0
       OR (obj ->> 'capacity')::bigint > 10000 THEN
      RETURN FALSE;
    END IF;
  ELSIF fact = 'policy' THEN
    IF keys IS DISTINCT FROM ARRAY['client_id','fact','label','location_id','policy_key','status']::text[] THEN
      RETURN FALSE;
    END IF;
    IF char_length(obj ->> 'label') NOT BETWEEN 1 AND 128
       OR (obj ->> 'policy_key') IS DISTINCT FROM 'cancellation_48h' THEN
      RETURN FALSE;
    END IF;
  ELSIF fact = 'booking' THEN
    IF NOT (
      keys = ARRAY['booking_code','booking_status','client_id','fact','location_id','status']::text[]
      OR keys = ARRAY['booking_code','booking_status','client_id','fact','label','location_id','status']::text[]
    ) THEN
      RETURN FALSE;
    END IF;
    IF (obj ->> 'booking_code') !~ '^[A-Z0-9-]{1,32}$'
       OR (obj ->> 'booking_status') NOT IN ('confirmed', 'pending', 'cancelled')
       OR (obj ? 'label' AND char_length(obj ->> 'label') NOT BETWEEN 1 AND 128) THEN
      RETURN FALSE;
    END IF;
  ELSIF fact = 'payment' THEN
    IF NOT (
      keys = ARRAY['amount_paid_cents','balance_due_cents','client_id','currency','fact','location_id','payment_status','status']::text[]
      OR keys = ARRAY['amount_paid_cents','balance_due_cents','client_id','currency','fact','label','location_id','payment_status','status']::text[]
    ) THEN
      RETURN FALSE;
    END IF;
    IF (obj ->> 'currency') IS DISTINCT FROM 'EUR'
       OR (obj ->> 'payment_status') NOT IN ('unpaid', 'partially_paid', 'paid')
       OR pg_catalog.jsonb_typeof(obj -> 'amount_paid_cents') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(obj -> 'balance_due_cents') IS DISTINCT FROM 'number'
       OR (obj ->> 'amount_paid_cents')::bigint < 0
       OR (obj ->> 'amount_paid_cents')::bigint > 10000000
       OR (obj ->> 'balance_due_cents')::bigint < 0
       OR (obj ->> 'balance_due_cents')::bigint > 10000000
       OR (obj ? 'label' AND char_length(obj ->> 'label') NOT BETWEEN 1 AND 128) THEN
      RETURN FALSE;
    END IF;
  ELSE
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$$;

ALTER TABLE public.tenant_email_luna_automation_issuance_material
  ADD CONSTRAINT tenant_email_luna_automation_issuance_material_facts_ok
  CHECK (
    public.tenant_email_luna_automation_issuance_material_facts_ok(
      grounded_facts, required_facts, client_id, location_id
    )
  );

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_issuance_material_protect()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'tenant_email_luna_automation_issuance_material: append-only mutation refused' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS tenant_email_luna_automation_issuance_material_protect_update
  ON public.tenant_email_luna_automation_issuance_material;
CREATE TRIGGER tenant_email_luna_automation_issuance_material_protect_update
  BEFORE UPDATE ON public.tenant_email_luna_automation_issuance_material
  FOR EACH ROW EXECUTE FUNCTION public.tenant_email_luna_automation_issuance_material_protect();
DROP TRIGGER IF EXISTS tenant_email_luna_automation_issuance_material_protect_delete
  ON public.tenant_email_luna_automation_issuance_material;
CREATE TRIGGER tenant_email_luna_automation_issuance_material_protect_delete
  BEFORE DELETE ON public.tenant_email_luna_automation_issuance_material
  FOR EACH ROW EXECUTE FUNCTION public.tenant_email_luna_automation_issuance_material_protect();

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_queue_require_issuance_material()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.tenant_email_luna_automation_issuance_material m
     WHERE m.operation_id = NEW.operation_id
       AND m.issuance_id = NEW.issuance_id
       AND m.audit_operation_id = NEW.audit_operation_id
       AND m.client_id = NEW.client_id
       AND m.location_id = NEW.location_id
       AND m.location_key = NEW.location_key
       AND m.endpoint_id = NEW.endpoint_id
       AND m.conversation_id = NEW.conversation_id
       AND m.inbound_event_id = NEW.inbound_event_id
       AND m.recipient_address = NEW.recipient_address
       AND m.draft_digest = NEW.draft_digest
  ) THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_queue: issuance material missing' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_email_luna_automation_queue_require_issuance_material
  ON public.tenant_email_luna_automation_queue;
CREATE TRIGGER tenant_email_luna_automation_queue_require_issuance_material
  BEFORE INSERT ON public.tenant_email_luna_automation_queue
  FOR EACH ROW EXECUTE FUNCTION public.tenant_email_luna_automation_queue_require_issuance_material();

DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_persist_and_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, jsonb);
CREATE FUNCTION public.tenant_email_luna_automation_persist_and_enqueue(
  p_operation_id uuid,
  p_issuance_id uuid,
  p_audit_operation_id uuid,
  p_client_id uuid,
  p_location_id uuid,
  p_location_key text,
  p_endpoint_id uuid,
  p_conversation_id uuid,
  p_inbound_event_id uuid,
  p_recipient_address text,
  p_policy_version text,
  p_eligibility_policy_version text,
  p_validator_version text,
  p_draft_digest text,
  p_material jsonb
) RETURNS TABLE (
  persist_status text,
  operation_id uuid,
  issuance_id uuid,
  audit_operation_id uuid,
  client_id uuid,
  location_id uuid,
  location_key text,
  endpoint_id uuid,
  conversation_id uuid,
  inbound_event_id uuid,
  recipient_address text,
  draft_digest text,
  state text,
  attempt_count integer,
  lease_owner uuid,
  handoff_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  q public.tenant_email_luna_automation_queue;
  q_by_op public.tenant_email_luna_automation_queue;
  q_by_iss public.tenant_email_luna_automation_queue;
  m public.tenant_email_luna_automation_issuance_material;
  m_by_op public.tenant_email_luna_automation_issuance_material;
  m_by_iss public.tenant_email_luna_automation_issuance_material;
  inbound_ok boolean;
  payload_keys text[];
  required text[];
  audit_found uuid;
BEGIN
  IF p_operation_id IS NULL OR p_issuance_id IS NULL OR p_audit_operation_id IS NULL
     OR p_client_id IS NULL OR p_location_id IS NULL OR p_location_key IS NULL
     OR p_endpoint_id IS NULL OR p_conversation_id IS NULL OR p_inbound_event_id IS NULL
     OR p_recipient_address IS NULL OR p_draft_digest IS NULL OR p_material IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.tenant_email_luna_automation_principal_authorized(
           'producer', p_client_id, p_location_id, p_location_key
         ) THEN
    RETURN;
  END IF;
  IF pg_catalog.jsonb_typeof(p_material) IS DISTINCT FROM 'object'
     OR pg_catalog.octet_length(p_material::pg_catalog.text) > 8192 THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: material shape refused' USING ERRCODE = '23514';
  END IF;
  SELECT pg_catalog.array_agg(k ORDER BY k) INTO payload_keys
    FROM pg_catalog.jsonb_object_keys(p_material) AS k;
  IF payload_keys IS DISTINCT FROM ARRAY[
       'acknowledgment_key','attachment_interpretation_required','explicit_human_request',
       'grounded_facts','identity','intent','intent_support','language','question_key',
       'requested_location_id','required_facts','template_id','tone','unsafe_transactional_request'
     ]::text[] THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: material shape refused' USING ERRCODE = '23514';
  END IF;

  SELECT true INTO inbound_ok
    FROM public.tenant_email_inbound_events e
   WHERE e.id = p_inbound_event_id
     AND e.client_id = p_client_id
     AND e.location_id = p_location_id
     AND e.endpoint_id = p_endpoint_id
     AND e.sender_address_normalized = p_recipient_address
     AND e.subject IS NOT NULL
     AND char_length(e.subject) BETWEEN 1 AND 998
     AND e.body_text IS NOT NULL
     AND char_length(e.body_text) BETWEEN 1 AND 64000
   FOR SHARE;
  IF inbound_ok IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: inbound reconstitution refused' USING ERRCODE = '23514';
  END IF;

  SELECT a.operation_id INTO audit_found
    FROM public.tenant_email_luna_policy_audit a
   WHERE a.operation_id = p_audit_operation_id
     AND a.issuance_id = p_issuance_id
     AND a.client_id = p_client_id
     AND a.location_id = p_location_id
     AND a.location_key = p_location_key
     AND a.endpoint_id = p_endpoint_id
     AND a.conversation_id = p_conversation_id
     AND a.inbound_event_id = p_inbound_event_id
   FOR SHARE;
  IF audit_found IS NULL THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: identity conflict' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO m_by_op
    FROM public.tenant_email_luna_automation_issuance_material AS mat
   WHERE mat.operation_id = p_operation_id
   FOR SHARE;
  SELECT * INTO m_by_iss
    FROM public.tenant_email_luna_automation_issuance_material AS mat
   WHERE mat.issuance_id = p_issuance_id
   FOR SHARE;
  IF m_by_op.operation_id IS NOT NULL AND m_by_iss.issuance_id IS NOT NULL
     AND m_by_op.operation_id IS DISTINCT FROM m_by_iss.operation_id THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: identity conflict' USING ERRCODE = '23514';
  END IF;
  IF m_by_op.operation_id IS NOT NULL THEN
    m := m_by_op;
  ELSIF m_by_iss.issuance_id IS NOT NULL THEN
    m := m_by_iss;
  END IF;

  SELECT * INTO q_by_op
    FROM public.tenant_email_luna_automation_queue AS qq
   WHERE qq.operation_id = p_operation_id
   FOR SHARE;
  SELECT * INTO q_by_iss
    FROM public.tenant_email_luna_automation_queue AS qq
   WHERE qq.issuance_id = p_issuance_id
   FOR SHARE;
  IF q_by_op.operation_id IS NOT NULL AND q_by_iss.issuance_id IS NOT NULL
     AND q_by_op.operation_id IS DISTINCT FROM q_by_iss.operation_id THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: identity conflict' USING ERRCODE = '23514';
  END IF;
  IF q_by_op.operation_id IS NOT NULL THEN
    q := q_by_op;
  ELSIF q_by_iss.issuance_id IS NOT NULL THEN
    q := q_by_iss;
  END IF;

  IF m.operation_id IS NOT NULL THEN
    IF m.operation_id IS DISTINCT FROM p_operation_id
       OR m.issuance_id IS DISTINCT FROM p_issuance_id
       OR m.audit_operation_id IS DISTINCT FROM p_audit_operation_id
       OR m.client_id IS DISTINCT FROM p_client_id
       OR m.location_id IS DISTINCT FROM p_location_id
       OR m.location_key IS DISTINCT FROM p_location_key
       OR m.endpoint_id IS DISTINCT FROM p_endpoint_id
       OR m.conversation_id IS DISTINCT FROM p_conversation_id
       OR m.inbound_event_id IS DISTINCT FROM p_inbound_event_id
       OR m.recipient_address IS DISTINCT FROM p_recipient_address
       OR m.draft_digest IS DISTINCT FROM p_draft_digest
       OR m.language IS DISTINCT FROM (p_material ->> 'language')
       OR m.identity IS DISTINCT FROM (p_material ->> 'identity')
       OR m.intent IS DISTINCT FROM (p_material ->> 'intent')
       OR m.intent_support IS DISTINCT FROM (p_material ->> 'intent_support')
       OR m.requested_location_id IS DISTINCT FROM ((p_material ->> 'requested_location_id')::uuid)
       OR m.explicit_human_request IS DISTINCT FROM ((p_material ->> 'explicit_human_request')::boolean)
       OR m.attachment_interpretation_required IS DISTINCT FROM ((p_material ->> 'attachment_interpretation_required')::boolean)
       OR m.unsafe_transactional_request IS DISTINCT FROM ((p_material ->> 'unsafe_transactional_request')::boolean)
       OR m.template_id IS DISTINCT FROM (p_material ->> 'template_id')
       OR m.tone IS DISTINCT FROM (p_material ->> 'tone')
       OR m.question_key IS DISTINCT FROM (p_material ->> 'question_key')
       OR m.acknowledgment_key IS DISTINCT FROM (p_material ->> 'acknowledgment_key')
       OR m.grounded_facts IS DISTINCT FROM (p_material -> 'grounded_facts') THEN
      RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: identity conflict' USING ERRCODE = '23514';
    END IF;
    IF q.operation_id IS NOT NULL THEN
      IF q.operation_id IS DISTINCT FROM p_operation_id
         OR q.issuance_id IS DISTINCT FROM p_issuance_id
         OR q.draft_digest IS DISTINCT FROM p_draft_digest THEN
        RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: identity conflict' USING ERRCODE = '23514';
      END IF;
      persist_status := 'replayed';
      operation_id := q.operation_id;
      issuance_id := q.issuance_id;
      audit_operation_id := q.audit_operation_id;
      client_id := q.client_id;
      location_id := q.location_id;
      location_key := q.location_key;
      endpoint_id := q.endpoint_id;
      conversation_id := q.conversation_id;
      inbound_event_id := q.inbound_event_id;
      recipient_address := q.recipient_address;
      draft_digest := q.draft_digest;
      state := q.state;
      attempt_count := q.attempt_count;
      lease_owner := q.lease_owner;
      handoff_id := q.handoff_id;
      RETURN NEXT;
      RETURN;
    END IF;
  ELSIF q.operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: identity conflict' USING ERRCODE = '23514';
  END IF;

  IF m.operation_id IS NULL THEN
    SELECT ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p_material -> 'required_facts')) INTO required;
    BEGIN
      INSERT INTO public.tenant_email_luna_automation_issuance_material (
        operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
        endpoint_id, conversation_id, inbound_event_id, recipient_address, draft_digest,
        language, identity, intent, intent_support, requested_location_id,
        explicit_human_request, attachment_interpretation_required, unsafe_transactional_request,
        required_facts, grounded_facts, template_id, tone, question_key, acknowledgment_key
      ) VALUES (
        p_operation_id, p_issuance_id, p_audit_operation_id, p_client_id, p_location_id, p_location_key,
        p_endpoint_id, p_conversation_id, p_inbound_event_id, p_recipient_address, p_draft_digest,
        p_material ->> 'language',
        p_material ->> 'identity',
        p_material ->> 'intent',
        p_material ->> 'intent_support',
        (p_material ->> 'requested_location_id')::uuid,
        (p_material ->> 'explicit_human_request')::boolean,
        (p_material ->> 'attachment_interpretation_required')::boolean,
        (p_material ->> 'unsafe_transactional_request')::boolean,
        required,
        p_material -> 'grounded_facts',
        p_material ->> 'template_id',
        p_material ->> 'tone',
        p_material ->> 'question_key',
        p_material ->> 'acknowledgment_key'
      );
    EXCEPTION
      WHEN unique_violation THEN
        SELECT * INTO m
          FROM public.tenant_email_luna_automation_issuance_material AS mat
         WHERE mat.operation_id = p_operation_id
           AND mat.issuance_id = p_issuance_id
           AND mat.draft_digest = p_draft_digest
         FOR SHARE;
        IF m.operation_id IS NULL THEN
          RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: identity conflict' USING ERRCODE = '23514';
        END IF;
    END;
  END IF;

  BEGIN
    INSERT INTO public.tenant_email_luna_automation_queue (
      operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
      endpoint_id, conversation_id, inbound_event_id, recipient_address, policy_version,
      eligibility_policy_version, validator_version, draft_digest
    ) VALUES (
      p_operation_id, p_issuance_id, p_audit_operation_id, p_client_id, p_location_id, p_location_key,
      p_endpoint_id, p_conversation_id, p_inbound_event_id, p_recipient_address, p_policy_version,
      p_eligibility_policy_version, p_validator_version, p_draft_digest
    )
    RETURNING * INTO q;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO q
        FROM public.tenant_email_luna_automation_queue AS qq
       WHERE qq.operation_id = p_operation_id
         AND qq.issuance_id = p_issuance_id
         AND qq.draft_digest = p_draft_digest
       FOR SHARE;
      IF q.operation_id IS NULL THEN
        RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: identity conflict' USING ERRCODE = '23514';
      END IF;
  END;
  IF q.operation_id IS NULL THEN
    RAISE EXCEPTION 'tenant_email_luna_automation_persist_and_enqueue: queue insert returned no row' USING ERRCODE = '23514';
  END IF;
  persist_status := CASE WHEN m.operation_id IS NULL THEN 'committed' ELSE 'replayed' END;
  operation_id := q.operation_id;
  issuance_id := q.issuance_id;
  audit_operation_id := q.audit_operation_id;
  client_id := q.client_id;
  location_id := q.location_id;
  location_key := q.location_key;
  endpoint_id := q.endpoint_id;
  conversation_id := q.conversation_id;
  inbound_event_id := q.inbound_event_id;
  recipient_address := q.recipient_address;
  draft_digest := q.draft_digest;
  state := q.state;
  attempt_count := q.attempt_count;
  lease_owner := q.lease_owner;
  handoff_id := q.handoff_id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_issuance_material_load(
  p_operation uuid,
  p_issuance uuid
) RETURNS TABLE (
  operation_id uuid,
  issuance_id uuid,
  audit_operation_id uuid,
  client_id uuid,
  location_id uuid,
  location_key text,
  endpoint_id uuid,
  conversation_id uuid,
  inbound_event_id uuid,
  recipient_address text,
  draft_digest text,
  language text,
  identity text,
  intent text,
  intent_support text,
  requested_location_id uuid,
  explicit_human_request boolean,
  attachment_interpretation_required boolean,
  unsafe_transactional_request boolean,
  required_facts text[],
  grounded_facts jsonb,
  template_id text,
  tone text,
  question_key text,
  acknowledgment_key text,
  queue_state text,
  envelope_subject text,
  envelope_body_text text,
  envelope_from_address text,
  envelope_from_display_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  m public.tenant_email_luna_automation_issuance_material;
  q public.tenant_email_luna_automation_queue;
  subj text;
  body text;
  from_addr text;
  from_name text;
BEGIN
  IF p_operation IS NULL OR p_issuance IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO m
    FROM public.tenant_email_luna_automation_issuance_material AS mat
   WHERE mat.operation_id = p_operation
     AND mat.issuance_id = p_issuance
     AND public.tenant_email_luna_automation_principal_authorized(
           'worker', mat.client_id, mat.location_id, mat.location_key
         )
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO q
    FROM public.tenant_email_luna_automation_queue AS qq
   WHERE qq.operation_id = p_operation
     AND qq.issuance_id = p_issuance
     AND public.tenant_email_luna_automation_principal_authorized(
           'worker', qq.client_id, qq.location_id, qq.location_key
         )
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF q.state IS DISTINCT FROM 'pending' AND q.state IS DISTINCT FROM 'claimed' THEN
    RETURN;
  END IF;
  IF q.draft_digest IS DISTINCT FROM m.draft_digest
     OR q.audit_operation_id IS DISTINCT FROM m.audit_operation_id
     OR q.client_id IS DISTINCT FROM m.client_id
     OR q.location_id IS DISTINCT FROM m.location_id
     OR q.location_key IS DISTINCT FROM m.location_key
     OR q.endpoint_id IS DISTINCT FROM m.endpoint_id
     OR q.conversation_id IS DISTINCT FROM m.conversation_id
     OR q.inbound_event_id IS DISTINCT FROM m.inbound_event_id
     OR q.recipient_address IS DISTINCT FROM m.recipient_address THEN
    RETURN;
  END IF;

  SELECT e.subject, e.body_text, e.sender_address_normalized, COALESCE(e.sender_display_name, '')
    INTO subj, body, from_addr, from_name
    FROM public.tenant_email_inbound_events AS e
   WHERE e.id = m.inbound_event_id
     AND e.client_id = m.client_id
     AND e.location_id = m.location_id
     AND e.endpoint_id = m.endpoint_id
     AND e.sender_address_normalized = m.recipient_address
     AND e.subject IS NOT NULL
     AND char_length(e.subject) BETWEEN 1 AND 998
     AND e.body_text IS NOT NULL
     AND char_length(e.body_text) BETWEEN 1 AND 64000;
  IF subj IS NULL OR body IS NULL OR from_addr IS NULL THEN
    RETURN;
  END IF;

  operation_id := m.operation_id;
  issuance_id := m.issuance_id;
  audit_operation_id := m.audit_operation_id;
  client_id := m.client_id;
  location_id := m.location_id;
  location_key := m.location_key;
  endpoint_id := m.endpoint_id;
  conversation_id := m.conversation_id;
  inbound_event_id := m.inbound_event_id;
  recipient_address := m.recipient_address;
  draft_digest := m.draft_digest;
  language := m.language;
  identity := m.identity;
  intent := m.intent;
  intent_support := m.intent_support;
  requested_location_id := m.requested_location_id;
  explicit_human_request := m.explicit_human_request;
  attachment_interpretation_required := m.attachment_interpretation_required;
  unsafe_transactional_request := m.unsafe_transactional_request;
  required_facts := m.required_facts;
  grounded_facts := m.grounded_facts;
  template_id := m.template_id;
  tone := m.tone;
  question_key := m.question_key;
  acknowledgment_key := m.acknowledgment_key;
  queue_state := q.state;
  envelope_subject := subj;
  envelope_body_text := body;
  envelope_from_address := from_addr;
  envelope_from_display_name := from_name;
  RETURN NEXT;
END;
$$;

DO $$
DECLARE
  table_owner name;
  fn_ident text;
  fns text[] := ARRAY[
    'tenant_email_luna_automation_issuance_material_facts_ok(jsonb, text[], uuid, uuid)',
    'tenant_email_luna_automation_issuance_material_protect()',
    'tenant_email_luna_automation_queue_require_issuance_material()',
    'tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text)',
    'tenant_email_luna_automation_persist_and_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, jsonb)',
    'tenant_email_luna_automation_issuance_material_load(uuid, uuid)'
  ];
BEGIN
  SELECT r.rolname INTO table_owner
    FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_class c ON c.relowner = r.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tenant_email_luna_automation_queue'
     AND c.relkind = 'r';
  IF table_owner IS NULL THEN
    RAISE EXCEPTION '089: queue table owner missing';
  END IF;
  EXECUTE format('ALTER TABLE public.tenant_email_luna_automation_issuance_material OWNER TO %I', table_owner);
  FOREACH fn_ident IN ARRAY fns LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO %I', fn_ident, table_owner);
  END LOOP;
END $$;

ALTER TABLE public.tenant_email_luna_automation_issuance_material ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_email_luna_automation_issuance_material_principal_select
  ON public.tenant_email_luna_automation_issuance_material;
CREATE POLICY tenant_email_luna_automation_issuance_material_principal_select
  ON public.tenant_email_luna_automation_issuance_material
  FOR SELECT
  USING (
    public.tenant_email_luna_automation_principal_authorized('worker', client_id, location_id, location_key)
  );

COMMENT ON FUNCTION public.tenant_email_luna_automation_persist_and_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, jsonb) IS
  'Producer persist+enqueue. Authorizes session_user as exact producer. Validates canonical 082/085/086 bindings, inserts one issuance-material row, then inserts the queue row directly (does not call 088 enqueue). Same-identity replay returns the existing queue row. Crossed operation/issuance identity raises. Queue insert returning no row raises so material cannot commit as an orphan. Does not rewrite 088 enqueue. Worker enqueue EXECUTE is revoked by 089. Does not invoke a provider. Confidential values must not be logged. Authenticity boundary is principal separation, not a same-call 085 digest.';
COMMENT ON FUNCTION public.tenant_email_luna_automation_issuance_material_load(uuid, uuid) IS
  'Scoped worker reconstitution load. Authorizes session_user against the mapped worker client/location in the locking/selection predicate before touching the row. Requires exact operation/issuance. Joins inbound 082 for envelope reconstitution. Returns no row for foreign location, missing inbound, or queue state other than pending/claimed. Producer has no EXECUTE. No raw table SELECT.';

REVOKE INSERT, UPDATE, DELETE ON TABLE public.tenant_email_luna_automation_issuance_material FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_email_luna_automation_issuance_material FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_issuance_material_facts_ok(jsonb, text[], uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_issuance_material_protect() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_queue_require_issuance_material() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_persist_and_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_issuance_material_load(uuid, uuid) FROM PUBLIC;

DO $$
DECLARE
  r record;
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text)'
     ) IS NULL THEN
    RAISE EXCEPTION '089: 088 enqueue function missing';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_principals'
       AND c.relkind = 'r'
  ) THEN
    FOR r IN
      SELECT p.role_name
        FROM public.tenant_email_luna_automation_principals p
       WHERE p.principal_kind = 'worker'
    LOOP
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text) FROM %I',
        r.role_name
      );
    END LOOP;
  END IF;
END $$;

COMMIT;
