-- Phase 3e.5b · T1 — Wrong phone / wrong conversation isolation (UP)
-- Reversible fixture. Disposable IDs only (WH-3E5-*). No payments/payment_events writes.
-- phoneA -> WH-3E5-A (conversation A current_hold_booking_id = A)
-- phoneB -> WH-3E5-B (conversation B current_hold_booking_id = B)
-- Proves: conversation A can never resolve/mutate booking B (different phone + different hold pointer).
BEGIN;

INSERT INTO bookings (id, client_id, booking_code, guest_name, phone, status, payment_status,
                      assignment_status, availability_check_status, check_in, check_out, guest_count, booking_source)
SELECT 'b3e50000-0000-4000-8000-0000000000a1', c.id, 'WH-3E5-A', 'T1 Guest A', '+353000035301',
       'hold', 'not_requested', 'unassigned', 'unknown', DATE '2027-03-02', DATE '2027-03-09', 2, 'whatsapp'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO bookings (id, client_id, booking_code, guest_name, phone, status, payment_status,
                      assignment_status, availability_check_status, check_in, check_out, guest_count, booking_source)
SELECT 'b3e50000-0000-4000-8000-0000000000b1', c.id, 'WH-3E5-B', 'T1 Guest B', '+353000035302',
       'hold', 'not_requested', 'unassigned', 'unknown', DATE '2027-03-02', DATE '2027-03-09', 2, 'whatsapp'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO conversations (client_id, phone, current_hold_booking_id)
SELECT c.id, '+353000035301', 'b3e50000-0000-4000-8000-0000000000a1'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO conversations (client_id, phone, current_hold_booking_id)
SELECT c.id, '+353000035302', 'b3e50000-0000-4000-8000-0000000000b1'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

COMMIT;
