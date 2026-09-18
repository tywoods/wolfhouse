'use strict';

const BEACH_KEY_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const ALLOWED_FIELDS = new Set(['beach_key', 'display_name']);

function validateBeachBody(body, { create = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid body' };
  for (const key of Object.keys(body)) if (!ALLOWED_FIELDS.has(key)) return { ok: false, error: `unsupported field: ${key}` };
  const patch = {};
  if (create) {
    const beachKey = String(body.beach_key || '').trim();
    if (!BEACH_KEY_RE.test(beachKey)) return { ok: false, error: 'invalid beach_key' };
    patch.beach_key = beachKey;
  } else if (body.beach_key != null) {
    return { ok: false, error: 'beach_key is immutable' };
  }
  if (create || body.display_name != null) {
    const displayName = String(body.display_name || '').trim();
    if (!displayName || displayName.length > 120) return { ok: false, error: 'invalid display_name' };
    patch.display_name = displayName;
  }
  if (!create && !Object.keys(patch).length) return { ok: false, error: 'empty body' };
  return { ok: true, patch };
}

async function listSurfBeaches(client, { clientSlug, locationId }) {
  const result = await client.query(
    `SELECT beach_key, display_name FROM tenant_surf_beaches
      WHERE client_slug = $1 AND location_id = $2 AND active = true
      ORDER BY display_name, beach_key`, [clientSlug, locationId]);
  return result.rows;
}

async function validateBeachKeys(client, { clientSlug, locationId, beachKeys }) {
  const keys = [...new Set((beachKeys || []).map((key) => String(key).trim()))];
  if (!keys.length) return { ok: true, missing: [] };
  const result = await client.query(
    `SELECT beach_key FROM tenant_surf_beaches
      WHERE client_slug = $1 AND location_id = $2 AND active = true
        AND beach_key = ANY($3::text[])`, [clientSlug, locationId, keys]);
  const found = new Set(result.rows.map((row) => row.beach_key));
  const missing = keys.filter((key) => !found.has(key));
  return { ok: missing.length === 0, missing };
}

async function createSurfBeach(client, { clientSlug, locationId, body, actor = {} }) {
  const validated = validateBeachBody(body, { create: true });
  if (!validated.ok) return { ok: false, status: 400, body: { success: false, error: validated.error } };
  try {
    const result = await client.query(
      `INSERT INTO tenant_surf_beaches
         (tenant_id, client_slug, location_id, beach_key, display_name, active, updated_by)
       VALUES ('sunset', $1, $2, $3, $4, true, $5::uuid)
       RETURNING beach_key, display_name`,
      [clientSlug, locationId, validated.patch.beach_key, validated.patch.display_name, actor.staff_user_id || null]);
    return { ok: true, status: 201, body: { success: true, beach: result.rows[0], cache_invalidate: ['admin_config', 'luna_catalog'] } };
  } catch (err) {
    if (err && err.code === '23505') return { ok: false, status: 409, body: { success: false, error: 'beach_key_exists' } };
    throw err;
  }
}

async function patchSurfBeach(client, { clientSlug, locationId, beachKey, body, actor = {} }) {
  const validated = validateBeachBody(body);
  if (!validated.ok) return { ok: false, status: 400, body: { success: false, error: validated.error } };
  const result = await client.query(
    `UPDATE tenant_surf_beaches SET display_name = $4, updated_at = NOW(), updated_by = $5::uuid
      WHERE client_slug = $1 AND location_id = $2 AND beach_key = $3 AND active = true
      RETURNING beach_key, display_name`,
    [clientSlug, locationId, beachKey, validated.patch.display_name, actor.staff_user_id || null]);
  if (!result.rows[0]) return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
  return { ok: true, status: 200, body: { success: true, beach: result.rows[0], cache_invalidate: ['admin_config', 'luna_catalog'] } };
}

async function deleteSurfBeach(client, { clientSlug, locationId, beachKey, actor = {} }) {
  const existing = await client.query(
    `SELECT beach_key, display_name, active FROM tenant_surf_beaches
      WHERE client_slug = $1 AND location_id = $2 AND beach_key = $3 AND active = true`,
    [clientSlug, locationId, beachKey]);
  if (!existing.rows[0]) return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
  const refs = await client.query(
    `SELECT p.id FROM tenant_surf_pack_rules p
      WHERE p.client_slug = $1 AND p.location_id = $2
        AND p.config_json->'beaches' ? $3
        AND (p.active = true OR EXISTS (
          SELECT 1 FROM tenant_price_rules pr
           WHERE pr.client_slug = p.client_slug AND pr.location_id = p.location_id
             AND pr.item_type = 'package' AND pr.item_code LIKE ('surf_pack_' || p.id::text || '__%')
             AND pr.active = true))
      LIMIT 1`, [clientSlug, locationId, beachKey]);
  if (refs.rows[0]) return { ok: false, status: 409, body: { success: false, error: 'beach_in_use' } };
  const result = await client.query(
    `UPDATE tenant_surf_beaches SET active = false, updated_at = NOW(), updated_by = $4::uuid
      WHERE client_slug = $1 AND location_id = $2 AND beach_key = $3 AND active = true
      RETURNING beach_key, display_name`, [clientSlug, locationId, beachKey, actor.staff_user_id || null]);
  return { ok: true, status: 200, body: { success: true, beach: result.rows[0], cache_invalidate: ['admin_config', 'luna_catalog'] } };
}

module.exports = { BEACH_KEY_RE, validateBeachBody, listSurfBeaches, validateBeachKeys, createSurfBeach, patchSurfBeach, deleteSurfBeach };
