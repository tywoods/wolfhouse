-- Phase 3e.5b · T3 — Payment-link target vs decoy (UP)
-- Same phone has WH-3E5-T3A (intended target) and WH-3E5-T3B (decoy). Conversation -> target.
-- No payments / payment_events rows are created (3e.5b avoids protected-table writes).
-- Proves: payment-link planning/contract scopes to the intended booking only; Main writes no payment tables.
BEGIN;

INSERT INTO bookings (id, client_id, booking_code, guest_name, phone, status, payment_status,
                      assignment_status, availability_check_status, check_in, check_out, guest_count, booking_source)
SELECT 'b3e50000-0000-4000-8000-0000000000d1', c.id, 'WH-3E5-T3A', 'T3 Target', '+353000035304',
       'hold', 'waiting_payment', 'unassigned', 'unknown', DATE '2027-03-02', DATE '2027-03-09', 2, 'whatsapp'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO bookings (id, client_id, booking_code, guest_name, phone, status, payment_status,
                      assignment_status, availability_check_status, check_in, check_out, guest_count, booking_source)
SELECT 'b3e50000-0000-4000-8000-0000000000d2', c.id, 'WH-3E5-T3B', 'T3 Decoy', '+353000035304',
       'hold', 'not_requested', 'unassigned', 'unknown', DATE '2027-03-02', DATE '2027-03-09', 2, 'whatsapp'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO conversations (client_id, phone, current_hold_booking_id)
SELECT c.id, '+353000035304', 'b3e50000-0000-4000-8000-0000000000d1'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

COMMIT;
