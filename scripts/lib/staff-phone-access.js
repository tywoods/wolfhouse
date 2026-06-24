/**
 * Phase 25b — Generic staff/owner phone allowlist helpers (multi-client).
 *
 * No client-specific hard-coding. Rows in staff_phone_access drive behavior.
 *
 * @module staff-phone-access
 */

'use strict';

const VALID_ROLES = new Set(['operator', 'owner']);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Digits-only phone for matching (+, spaces, punctuation stripped).
 *
 * @param {string} phone
 * @returns {string}
 */
function normalizeStaffPhone(phone) {
  return trimStr(phone).replace(/\D/g, '');
}

/**
 * E.164 display form: +digits (empty when no digits).
 *
 * @param {string} phone
 * @returns {string}
 */
function formatStaffPhoneE164(phone) {
  const normalized = normalizeStaffPhone(phone);
  return normalized ? `+${normalized}` : '';
}

function mapStaffPhoneRow(row) {
  if (!row) return null;
  return {
    found: true,
    active: row.is_active === true,
    client_slug: row.client_slug,
    phone_e164: row.phone_e164,
    phone_normalized: row.phone_normalized,
    display_name: row.display_name,
    role: row.role,
    channel: row.channel,
    is_active: row.is_active,
  };
}

function notFoundShape(clientSlug, phoneNormalized, channel) {
  return {
    found: false,
    active: false,
    client_slug: clientSlug || null,
    phone_e164: phoneNormalized ? `+${phoneNormalized}` : null,
    phone_normalized: phoneNormalized || null,
    display_name: null,
    role: null,
    channel: channel || 'whatsapp',
    is_active: false,
  };
}

/**
 * Lookup allowlist row by client + inbound phone (any common format).
 *
 * @param {import('pg').Client} pg
 * @param {{ client_slug: string, phone: string, channel?: string }} opts
 * @returns {Promise<object>}
 */
async function lookupStaffPhoneAccess(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug);
  const channel = trimStr(opts.channel) || 'whatsapp';
  const phoneNormalized = normalizeStaffPhone(opts.phone);

  if (!clientSlug || !phoneNormalized) {
    return notFoundShape(clientSlug, phoneNormalized, channel);
  }

  const res = await pg.query(
    `SELECT client_slug, phone_e164, phone_normalized, display_name, role, channel, is_active
       FROM staff_phone_access
      WHERE client_slug = $1
        AND phone_normalized = $2
        AND channel = $3
      LIMIT 1`,
    [clientSlug, phoneNormalized, channel],
  );

  if (!res.rows[0]) {
    return notFoundShape(clientSlug, phoneNormalized, channel);
  }

  const mapped = mapStaffPhoneRow(res.rows[0]);
  return {
    ...mapped,
    active: mapped.is_active === true,
  };
}

/**
 * Insert or update allowlist row (unique on client_slug + phone_normalized + channel).
 *
 * @param {import('pg').Client} pg
 * @param {{
 *   client_slug: string,
 *   phone: string,
 *   display_name?: string,
 *   role: string,
 *   channel?: string,
 *   is_active?: boolean,
 *   notes?: string|null,
 * }} opts
 * @returns {Promise<object>}
 */
async function upsertStaffPhoneAccess(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug);
  const channel = trimStr(opts.channel) || 'whatsapp';
  const role = trimStr(opts.role).toLowerCase();
  const phoneNormalized = normalizeStaffPhone(opts.phone);
  const phoneE164 = formatStaffPhoneE164(opts.phone);
  const displayName = trimStr(opts.display_name) || null;
  const isActive = opts.is_active !== false;
  const notes = opts.notes != null ? trimStr(opts.notes) || null : null;

  if (!clientSlug || !phoneNormalized) {
    throw new Error('client_slug and phone are required');
  }
  if (!VALID_ROLES.has(role)) {
    throw new Error(`role must be operator or owner (got: ${role || '(empty)'})`);
  }

  const res = await pg.query(
    `INSERT INTO staff_phone_access (
       client_slug, phone_e164, phone_normalized, display_name, role, channel, is_active, notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (client_slug, phone_normalized, channel)
     DO UPDATE SET
       phone_e164 = EXCLUDED.phone_e164,
       display_name = EXCLUDED.display_name,
       role = EXCLUDED.role,
       is_active = EXCLUDED.is_active,
       notes = EXCLUDED.notes,
       updated_at = NOW()
     RETURNING client_slug, phone_e164, phone_normalized, display_name, role, channel, is_active`,
    [clientSlug, phoneE164, phoneNormalized, displayName, role, channel, isActive, notes],
  );

  const mapped = mapStaffPhoneRow(res.rows[0]);
  return {
    ...mapped,
    active: mapped.is_active === true,
  };
}

async function deactivateStaffPhoneAccess(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug);
  const channel = trimStr(opts.channel) || 'whatsapp';
  const phoneNormalized = normalizeStaffPhone(opts.phone);
  if (!clientSlug || !phoneNormalized) return { ok: false, deactivated: false };
  const res = await pg.query(
    `UPDATE staff_phone_access SET is_active = false, updated_at = NOW()
      WHERE client_slug = $1 AND phone_normalized = $2 AND channel = $3`,
    [clientSlug, phoneNormalized, channel],
  );
  return { ok: true, deactivated: res.rowCount > 0 };
}

module.exports = {
  VALID_ROLES,
  normalizeStaffPhone,
  formatStaffPhoneE164,
  lookupStaffPhoneAccess,
  upsertStaffPhoneAccess,
  deactivateStaffPhoneAccess,
};
