-- Phase 3e.5b · T2 — Stale hold vs fresher current hold (UP)
-- Same phone has WH-3E5-OLD (older, hold_expires_at in the past = stale) and
-- WH-3E5-NEW (newer, hold_expires_at in the future = fresh). Conversation points at NEW.
-- Proves: stale hold is not the selected target when a fresher/current hold exists.
BEGIN;

INSERT INTO bookings (id, client_id, booking_code, guest_name, phone, status, payment_status,
                      assignment_status, availability_check_status, check_in, check_out, guest_count,
                      booking_source, hold_expires_at, created_at)
SELECT 'b3e50000-0000-4000-8000-0000000000c1', c.id, 'WH-3E5-OLD', 'T2 Guest (old)', '+353000035303',
       'hold', 'not_requested', 'unassigned', 'unknown', DATE '2027-03-02', DATE '2027-03-09', 2,
       'whatsapp', NOW() - INTERVAL '3 days', NOW() - INTERVAL '5 days'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO bookings (id, client_id, booking_code, guest_name, phone, status, payment_status,
                      assignment_status, availability_check_status, check_in, check_out, guest_count,
                      booking_source, hold_expires_at, created_at)
SELECT 'b3e50000-0000-4000-8000-0000000000c2', c.id, 'WH-3E5-NEW', 'T2 Guest (new)', '+353000035303',
       'hold', 'not_requested', 'unassigned', 'unknown', DATE '2027-03-02', DATE '2027-03-09', 2,
       'whatsapp', NOW() + INTERVAL '2 days', NOW()
FROM clients c WHERE c.slug = 'wolfhouse-somo';

INSERT INTO conversations (client_id, phone, current_hold_booking_id)
SELECT c.id, '+353000035303', 'b3e50000-0000-4000-8000-0000000000c2'
FROM clients c WHERE c.slug = 'wolfhouse-somo';

COMMIT;
