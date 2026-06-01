-- Stage 7.7k3 fixture cleanup — bed reassignment preview proof
-- Removes all rows seeded by stage7.7k3-reassign-preview-seed.sql.
-- Safe to run multiple times (DELETE WHERE booking_code IN ...).

DO $$
DECLARE
  v_client_id  UUID;
  v_del_bb     INT;
  v_del_bk     INT;
BEGIN
  SELECT id INTO v_client_id
  FROM clients
  WHERE slug = 'wolfhouse-somo'
  LIMIT 1;

  IF v_client_id IS NULL THEN
    RAISE NOTICE 'Client wolfhouse-somo not found — nothing to clean up';
    RETURN;
  END IF;

  -- Remove booking_beds rows for fixture bookings
  DELETE FROM booking_beds
  WHERE client_id = v_client_id
    AND booking_id IN (
      SELECT id FROM bookings
      WHERE client_id  = v_client_id
        AND booking_code IN ('WH-77K3-PREVIEW-001', 'WH-77K3-BLOCKER-001')
    );
  GET DIAGNOSTICS v_del_bb = ROW_COUNT;

  -- Remove fixture bookings
  DELETE FROM bookings
  WHERE client_id  = v_client_id
    AND booking_code IN ('WH-77K3-PREVIEW-001', 'WH-77K3-BLOCKER-001');
  GET DIAGNOSTICS v_del_bk = ROW_COUNT;

  RAISE NOTICE 'Stage 7.7k3 fixture cleanup complete: booking_beds=%, bookings=%',
    v_del_bb, v_del_bk;
END;
$$;
