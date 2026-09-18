-- Explicit rollback for 102_tenant_surf_beach_registry.sql.
BEGIN;
LOCK TABLE tenant_surf_beaches IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_surf_beaches) THEN
    RAISE EXCEPTION '102 down refused: tenant_surf_beaches contains catalog rows';
  END IF;
END $$;
DROP TABLE tenant_surf_beaches;
COMMIT;
