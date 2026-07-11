'use strict';

const MAX_CUSTOMER_PROFILE_DELETE_COUNT = 100;

function normalizeDeletePhone(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits ? `+${digits}`.slice(0, 40) : '';
}

function parseCustomerDeleteBody(body) {
  if (!body || !Array.isArray(body.phones)) return { ok: false, error: 'phones must be an array' };
  const phones = [...new Set(body.phones.map(normalizeDeletePhone).filter(Boolean))];
  if (!phones.length) return { ok: false, error: 'at least one valid phone is required' };
  if (phones.length > MAX_CUSTOMER_PROFILE_DELETE_COUNT) return { ok: false, error: `maximum ${MAX_CUSTOMER_PROFILE_DELETE_COUNT} customers` };
  return { ok: true, phones };
}

async function deleteCustomerProfiles(pg, clientSlug, phones) {
  const parsed = parseCustomerDeleteBody({ phones });
  if (!parsed.ok) throw Object.assign(new Error(parsed.error), { status: 400 });
  await pg.query('BEGIN');
  try {
    // Delete only CRM profile rows. Historical/operational records are deliberately untouched.
    const result = await pg.query(
      `DELETE FROM customers cu
       USING clients c
       WHERE cu.client_id = c.id
         AND c.slug = $1
         AND cu.phone = ANY($2::text[])
       RETURNING cu.phone`,
      [String(clientSlug || '').trim(), parsed.phones],
    );
    await pg.query('COMMIT');
    return { deleted_count: result.rowCount, deleted_phones: result.rows.map(row => row.phone) };
  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  }
}

module.exports = { MAX_CUSTOMER_PROFILE_DELETE_COUNT, normalizeDeletePhone, parseCustomerDeleteBody, deleteCustomerProfiles };
