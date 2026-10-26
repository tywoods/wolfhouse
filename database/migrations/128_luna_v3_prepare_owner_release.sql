-- A prepare owner releases ownership only when its invocation is leaving. This
-- is independent of the pooled PostgreSQL backend, which may remain alive and
-- idle after the application has returned the connection to the pool.
ALTER TABLE luna_v3_prepare_attempts
  ADD COLUMN IF NOT EXISTS owner_released_at timestamptz;

CREATE INDEX IF NOT EXISTS luna_v3_prepare_attempts_released_open_idx
  ON luna_v3_prepare_attempts(owner_released_at)
  WHERE outcome = 'started' AND receipt IS NULL;
