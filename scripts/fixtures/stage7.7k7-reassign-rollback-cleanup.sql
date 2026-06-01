-- Stage 7.7k7 fixture cleanup — safe to run multiple times
-- Cleans up: WH-77K7-UNDO-001, WH-77K7-CONFLICT-001, WH-77K7-BLOCKER-001
-- and all workflow_events audit rows for these bookings.

DO $$
DECLARE
  v_client_id UUID;
  v_bid_a UUID; v_bid_b UUID; v_bid_bl UUID;
  v_del_bb INT := 0; v_del_we INT := 0; v_del_bk INT := 0;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1;
  IF v_client_id IS NULL THEN RAISE NOTICE 'Client not found — nothing to clean'; RETURN; END IF;

  SELECT id INTO v_bid_a  FROM bookings WHERE client_id = v_client_id AND booking_code = 'WH-77K7-UNDO-001' LIMIT 1;
  SELECT id INTO v_bid_b  FROM bookings WHERE client_id = v_client_id AND booking_code = 'WH-77K7-CONFLICT-001' LIMIT 1;
  SELECT id INTO v_bid_bl FROM bookings WHERE client_id = v_client_id AND booking_code = 'WH-77K7-BLOCKER-001' LIMIT 1;

  -- booking_beds (blocker first so FK issues don't arise)
  DELETE FROM booking_beds WHERE client_id = v_client_id
    AND booking_id IN (v_bid_a, v_bid_b, v_bid_bl);
  GET DIAGNOSTICS v_del_bb = ROW_COUNT;

  -- workflow_events for these bookings
  DELETE FROM workflow_events
  WHERE client_id = v_client_id
    AND workflow_name = 'staff_reassign_bed'
    AND booking_id IN (v_bid_a, v_bid_b, v_bid_bl);
  GET DIAGNOSTICS v_del_we = ROW_COUNT;

  -- bookings
  DELETE FROM bookings WHERE client_id = v_client_id
    AND booking_code IN ('WH-77K7-UNDO-001', 'WH-77K7-CONFLICT-001', 'WH-77K7-BLOCKER-001');
  GET DIAGNOSTICS v_del_bk = ROW_COUNT;

  RAISE NOTICE 'Stage 7.7k7 cleanup: booking_beds=%, workflow_events=%, bookings=%',
    v_del_bb, v_del_we, v_del_bk;
END;
$$;
