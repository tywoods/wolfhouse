BEGIN;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS first_eligible_inbound_message_id UUID NULL,
  ADD COLUMN IF NOT EXISTS needs_human_transition_id UUID NULL;

COMMENT ON COLUMN conversations.first_eligible_inbound_message_id IS
  'First eligible persisted guest inbound message claimed by the ordinary mirror. Immutable once set; no backfill.';
COMMENT ON COLUMN conversations.needs_human_transition_id IS
  'Identity of the current false-to-true Needs Human transition. Replaced on each later false-to-true transition and cleared with needs_human.';

COMMIT;
