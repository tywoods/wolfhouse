-- Stage 7.7k6 fixture cleanup — safe to run multiple times

DO $$
DECLARE
  v_client_id UUID;
  v_booking_id UUID;
  v_del_bb INT; v_del_we INT; v_del_bk INT;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1;
  IF v_client_id IS NULL THEN RAISE NOTICE 'Client not found — nothing to clean'; RETURN; END IF;

  SELECT id INTO v_booking_id FROM bookings
  WHERE client_id = v_client_id AND booking_code = 'WH-77K6-OVERRIDE-001' LIMIT 1;

  DELETE FROM booking_beds WHERE client_id = v_client_id AND booking_id = v_booking_id;
  GET DIAGNOSTICS v_del_bb = ROW_COUNT;

  DELETE FROM workflow_events
  WHERE client_id = v_client_id AND workflow_name = 'staff_reassign_bed' AND booking_id = v_booking_id;
  GET DIAGNOSTICS v_del_we = ROW_COUNT;

  DELETE FROM bookings WHERE client_id = v_client_id AND booking_code = 'WH-77K6-OVERRIDE-001';
  GET DIAGNOSTICS v_del_bk = ROW_COUNT;

  RAISE NOTICE 'Stage 7.7k6 cleanup: booking_beds=%, workflow_events=%, bookings=%',
    v_del_bb, v_del_we, v_del_bk;
END;
$$;
