-- 115_luna_v3_guest_operations.sql
-- Durable scoped notes, test-checkout receipts and transfer requests for Luna v3.
BEGIN;
CREATE TABLE luna_v3_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES luna_v3_sessions(id) ON DELETE CASCADE,
 booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL, text text NOT NULL CHECK(octet_length(text) BETWEEN 1 AND 8000),
 context jsonb NOT NULL DEFAULT '{}'::jsonb, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX luna_v3_notes_scope_idx ON luna_v3_notes(client_id,session_id,booking_id,created_at);
CREATE TABLE luna_v3_payment_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES luna_v3_sessions(id) ON DELETE CASCADE, booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
 payment_id uuid REFERENCES payments(id) ON DELETE RESTRICT, payment_choice text NOT NULL CHECK(payment_choice IN('deposit','full','balance')),
 amount_cents integer NOT NULL CHECK(amount_cents>0), currency text NOT NULL, provider_checkout_id text NOT NULL UNIQUE,
 provider_url text NOT NULL, provider_livemode boolean NOT NULL CHECK(provider_livemode=false), provider_readback jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE luna_v3_transfer_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES luna_v3_sessions(id) ON DELETE CASCADE, booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
 decision text NOT NULL CHECK(decision IN('requested','declined')), travel_details jsonb NOT NULL DEFAULT '{}'::jsonb,
 state text NOT NULL CHECK(state IN('pending','declined')), priced_cents integer, currency text,
 CHECK((priced_cents IS NULL AND currency IS NULL) OR (priced_cents>=0 AND currency IS NOT NULL)), created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
