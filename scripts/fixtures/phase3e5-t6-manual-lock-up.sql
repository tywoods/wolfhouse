-- Phase 3e.5b · T6 — Manual/staff & operator assignments are not silently overwritten (UP)
-- Convention for this gate (see plan §14): manual/staff protection = bookings.booking_source
-- IN ('manual_staff','operator') + existing overlap detection. No dedicated booking_beds lock
-- column exists; a dedicated is_manual_lock column would be a later schema change (not Stage 3 scope).
--
-- WH-3E5-MAN-OP (booking_source=operator) holds R7-B1.
-- WH-3E5-MAN-ST (booking_source=manual_staff) holds R7-B2.
-- WH-3E5-GUEST (whatsapp) is an auto-assign candidate that wants R7-B1 + R7-B2 in the same window.
-- Proves: assign impact reports both beds as overlap conflicts (blocked), never an overwrite.
BEGIN;

INSERT INTO bookings (id, client_id, booking_code, guest_name, phone, status, payment_status,
                      assignment_status, availability_check_status, check_in, check_out, guest_count, booking_source)
SELECT 'b3e50000-0000-4000-8000-0000000000f1', c.id, 'WH-3E5-MAN-OP', 'T6 Operator Block', '+353000035307',
       'confirmed', 'not_requested', 'assigned', 'available', DATE '2027-03-02', DATE '2027-03-09', 1, 'operator'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO bookings (id, client_id, booking_code, guest_name, phone, status, payment_status,
                      assignment_status, availability_check_status, check_in, check_out, guest_count, booking_source)
SELECT 'b3e50000-0000-4000-8000-0000000000f3', c.id, 'WH-3E5-MAN-ST', 'T6 Manual Staff', '+353000035308',
       'confirmed', 'not_requested', 'assigned', 'available', DATE '2027-03-02', DATE '2027-03-09', 1, 'manual_staff'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO bookings (id, client_id, booking_code, guest_name, phone, status, payment_status,
                      assignment_status, availability_check_status, check_in, check_out, guest_count, booking_source)
SELECT 'b3e50000-0000-4000-8000-0000000000f2', c.id, 'WH-3E5-GUEST', 'T6 Auto Candidate', '+353000035309',
       'hold', 'not_requested', 'unassigned', 'unknown', DATE '2027-03-02', DATE '2027-03-09', 2, 'whatsapp'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO booking_beds (client_id, booking_id, bed_id, assignment_start_date, assignment_end_date, room_code, bed_code, guest_name)
SELECT c.id, 'b3e50000-0000-4000-8000-0000000000f1', b.id, DATE '2027-03-02', DATE '2027-03-09', 'R7', 'R7-B1', 'T6 Operator Block'
FROM clients c JOIN beds b ON b.client_id = c.id AND b.bed_code = 'R7-B1' WHERE c.slug = 'wolfhouse-somo';

INSERT INTO booking_beds (client_id, booking_id, bed_id, assignment_start_date, assignment_end_date, room_code, bed_code, guest_name)
SELECT c.id, 'b3e50000-0000-4000-8000-0000000000f3', b.id, DATE '2027-03-02', DATE '2027-03-09', 'R7', 'R7-B2', 'T6 Manual Staff'
FROM clients c JOIN beds b ON b.client_id = c.id AND b.bed_code = 'R7-B2' WHERE c.slug = 'wolfhouse-somo';

COMMIT;
