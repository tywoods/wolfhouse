-- 126_luna_v3_runtime_event_capabilities.sql
-- Forward upgrade for installations where migration 125 was already applied.
BEGIN;
ALTER TABLE luna_v3_runtime_events
  ADD COLUMN IF NOT EXISTS capability_revision text,
  ADD COLUMN IF NOT EXISTS capability_snapshot jsonb;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'luna_v3_runtime_events'::regclass
      AND conname = 'luna_v3_runtime_event_capability_pair'
  ) THEN
    ALTER TABLE luna_v3_runtime_events
      ADD CONSTRAINT luna_v3_runtime_event_capability_pair
      CHECK ((capability_revision IS NULL) = (capability_snapshot IS NULL));
  END IF;
END $$;
COMMIT;