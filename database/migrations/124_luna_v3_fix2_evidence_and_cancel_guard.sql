-- 124_luna_v3_fix2_evidence_and_cancel_guard.sql
-- Immutable offer evidence and a complete cancelled-booking collectible guard.
BEGIN;

CREATE TABLE IF NOT EXISTS luna_v3_runtime_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES luna_v3_sessions(id) ON DELETE CASCADE,
  principal_id text NOT NULL,
  direction text NOT NULL CHECK(direction IN ('inbound','assistant_outbound')),
  content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
  preceding_inbound_event_id uuid REFERENCES luna_v3_runtime_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((direction='inbound') = (preceding_inbound_event_id IS NULL)),
  UNIQUE(client_id,session_id,id)
);
CREATE INDEX IF NOT EXISTS luna_v3_runtime_events_session_chronology_idx
  ON luna_v3_runtime_events(client_id,session_id,created_at,id);

ALTER TABLE luna_v3_offer_turns
  ADD COLUMN IF NOT EXISTS assistant_event_id text,
  ADD COLUMN IF NOT EXISTS accepted_inbound_event_id text,
  ADD COLUMN IF NOT EXISTS authoritative_terms jsonb;
-- Migration 123 could persist presentation/acceptance without authenticated
-- event evidence.  Such rows cannot be upgraded truthfully: invalidate the
-- consent while preserving the offer/hold for a fresh presentation.
UPDATE luna_v3_offer_turns
SET presented_at=NULL,presented_turn_id=NULL,accepted_at=NULL,accepted_turn_id=NULL,
    assistant_event_id=NULL,accepted_inbound_event_id=NULL,authoritative_terms=NULL
WHERE (presented_at IS NOT NULL AND (assistant_event_id IS NULL OR authoritative_terms IS NULL))
   OR (accepted_at IS NOT NULL AND accepted_inbound_event_id IS NULL);
ALTER TABLE luna_v3_offer_turns DROP CONSTRAINT IF EXISTS luna_v3_offer_terms_complete;
ALTER TABLE luna_v3_offer_turns ADD CONSTRAINT luna_v3_offer_terms_complete CHECK (
  presented_at IS NULL OR (
    assistant_event_id IS NOT NULL AND authoritative_terms IS NOT NULL
    AND (authoritative_terms->>'depositCents')::bigint > 0
    AND authoritative_terms ?& ARRAY['totalCents','depositCents','remainingCents','currency','checkIn','checkOut','guests','selection']
  )
);
ALTER TABLE luna_v3_offer_turns DROP CONSTRAINT IF EXISTS luna_v3_offer_acceptance_event_distinct;
ALTER TABLE luna_v3_offer_turns ADD CONSTRAINT luna_v3_offer_acceptance_event_distinct CHECK (
  accepted_at IS NULL OR (accepted_inbound_event_id IS NOT NULL AND accepted_inbound_event_id IS DISTINCT FROM assistant_event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS luna_v3_offer_turns_assistant_event_uq
  ON luna_v3_offer_turns(client_id,assistant_event_id) WHERE assistant_event_id IS NOT NULL;

DO $guard$
DECLARE owner text;
BEGIN
  SELECT obj_description('reject_payment_for_cancelled_booking()'::regprocedure,'pg_proc') INTO owner;
  IF owner IS DISTINCT FROM '117_cancel_unpaid_payment_race_guard v1'
     AND owner IS DISTINCT FROM '124_luna_v3_fix2_evidence_and_cancel_guard v1' THEN
    RAISE EXCEPTION 'refusing to replace unowned/newer cancelled-payment guard: %', owner;
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION reject_payment_for_cancelled_booking()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE booking_state text;
BEGIN
  SELECT status::text INTO booking_state FROM bookings
   WHERE id=NEW.booking_id AND client_id=NEW.client_id FOR UPDATE;
  IF booking_state IS NULL THEN
    RAISE EXCEPTION 'payment_booking_not_found' USING ERRCODE='23503';
  END IF;
  IF booking_state='cancelled' AND (
      TG_OP='INSERT'
      OR LOWER(COALESCE(NEW.status::text,'')) NOT IN ('cancelled','canceled','expired','failed')
      OR NEW.amount_paid_cents IS NULL OR NEW.amount_paid_cents > 0
      OR NULLIF(to_jsonb(NEW)->>'checkout_url','') IS NOT NULL
      OR NULLIF(to_jsonb(NEW)->>'stripe_checkout_session_id','') IS NOT NULL
      OR NULLIF(NEW.metadata->>'stripe_checkout_session_id','') IS NOT NULL
      OR NULLIF(NEW.metadata->>'stripe_session_id','') IS NOT NULL
      OR NULLIF(NEW.metadata->>'checkout_url','') IS NOT NULL
      OR NULLIF(NEW.metadata->>'provider_idempotency_key','') IS NOT NULL
      OR NULLIF(NEW.metadata->>'idempotency_key','') IS NOT NULL
      OR NULLIF(NEW.metadata->>'checkout_preparation','') IS NOT NULL) THEN
    RAISE EXCEPTION 'collectible_payment_for_cancelled_booking' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
COMMENT ON FUNCTION reject_payment_for_cancelled_booking() IS '124_luna_v3_fix2_evidence_and_cancel_guard v1';
DROP TRIGGER IF EXISTS payments_reject_cancelled_booking_117 ON payments;
CREATE TRIGGER payments_reject_cancelled_booking_117
BEFORE INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION reject_payment_for_cancelled_booking();
COMMENT ON TRIGGER payments_reject_cancelled_booking_117 ON payments IS '124_luna_v3_fix2_evidence_and_cancel_guard v1';

CREATE OR REPLACE FUNCTION reject_cancellation_with_collectible_payment()
RETURNS trigger LANGUAGE plpgsql AS $booking_guard$
BEGIN
  IF NEW.status::text='cancelled' AND OLD.status::text IS DISTINCT FROM 'cancelled'
     AND EXISTS (SELECT 1 FROM payments p WHERE p.client_id=NEW.client_id AND p.booking_id=NEW.id AND (
       p.amount_paid_cents IS NULL OR p.amount_paid_cents > 0
       OR LOWER(COALESCE(p.status::text,'')) NOT IN ('cancelled','canceled','expired','failed')
       OR NULLIF(to_jsonb(p)->>'checkout_url','') IS NOT NULL
       OR NULLIF(to_jsonb(p)->>'stripe_checkout_session_id','') IS NOT NULL
       OR NULLIF(p.metadata->>'stripe_checkout_session_id','') IS NOT NULL
       OR NULLIF(p.metadata->>'stripe_session_id','') IS NOT NULL
       OR NULLIF(p.metadata->>'checkout_url','') IS NOT NULL
       OR NULLIF(p.metadata->>'provider_idempotency_key','') IS NOT NULL
       OR NULLIF(p.metadata->>'idempotency_key','') IS NOT NULL
       OR NULLIF(p.metadata->>'checkout_preparation','') IS NOT NULL)) THEN
    RAISE EXCEPTION 'cancelled_booking_has_collectible_payment' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $booking_guard$;
COMMENT ON FUNCTION reject_cancellation_with_collectible_payment() IS '124_luna_v3_fix2_evidence_and_cancel_guard v1';
DROP TRIGGER IF EXISTS bookings_reject_collectible_cancel_124 ON bookings;
CREATE TRIGGER bookings_reject_collectible_cancel_124 BEFORE UPDATE OF status ON bookings
FOR EACH ROW EXECUTE FUNCTION reject_cancellation_with_collectible_payment();

CREATE OR REPLACE FUNCTION reject_mixed_booking_checkout_scope()
RETURNS trigger LANGUAGE plpgsql AS $scope$
DECLARE opposite_exists boolean;
BEGIN
  IF LOWER(COALESCE(NEW.status::text,'')) NOT IN ('draft','checkout_created','open','pending') THEN RETURN NEW; END IF;
  IF COALESCE(NULLIF(to_jsonb(NEW)->>'stripe_checkout_session_id',''),NULLIF(to_jsonb(NEW)->>'checkout_url',''),
      NULLIF(NEW.metadata->>'stripe_checkout_session_id',''),NULLIF(NEW.metadata->>'stripe_session_id',''),
      NULLIF(NEW.metadata->>'checkout_url',''),NULLIF(NEW.metadata->>'provider_idempotency_key','')) IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.booking_id::text, 124));
  SELECT EXISTS(SELECT 1 FROM payments p WHERE p.booking_id=NEW.booking_id AND p.id IS DISTINCT FROM NEW.id
    AND ((NEW.booking_guest_id IS NULL AND p.booking_guest_id IS NOT NULL) OR (NEW.booking_guest_id IS NOT NULL AND p.booking_guest_id IS NULL))
    AND LOWER(COALESCE(p.status::text,'')) IN ('draft','checkout_created','open','pending')
    AND COALESCE(NULLIF(to_jsonb(p)->>'stripe_checkout_session_id',''),NULLIF(to_jsonb(p)->>'checkout_url',''),
      NULLIF(p.metadata->>'stripe_checkout_session_id',''),NULLIF(p.metadata->>'stripe_session_id',''),
      NULLIF(p.metadata->>'checkout_url',''),NULLIF(p.metadata->>'provider_idempotency_key','')) IS NOT NULL) INTO opposite_exists;
  IF opposite_exists THEN RAISE EXCEPTION 'mixed_booking_checkout_scope' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $scope$;
DROP TRIGGER IF EXISTS payments_reject_mixed_checkout_scope_124 ON payments;
CREATE TRIGGER payments_reject_mixed_checkout_scope_124 BEFORE INSERT OR UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION reject_mixed_booking_checkout_scope();

COMMIT;
