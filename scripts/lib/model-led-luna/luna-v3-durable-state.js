'use strict';

const FIELDS = Object.freeze(['booking_count','hold_count','payment_count','external_send_count','staff_alert_count']);

async function readLunaV3DurableState(pg, { clientId, sessionId, principalId, clientSlug }) {
  const result = await pg.query(`SELECT
      (SELECT count(*)::int FROM bookings b WHERE b.client_id=s.client_id
        AND (b.id=s.selected_booking_id OR (b.phone=s.guest_phone AND b.created_at>=s.created_at))) AS booking_count,
      (SELECT count(*)::int FROM luna_v3_holds h WHERE h.client_id=s.client_id AND h.session_id=s.id) AS hold_count,
      (SELECT count(DISTINCT durable_payment_id)::int FROM (
         SELECT p.id AS durable_payment_id FROM payments p JOIN bookings pb ON pb.id=p.booking_id AND pb.client_id=p.client_id
          WHERE p.client_id=s.client_id AND (p.booking_id=s.selected_booking_id OR (pb.phone=s.guest_phone AND pb.created_at>=s.created_at))
         UNION
         SELECT pl.payment_id AS durable_payment_id FROM luna_v3_payment_links pl WHERE pl.client_id=s.client_id AND pl.session_id=s.id
       ) durable_payments) AS payment_count,
      (SELECT count(*)::int FROM guest_message_sends g WHERE g.client_slug=$4 AND g.to_phone=s.guest_phone AND g.status='sent' AND g.created_at >= s.created_at) AS external_send_count,
      (SELECT count(*)::int FROM client_notification_events n JOIN conversations cv ON cv.id=n.conversation_id
        WHERE n.client_slug=$4 AND cv.client_id=s.client_id AND cv.phone=s.guest_phone AND n.status='sent' AND n.created_at >= s.created_at) AS staff_alert_count
    FROM luna_v3_sessions s WHERE s.client_id=$1 AND s.session_key=$2 AND s.principal_id=$3`,
  [clientId, sessionId, principalId, clientSlug]);
  const row = result.rows[0];
  if (!row || FIELDS.some(field => !Number.isInteger(row[field]) || row[field] < 0)) {
    const error = new Error('typed Staff state unavailable'); error.code = 'luna_v3_staff_state_unavailable'; throw error;
  }
  return { ok: true, ...row };
}

module.exports = { readLunaV3DurableState, FIELDS };
