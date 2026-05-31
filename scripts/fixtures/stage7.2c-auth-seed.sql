-- Stage 7.2c — Auth middleware scaffold: fixture staff users
--
-- Inserts 3 test-only staff users (viewer, operator, admin) for local proof.
-- Passwords are real scrypt hashes (N=16384, r=8, p=1) of test-only passwords:
--   viewer.stage72c@example.test   → ViewerPass123!
--   operator.stage72c@example.test → OperatorPass123!
--   admin.stage72c@example.test    → AdminPass123!
--
-- IMPORTANT: These are test fixture users with test-only passwords.
-- Client: wolfhouse-somo (resolved via subquery — no hardcoded UUIDs).
-- Cleanup: run stage7.2c-auth-cleanup.sql after the proof.
--
-- NOT for production. NOT for staging. Local/dev only.

BEGIN;

INSERT INTO staff_users (client_id, email, display_name, role, password_hash, status)
SELECT
  c.id,
  'viewer.stage72c@example.test',
  'Test Viewer 7.2c',
  'viewer',
  'scrypt$16384$8$1$b7fc24e79fad77daea511b1dd56c8c59$c8044223341b1d5542bd377ef14b9ac70ef777d0e8a694ef18c940ba11bd522c',
  'active'
FROM clients c WHERE c.slug = 'wolfhouse-somo'
ON CONFLICT (client_id, lower(email)) DO UPDATE
  SET password_hash  = EXCLUDED.password_hash,
      display_name   = EXCLUDED.display_name,
      role           = EXCLUDED.role,
      status         = 'active',
      updated_at     = NOW();

INSERT INTO staff_users (client_id, email, display_name, role, password_hash, status)
SELECT
  c.id,
  'operator.stage72c@example.test',
  'Test Operator 7.2c',
  'operator',
  'scrypt$16384$8$1$c39194914ecf8855915cd853c8d4f1d5$0e06c095b4ed432fea149399bc3e0d2ebe8745c1c633cc3e2bb2ba26e1500907',
  'active'
FROM clients c WHERE c.slug = 'wolfhouse-somo'
ON CONFLICT (client_id, lower(email)) DO UPDATE
  SET password_hash  = EXCLUDED.password_hash,
      display_name   = EXCLUDED.display_name,
      role           = EXCLUDED.role,
      status         = 'active',
      updated_at     = NOW();

INSERT INTO staff_users (client_id, email, display_name, role, password_hash, status)
SELECT
  c.id,
  'admin.stage72c@example.test',
  'Test Admin 7.2c',
  'admin',
  'scrypt$16384$8$1$b56dd8e590a528df5bab6f5074144136$52f815bb8863c7347baad07e8402704cf102445157491706d3aa4e7221c8c661',
  'active'
FROM clients c WHERE c.slug = 'wolfhouse-somo'
ON CONFLICT (client_id, lower(email)) DO UPDATE
  SET password_hash  = EXCLUDED.password_hash,
      display_name   = EXCLUDED.display_name,
      role           = EXCLUDED.role,
      status         = 'active',
      updated_at     = NOW();

COMMIT;
