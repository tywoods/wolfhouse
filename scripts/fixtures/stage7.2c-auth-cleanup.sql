-- Stage 7.2c — Auth middleware scaffold: cleanup fixture staff users
--
-- Removes the 3 test fixture users inserted by stage7.2c-auth-seed.sql.
-- Also removes any orphaned auth_sessions for these users (CASCADE handles
-- this automatically, but the explicit delete is here for clarity).
-- Safe to run multiple times (no-op if users already deleted).
--
-- NOT for production. NOT for staging. Local/dev only.

BEGIN;

-- Sessions cascade-deleted via ON DELETE CASCADE on auth_sessions.staff_user_id.
-- Explicit delete here for auditability.
DELETE FROM auth_sessions
WHERE staff_user_id IN (
  SELECT su.id
  FROM staff_users su
  JOIN clients c ON c.id = su.client_id
  WHERE c.slug = 'wolfhouse-somo'
    AND su.email IN (
      'viewer.stage72c@example.test',
      'operator.stage72c@example.test',
      'admin.stage72c@example.test'
    )
);

DELETE FROM staff_users
WHERE email IN (
  'viewer.stage72c@example.test',
  'operator.stage72c@example.test',
  'admin.stage72c@example.test'
);

COMMIT;
