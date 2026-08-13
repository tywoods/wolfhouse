-- Explicit down for 079. Refuse nonempty so queued recipient evidence cannot
-- disappear silently. Do not run against a live DB from this PR.

BEGIN;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'broadcast_recipients'
  ) AND EXISTS (SELECT 1 FROM broadcast_recipients) THEN
    RAISE EXCEPTION '079_down_refused: broadcast_recipients rows present — refuse silent recipient evidence loss';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'broadcasts'
  ) AND EXISTS (SELECT 1 FROM broadcasts) THEN
    RAISE EXCEPTION '079_down_refused: broadcasts rows present — refuse silent broadcast evidence loss';
  END IF;
END $$;
DROP TRIGGER IF EXISTS broadcasts_updated_at ON broadcasts;
DROP TABLE IF EXISTS broadcast_recipients;
DROP TABLE IF EXISTS broadcasts;
COMMIT;
