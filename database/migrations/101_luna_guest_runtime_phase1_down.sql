-- Explicit rollback for 101_luna_guest_runtime_phase1.sql.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM luna_guest_reply_outbox)
     OR EXISTS (SELECT 1 FROM luna_guest_work_queue)
     OR EXISTS (SELECT 1 FROM luna_guest_inbound_events)
     OR EXISTS (SELECT 1 FROM luna_guest_conversations) THEN
    RAISE EXCEPTION '101 down refused: Luna Guest Runtime tables contain durable rows';
  END IF;
END $$;
DROP TABLE luna_guest_reply_outbox;
DROP TABLE luna_guest_work_queue;
DROP TABLE luna_guest_inbound_events;
DROP TABLE luna_guest_conversations;
COMMIT;
