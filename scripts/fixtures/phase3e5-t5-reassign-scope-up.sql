-- Phase 3e.5b · T5 — Reassign scope: only the resolved booking's beds move (UP)
-- WH-3E5-T5A holds beds R3-B1 + R3-B2; WH-3E5-T5B holds bed R5-B1 (the decoy).
-- Proves: reassign impact for T5A is scoped to exactly T5A's beds; T5B's R5-B1 is never in scope.
--
-- Ambiguity note: a two-rows-resolve-to-one-key fixture is intentionally NOT created here.
-- bookings has UNIQUE (client_id, booking_code) and UNIQUE (airtable_record_id), so two bookings
-- cannot share the same booking_code or airtable_record_id. The report's resolver therefore can
-- only ever match 0 or 1 booking by these keys; the resolved_count<>1 guard is defense-in-depth.
-- We demonstrate the 0-match branch with a non-existent code at run time.
BEGIN;

INSERT INTO bookings (id, client_id, booking_code, guest_name, phone, status, payment_status,
                      assignment_status, availability_check_status, check_in, check_out, guest_count, booking_source)
SELECT 'b3e50000-0000-4000-8000-0000000000e1', c.id, 'WH-3E5-T5A', 'T5 Guest A', '+353000035305',
       'confirmed', 'deposit_paid', 'assigned', 'available', DATE '2027-03-02', DATE '2027-03-09', 2, 'whatsapp'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO bookings (id, client_id, booking_code, guest_name, phone, status, payment_status,
                      assignment_status, availability_check_status, check_in, check_out, guest_count, booking_source)
SELECT 'b3e50000-0000-4000-8000-0000000000e2', c.id, 'WH-3E5-T5B', 'T5 Guest B', '+353000035306',
       'confirmed', 'deposit_paid', 'assigned', 'available', DATE '2027-03-02', DATE '2027-03-09', 1, 'whatsapp'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO booking_beds (client_id, booking_id, bed_id, assignment_start_date, assignment_end_date, room_code, bed_code, guest_name)
SELECT c.id, 'b3e50000-0000-4000-8000-0000000000e1', b.id, DATE '2027-03-02', DATE '2027-03-09', 'R3', 'R3-B1', 'T5 Guest A'
FROM clients c JOIN beds b ON b.client_id = c.id AND b.bed_code = 'R3-B1' WHERE c.slug = 'wolfhouse-somo';

INSERT INTO booking_beds (client_id, booking_id, bed_id, assignment_start_date, assignment_end_date, room_code, bed_code, guest_name)
SELECT c.id, 'b3e50000-0000-4000-8000-0000000000e1', b.id, DATE '2027-03-02', DATE '2027-03-09', 'R3', 'R3-B2', 'T5 Guest A'
FROM clients c JOIN beds b ON b.client_id = c.id AND b.bed_code = 'R3-B2' WHERE c.slug = 'wolfhouse-somo';

INSERT INTO booking_beds (client_id, booking_id, bed_id, assignment_start_date, assignment_end_date, room_code, bed_code, guest_name)
SELECT c.id, 'b3e50000-0000-4000-8000-0000000000e2', b.id, DATE '2027-03-02', DATE '2027-03-09', 'R5', 'R5-B1', 'T5 Guest B'
FROM clients c JOIN beds b ON b.client_id = c.id AND b.bed_code = 'R5-B1' WHERE c.slug = 'wolfhouse-somo';

COMMIT;
