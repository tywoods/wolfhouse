/**
 * Sunset-only customer profile updates (staff portal).
 * Persists name/phone/email/notes — no outbound messaging.
 */
'use strict';

const SUNSET_CLIENT_SLUG = 'sunset';

function normalizePhone(raw) {
  const s = String(raw || '').trim();
  return s.slice(0, 40);
}

function normalizeText(raw, max) {
  return String(raw || '').trim().slice(0, max);
}

function parseCustomerUpdateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const display_name = normalizeText(b.display_name != null ? b.display_name : b.name, 120);
  const email = normalizeText(b.email, 160);
  const notes = normalizeText(b.notes, 4000);
  const phone = normalizePhone(b.phone);
  if (!display_name) return { ok: false, error: 'display_name is required' };
  if (!phone) return { ok: false, error: 'phone is required' };
  return { ok: true, value: { display_name, email: email || null, notes, phone } };
}

async function updateSunsetCustomerProfile(pg, clientSlug, oldPhone, body, opts = {}) {
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'sunset only' } };
  }
  const parsed = parseCustomerUpdateBody(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { success: false, error: parsed.error } };
  }
  const input = parsed.value;
  const phoneFrom = normalizePhone(oldPhone);
  if (!phoneFrom) {
    return { ok: false, status: 400, body: { success: false, error: 'invalid phone' } };
  }

  const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  if (!clientRes.rows.length) {
    return { ok: false, status: 500, body: { success: false, error: 'sunset client not found' } };
  }
  const clientId = clientRes.rows[0].id;

  await pg.query('BEGIN');
  try {
    const convRes = await pg.query(
      `UPDATE conversations SET
         display_name = $3,
         email = $4,
         internal_staff_notes = $5,
         phone = CASE WHEN $6 <> $2 THEN $6 ELSE phone END,
         updated_at = NOW()
       WHERE id = (
         SELECT conv.id FROM conversations conv
         WHERE conv.client_id = $1::uuid AND conv.phone = $2
         ORDER BY conv.updated_at DESC
         LIMIT 1
       )
       RETURNING id::text AS conversation_id, phone`,
      [clientId, phoneFrom, input.display_name, input.email, input.notes || null, input.phone],
    );

    await pg.query(
      `UPDATE bookings SET
         guest_name = $3,
         phone = $4
       WHERE client_id = $1::uuid AND phone = $2
         AND status NOT IN ('cancelled', 'expired')`,
      [clientId, phoneFrom, input.display_name, input.phone],
    );

    await pg.query(
      `UPDATE booking_service_records bsr SET guest_name = $2
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
       WHERE bsr.booking_id = b.id
         AND c.slug = $1
         AND b.phone = $3
         AND bsr.client_slug = $1`,
      [clientSlug, input.display_name, input.phone],
    );

    await pg.query('COMMIT');
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        phone: input.phone,
        previous_phone: phoneFrom,
        conversation_updated: convRes.rows.length > 0,
        display_name: input.display_name,
        email: input.email,
        notes: input.notes || null,
      },
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  parseCustomerUpdateBody,
  updateSunsetCustomerProfile,
};
