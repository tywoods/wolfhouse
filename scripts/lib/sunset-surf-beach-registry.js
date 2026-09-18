'use strict';

const { isSunsetLocationId, normalizeSunsetLocationId } = require('./sunset-school-locations');

const BEACH_KEY_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const ALLOWED_FIELDS = new Set(['beach_key', 'display_name']);
const SCHEMA_LOCK_KEY_1 = 20260918;
const SCHEMA_LOCK_KEY_2 = 102;
let schemaEnsurePromise = null;

async function ensureSurfBeachRegistry(client) {
  if (schemaEnsurePromise) return schemaEnsurePromise;
  schemaEnsurePromise = (async () => {
    await client.query('SELECT pg_advisory_lock($1, $2)', [SCHEMA_LOCK_KEY_1, SCHEMA_LOCK_KEY_2]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS tenant_surf_beaches (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    TEXT NOT NULL DEFAULT 'sunset',
        client_slug  TEXT NOT NULL,
        location_id  TEXT NOT NULL,
        beach_key    TEXT NOT NULL CHECK (beach_key ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
        display_name TEXT NOT NULL CHECK (btrim(display_name) <> ''),
        active       BOOLEAN NOT NULL DEFAULT true,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by   UUID REFERENCES staff_users(id) ON DELETE SET NULL
      )`);
      await client.query(`COMMENT ON TABLE tenant_surf_beaches IS
        'Stable tenant/property-scoped surf beach catalog identities. Prices and capacity intentionally live elsewhere.'`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_surf_beaches_scope_key
        ON tenant_surf_beaches (client_slug, location_id, beach_key) WHERE active = true`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_tenant_surf_beaches_scope
        ON tenant_surf_beaches (client_slug, location_id, active)`);
      await client.query('DROP TRIGGER IF EXISTS tenant_surf_beaches_updated_at ON tenant_surf_beaches');
      await client.query(`CREATE TRIGGER tenant_surf_beaches_updated_at
        BEFORE UPDATE ON tenant_surf_beaches FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
      await client.query(`DO $$
      BEGIN
        IF to_regclass('public.tenant_surf_pack_rules') IS NOT NULL THEN
          EXECUTE $sql$
            INSERT INTO tenant_surf_beaches (tenant_id, client_slug, location_id, beach_key, display_name)
            SELECT DISTINCT p.tenant_id, p.client_slug, COALESCE(NULLIF(btrim(p.location_id), ''), 'sunset-somo'), b.beach_key,
                   initcap(replace(b.beach_key, '_', ' '))
            FROM tenant_surf_pack_rules p
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(p.config_json->'beaches') = 'array'
                   THEN p.config_json->'beaches' ELSE '[]'::jsonb END
            ) AS b(beach_key)
            WHERE b.beach_key ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'
            ON CONFLICT DO NOTHING
          $sql$;
        END IF;
      END $$`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [SCHEMA_LOCK_KEY_1, SCHEMA_LOCK_KEY_2]);
    }
  })();
  try {
    await schemaEnsurePromise;
  } catch (err) {
    schemaEnsurePromise = null;
    throw err;
  }
}

function resolveRequiredSunsetLocation(query = {}) {
  if (!isSunsetLocationId(query.location)) return { ok: false, error: 'invalid_location' };
  return { ok: true, locationId: normalizeSunsetLocationId(query.location) };
}

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
  await ensureSurfBeachRegistry(client);
  const result = await client.query(
    `SELECT beach_key, display_name FROM tenant_surf_beaches
      WHERE client_slug = $1 AND location_id = $2 AND active = true
      ORDER BY display_name, beach_key`, [clientSlug, locationId]);
  return result.rows;
}

async function validateBeachKeys(client, { clientSlug, locationId, beachKeys }) {
  await ensureSurfBeachRegistry(client);
  const keys = [...new Set((beachKeys || []).map((key) => String(key).trim()))];
  if (!keys.length) return { ok: true, missing: [] };
  const result = await client.query(
    `SELECT beach_key FROM tenant_surf_beaches
      WHERE client_slug = $1 AND location_id = $2 AND active = true
        AND beach_key = ANY($3::text[])
      FOR SHARE`, [clientSlug, locationId, keys]);
  const found = new Set(result.rows.map((row) => row.beach_key));
  const missing = keys.filter((key) => !found.has(key));
  return { ok: missing.length === 0, missing };
}

async function createSurfBeach(client, { clientSlug, locationId, body, actor = {} }) {
  await ensureSurfBeachRegistry(client);
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
  await ensureSurfBeachRegistry(client);
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
  await ensureSurfBeachRegistry(client);
  await client.query('BEGIN');
  try {
    const existing = await client.query(
      `SELECT beach_key, display_name, active FROM tenant_surf_beaches
        WHERE client_slug = $1 AND location_id = $2 AND beach_key = $3 AND active = true
        FOR UPDATE`, [clientSlug, locationId, beachKey]);
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
    }
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
    if (refs.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, body: { success: false, error: 'beach_in_use' } };
    }
    const result = await client.query(
      `UPDATE tenant_surf_beaches SET active = false, updated_at = NOW(), updated_by = $4::uuid
        WHERE client_slug = $1 AND location_id = $2 AND beach_key = $3 AND active = true
        RETURNING beach_key, display_name`, [clientSlug, locationId, beachKey, actor.staff_user_id || null]);
    await client.query('COMMIT');
    return { ok: true, status: 200, body: { success: true, beach: result.rows[0], cache_invalidate: ['admin_config', 'luna_catalog'] } };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* preserve original error */ }
    throw err;
  }
}

module.exports = { BEACH_KEY_RE, resolveRequiredSunsetLocation, validateBeachBody, ensureSurfBeachRegistry, listSurfBeaches, validateBeachKeys, createSurfBeach, patchSurfBeach, deleteSurfBeach };
