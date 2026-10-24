-- 123_luna_v3_one_try_offers.sql
-- Public offer references and trusted presentation/consent evidence for Luna v3.
BEGIN;
ALTER TABLE luna_v3_holds ADD COLUMN IF NOT EXISTS offer_reference text;
CREATE UNIQUE INDEX IF NOT EXISTS luna_v3_holds_offer_reference_uq
  ON luna_v3_holds(client_id,offer_reference) WHERE offer_reference IS NOT NULL;
ALTER TABLE luna_v3_holds DROP CONSTRAINT IF EXISTS luna_v3_holds_offer_reference_bounded;
ALTER TABLE luna_v3_holds ADD CONSTRAINT luna_v3_holds_offer_reference_bounded
  CHECK (offer_reference IS NULL OR offer_reference ~ '^offer_[A-Za-z0-9_-]{24,80}$');

CREATE TABLE IF NOT EXISTS luna_v3_offer_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES luna_v3_sessions(id) ON DELETE CASCADE,
  hold_id uuid NOT NULL REFERENCES luna_v3_holds(id) ON DELETE CASCADE,
  offer_reference text NOT NULL,
  prepared_turn_id text NOT NULL,
  presented_turn_id text,
  accepted_turn_id text,
  presented_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_id,offer_reference),
  UNIQUE(session_id,prepared_turn_id),
  CHECK (length(prepared_turn_id) BETWEEN 8 AND 200),
  CHECK (presented_turn_id IS NULL OR length(presented_turn_id) BETWEEN 8 AND 200),
  CHECK (accepted_turn_id IS NULL OR length(accepted_turn_id) BETWEEN 8 AND 200)
);
COMMIT;
