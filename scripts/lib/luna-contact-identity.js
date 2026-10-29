'use strict';

/**
 * Phone-scoped Luna contact identity. This is deliberately independent of a
 * booking: a WhatsApp contact may have a guest card before choosing dates.
 * Callers must supply only the gateway-authenticated phone.
 */

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return name && name.length <= 120 ? name : '';
}

function cleanPhone(value) {
  const phone = typeof value === 'string' ? value.trim() : '';
  return phone && phone.length <= 64 ? phone : '';
}

async function readContactIdentity(pg, { clientSlug, phone }) {
  const trustedPhone = cleanPhone(phone);
  if (!trustedPhone) return { found: false, full_name: null };
  const result = await pg.query(
    `SELECT c.full_name
       FROM customers c
       JOIN clients cl ON cl.id = c.client_id
      WHERE cl.slug = $1 AND c.phone = $2
      LIMIT 1`,
    [String(clientSlug || '').trim(), trustedPhone],
  );
  const fullName = cleanName(result.rows[0] && result.rows[0].full_name);
  return { found: !!fullName, full_name: fullName || null };
}

async function saveContactIdentity(pg, { clientSlug, phone, fullName }) {
  const trustedPhone = cleanPhone(phone);
  const name = cleanName(fullName);
  if (!trustedPhone || !name) return { saved: false, full_name: null };
  const result = await pg.query(
    `INSERT INTO customers (client_id, phone, full_name, first_seen, last_seen)
     SELECT id, $2, $3, NOW(), NOW() FROM clients WHERE slug = $1
     ON CONFLICT (client_id, phone) DO UPDATE SET
       full_name = EXCLUDED.full_name,
       last_seen = NOW(),
       updated_at = NOW()
     RETURNING full_name`,
    [String(clientSlug || '').trim(), trustedPhone, name],
  );
  const savedName = cleanName(result.rows[0] && result.rows[0].full_name);
  return { saved: !!savedName, full_name: savedName || null };
}

/**
 * Sole owner of contact-identity request validation and customer queries.
 * A missing `full_name` reads; a supplied non-empty name upserts.
 */
async function handleContactIdentity(pg, { clientSlug, phone, body }) {
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  // Dispatcher tenant-pin writes client_slug/location_id onto the JSON body.
  // Those are not guest input; only extra guest fields are invalid.
  const dispatcherKeys = new Set(['client_slug', 'client', 'location_id']);
  if (Object.keys(payload).some((key) => key !== 'full_name' && !dispatcherKeys.has(key))) {
    return { status: 400, body: { success: false, error: 'invalid_contact_identity_input' } };
  }
  if (!cleanPhone(phone)) {
    return { status: 400, body: { success: false, error: 'trusted_guest_phone_required' } };
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'full_name')) {
    const saved = await saveContactIdentity(pg, { clientSlug, phone, fullName: payload.full_name });
    if (!saved.saved) return { status: 400, body: { success: false, error: 'valid_full_name_required' } };
    return { status: 200, body: { success: true, ...saved } };
  }
  const found = await readContactIdentity(pg, { clientSlug, phone });
  return { status: 200, body: { success: true, ...found } };
}

module.exports = { cleanName, cleanPhone, readContactIdentity, saveContactIdentity, handleContactIdentity };
