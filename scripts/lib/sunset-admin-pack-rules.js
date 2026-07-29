'use strict';

/**
 * Sunset Admin surf pack CRUD — beaches, schedules, age, group size, tier prices.
 */

const {
  adminConfigTablesExist,
  adminConfigTableHasLocationColumn,
} = require('./tenant-business-config');
const { normalizeSunsetLocationId } = require('./sunset-school-locations');
const { validateEquipmentOptions, normalizeEquipmentOptions } = require('./sunset-course-equipment-options');
const { listRentalOfferings } = require('./tenant-rental-offerings');
const {
  CANONICAL_DAY_DURATION_KEYS,
  isCanonicalDayDurationKey,
  durationDaysFromTierKey,
  hoursForDayDurationKey,
  LEGACY_TIER_KEY_TO_CANONICAL,
} = require('./sunset-admin-duration-keys');

const PACK_BEACHES = new Set(['el_sardinero', 'liencres', 'somo']);
const PACK_AGE_BANDS = new Set(['all_ages', '6_and_up', '6_to_11', '12_and_up']);
const PACK_WEEKLY = new Set(['daily', 'mon_fri', 'sat_sun']);
const PACK_SCHEDULE_KEYS = new Set(['0930_1130', '1215_1415']);
// Accept any well-formed HHMM_HHMM time window (valid 24h times, end after
// start) instead of a fixed whitelist — the admin form lets staff enter
// custom pack times. The two legacy preset keys still validate.
function isValidPackScheduleKey(key) {
  const m = /^([01]\d|2[0-3])([0-5]\d)_([01]\d|2[0-3])([0-5]\d)$/.exec(String(key || '').trim());
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return end > start;
}
const PACK_GROUP_SIZES = new Set([8, 12, 16, 20, 24]); // legacy presets (no longer enforced)
// Admin "Price for" save accepts only 1–7 day keys.
const PACK_TIER_KEYS = new Set(CANONICAL_DAY_DURATION_KEYS);
// Existing bookings / stored packs may still carry explicit legacy keys.
const PACK_TIER_KEYS_READABLE = new Set([
  ...CANONICAL_DAY_DURATION_KEYS,
  'single_class',
  '1_week',
  '2_weeks',
  '3_weeks',
  '4_weeks',
]);

// No fabricated commercial amounts — empty until Admin configures each day price.
const DEFAULT_PRICE_TIERS = [];

function defaultPackConfig() {
  return {
    equipment_options: [],
    age_band: '12_and_up',
    group_size: 16,
    beaches: ['el_sardinero', 'liencres', 'somo'],
    weekly: 'mon_fri',
    schedules: ['0930_1130', '1215_1415'],
    price_tiers: [],
  };
}

/** Label for a pack tier key without inventing money. */
function packTierLabel(key) {
  const k = String(key || '').trim();
  const days = durationDaysFromTierKey(k);
  if (days === 1) return '1 day';
  if (days != null && days > 1) return `${days} days`;
  return k;
}

function packPriceItemCode(packId, tierKey) {
  return `surf_pack_${packId}__${tierKey}`;
}

function mapPackRow(row) {
  const cfg = row.config_json && typeof row.config_json === 'object' ? row.config_json : {};
  const rawTiers = Array.isArray(cfg.price_tiers) ? cfg.price_tiers : [];
  // Preserve stored keys + amounts. Stamp duration_days via explicit mapping only.
  const price_tiers = rawTiers.map((t) => {
    if (!t || !t.key) return t;
    const key = String(t.key).trim();
    const amount = Number(t.amount_cents);
    return {
      key,
      label: String(t.label || packTierLabel(key)).trim() || packTierLabel(key),
      hours: Number.isFinite(Number(t.hours)) ? Number(t.hours) : hoursForDayDurationKey(key),
      amount_cents: Number.isInteger(amount) && amount >= 0 ? amount : 0,
      duration_days: durationDaysFromTierKey(key),
      canonical_key: LEGACY_TIER_KEY_TO_CANONICAL[key] || (isCanonicalDayDurationKey(key) ? key : null),
    };
  });
  return {
    pack_id: row.id ? String(row.id) : null,
    label: row.label || 'Surf pack',
    age_band: cfg.age_band || '12_and_up',
    group_size: cfg.group_size != null ? Number(cfg.group_size) : 16,
    beaches: Array.isArray(cfg.beaches) ? cfg.beaches : [],
    weekly: cfg.weekly || 'mon_fri',
    schedules: Array.isArray(cfg.schedules) ? cfg.schedules : [],
    equipment_options: normalizeEquipmentOptions(cfg.equipment_options),
    price_tiers,
    source: 'db',
  };
}

function validatePackBody(body, { requireLabel } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid body' };
  }
  const out = {};
  if (requireLabel || body.label != null) {
    const label = String(body.label || '').trim();
    if (!label) return { ok: false, error: 'label required' };
    out.label = label;
  }
  if (body.age_band != null) {
    const age = String(body.age_band).trim();
    if (!PACK_AGE_BANDS.has(age)) return { ok: false, error: 'invalid age_band' };
    out.age_band = age;
  }
  if (body.group_size != null) {
    const n = Number(body.group_size);
    if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, error: 'invalid group_size' };
    out.group_size = n;
  }
  if (body.equipment_included != null || body.equipment_price_cents != null) return { ok: false, error: 'obsolete equipment fields are not accepted' };
  if (body.equipment_options != null) {
    try { out.equipment_options = validateEquipmentOptions(body.equipment_options); }
    catch (err) { return { ok: false, error: err.message }; }
  }
  if (body.beaches != null) {
    if (!Array.isArray(body.beaches)) return { ok: false, error: 'beaches must be array' };
    const beaches = [];
    for (const b of body.beaches) {
      const key = String(b).trim();
      if (!PACK_BEACHES.has(key)) return { ok: false, error: 'invalid beach' };
      if (!beaches.includes(key)) beaches.push(key);
    }
    out.beaches = beaches;
  }
  if (body.weekly != null) {
    const w = String(body.weekly).trim();
    if (!PACK_WEEKLY.has(w)) return { ok: false, error: 'invalid weekly' };
    out.weekly = w;
  }
  if (body.schedules != null) {
    if (!Array.isArray(body.schedules)) return { ok: false, error: 'schedules must be array' };
    const schedules = [];
    for (const s of body.schedules) {
      const key = String(s).trim();
      if (!isValidPackScheduleKey(key)) return { ok: false, error: 'invalid schedule' };
      if (!schedules.includes(key)) schedules.push(key);
    }
    out.schedules = schedules;
  }
  if (body.price_tiers != null) {
    if (!Array.isArray(body.price_tiers)) {
      return { ok: false, error: 'price_tiers required' };
    }
    // Empty is allowed (fail-closed bookable until Admin sets 1–7 day prices).
    const tiers = [];
    const seen = new Set();
    for (const t of body.price_tiers) {
      const key = String(t.key || '').trim();
      if (!PACK_TIER_KEYS.has(key)) return { ok: false, error: 'invalid price tier key' };
      if (seen.has(key)) return { ok: false, error: 'duplicate price tier key' };
      seen.add(key);
      const label = String(t.label || packTierLabel(key)).trim();
      if (!label) return { ok: false, error: 'price tier label required' };
      const hoursRaw = t.hours != null ? Number(t.hours) : hoursForDayDurationKey(key);
      if (!Number.isFinite(hoursRaw) || hoursRaw < 0) return { ok: false, error: 'invalid tier hours' };
      const amount = Number(t.amount_cents);
      if (!Number.isInteger(amount) || amount < 0) return { ok: false, error: 'invalid tier amount_cents' };
      tiers.push({
        key,
        label,
        hours: hoursRaw,
        amount_cents: amount,
        duration_days: durationDaysFromTierKey(key),
      });
    }
    out.price_tiers = tiers;
  }
  return { ok: true, patch: out };
}

async function ensureSurfPackTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS tenant_surf_pack_rules (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id        TEXT NOT NULL DEFAULT 'sunset',
      client_slug      TEXT NOT NULL,
      location_id      TEXT,
      label            TEXT NOT NULL,
      config_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
      active           BOOLEAN NOT NULL DEFAULT true,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by       UUID
    )`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_surf_pack_client_active
      ON tenant_surf_pack_rules (client_slug, active)`);
}

async function surfPackTableExists(client) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'tenant_surf_pack_rules' LIMIT 1`,
  );
  return result.rows.length > 0;
}

async function loadSurfPacksFromDb(client, clientSlug, locationId) {
  await ensureSurfPackTable(client);
  const loc = normalizeSunsetLocationId(locationId);
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_surf_pack_rules');
  const params = hasLoc ? [clientSlug, loc] : [clientSlug];
  const where = hasLoc
    ? 'client_slug = $1 AND location_id = $2 AND active = true'
    : 'client_slug = $1 AND active = true';
  const result = await client.query(
    `SELECT id, label, config_json FROM tenant_surf_pack_rules WHERE ${where} ORDER BY label`,
    params,
  );
  return result.rows.map(mapPackRow);
}

async function upsertPackPriceTiers(client, {
  clientSlug, locationId, packId, packLabel, tiers, actor, skipTransaction,
}) {
  const { syncPackTierToPriceRules } = require('./sunset-admin-price-sync');
  return syncPackTierToPriceRules(client, {
    clientSlug,
    locationId,
    packId,
    packLabel,
    tiers,
    actor,
    skipTransaction: skipTransaction === true,
  });
}

async function createSurfPackRule(client, { clientSlug, locationId, body, actor }) {
  await ensureSurfPackTable(client);
  const validated = validatePackBody(body, { requireLabel: true });
  if (!validated.ok) return { ok: false, status: 400, body: { success: false, error: validated.error } };
  const cfg = { ...defaultPackConfig(), ...validated.patch };
  if (!cfg.price_tiers || !cfg.price_tiers.length) cfg.price_tiers = DEFAULT_PRICE_TIERS;
  const loc = normalizeSunsetLocationId(locationId);
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_surf_pack_rules');
  const label = validated.patch.label;
  await client.query('BEGIN');
  try {
    if (body.equipment_options != null) {
      const offerings = await listRentalOfferings(client, { clientSlug, locationId: loc, includeInactive: false });
      cfg.equipment_options = validateEquipmentOptions(body.equipment_options, { offerings, clientSlug, locationId: loc });
    }
    const inserted = await client.query(
      hasLoc
        ? `INSERT INTO tenant_surf_pack_rules (tenant_id, client_slug, location_id, label, config_json, active, updated_by)
           VALUES ('sunset', $1, $2, $3, $4::jsonb, true, $5::uuid) RETURNING *`
        : `INSERT INTO tenant_surf_pack_rules (tenant_id, client_slug, label, config_json, active, updated_by)
           VALUES ('sunset', $1, $2, $3::jsonb, true, $4::uuid) RETURNING *`,
      hasLoc
        ? [clientSlug, loc, label, JSON.stringify(cfg), actor.staff_user_id || null]
        : [clientSlug, label, JSON.stringify(cfg), actor.staff_user_id || null],
    );
    const row = inserted.rows[0];
    // Same transaction: pack + linked price rows. Never leave JSON-only prices.
    await upsertPackPriceTiers(client, {
      clientSlug,
      locationId: loc,
      packId: row.id,
      packLabel: label,
      tiers: cfg.price_tiers,
      actor,
      skipTransaction: true,
    });
    await client.query('COMMIT');
    return {
      ok: true,
      status: 201,
      body: {
        success: true,
        surf_pack: mapPackRow(row),
        cache_invalidate: ['admin_config', 'schedule_courses', 'luna_catalog'],
      },
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    if (err && /pack_price|price/i.test(String(err.message || ''))) {
      return {
        ok: false,
        status: 500,
        body: { success: false, error: 'pack_price_tiers_failed', message: err.message },
      };
    }
    throw err;
  }
}

async function patchSurfPackRule(client, { ruleId, clientSlug, locationId, body, actor }) {
  await ensureSurfPackTable(client);
  const validated = validatePackBody(body, { requireLabel: false });
  if (!validated.ok) return { ok: false, status: 400, body: { success: false, error: validated.error } };
  if (!Object.keys(validated.patch).length && body.label == null) {
    return { ok: false, status: 400, body: { success: false, error: 'empty body' } };
  }
  const loc = normalizeSunsetLocationId(locationId);
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_surf_pack_rules');
  await client.query('BEGIN');
  try {
    if (body.equipment_options != null) {
      const offerings = await listRentalOfferings(client, { clientSlug, locationId: loc, includeInactive: false });
      validated.patch.equipment_options = validateEquipmentOptions(body.equipment_options, { offerings, clientSlug, locationId: loc });
    }
    const existing = await client.query(
      hasLoc
        ? `SELECT * FROM tenant_surf_pack_rules WHERE id = $1::uuid AND client_slug = $2 AND location_id = $3 AND active = true FOR UPDATE`
        : `SELECT * FROM tenant_surf_pack_rules WHERE id = $1::uuid AND client_slug = $2 AND active = true FOR UPDATE`,
      hasLoc ? [ruleId, clientSlug, loc] : [ruleId, clientSlug],
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
    }
    const before = existing.rows[0];
    const prevCfg = before.config_json && typeof before.config_json === 'object' ? before.config_json : {};
    const nextCfg = { ...prevCfg, ...validated.patch };
    // Saving exact 1–7 day tiers must not silently drop/migrate stored legacy
    // keys (1_week, single_class, …) or invent replacements for them.
    if (Array.isArray(validated.patch.price_tiers)) {
      const prevTiers = Array.isArray(prevCfg.price_tiers) ? prevCfg.price_tiers : [];
      const legacyPreserved = prevTiers.filter((t) => {
        const key = String((t && t.key) || '').trim();
        return key && !PACK_TIER_KEYS.has(key);
      });
      const seen = new Set(validated.patch.price_tiers.map((t) => String((t && t.key) || '').trim()));
      const legacyNoDup = legacyPreserved.filter((t) => !seen.has(String((t && t.key) || '').trim()));
      nextCfg.price_tiers = validated.patch.price_tiers.concat(legacyNoDup);
    }
    const nextLabel = validated.patch.label || before.label;
    const updated = await client.query(
      `UPDATE tenant_surf_pack_rules
          SET label = $3, config_json = $4::jsonb, updated_at = NOW(), updated_by = $5::uuid
        WHERE id = $1::uuid AND client_slug = $2
        RETURNING *`,
      [ruleId, clientSlug, nextLabel, JSON.stringify(nextCfg), actor.staff_user_id || null],
    );
    const after = updated.rows[0];
    // Always re-sync linked price rows in the same transaction so label/tier
    // amount/identity stay aligned after any pack edit.
    await upsertPackPriceTiers(client, {
      clientSlug,
      locationId: loc,
      packId: after.id,
      packLabel: after.label,
      tiers: nextCfg.price_tiers || prevCfg.price_tiers || DEFAULT_PRICE_TIERS,
      actor,
      skipTransaction: true,
    });
    await client.query('COMMIT');
    const surf_pack = mapPackRow(after);
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        surf_pack,
        cache_invalidate: ['admin_config', 'schedule_courses', 'luna_catalog'],
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function deactivateSurfPackRule(client, { ruleId, clientSlug, locationId, actor }) {
  await ensureSurfPackTable(client);
  const loc = normalizeSunsetLocationId(locationId);
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_surf_pack_rules');
  await client.query('BEGIN');
  try {
    const updated = await client.query(
      hasLoc
        ? `UPDATE tenant_surf_pack_rules SET active = false, updated_at = NOW(), updated_by = $4::uuid
           WHERE id = $1::uuid AND client_slug = $2 AND location_id = $3 RETURNING *`
        : `UPDATE tenant_surf_pack_rules SET active = false, updated_at = NOW(), updated_by = $3::uuid
           WHERE id = $1::uuid AND client_slug = $2 RETURNING *`,
      hasLoc ? [ruleId, clientSlug, loc, actor.staff_user_id || null] : [ruleId, clientSlug, actor.staff_user_id || null],
    );
    if (!updated.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
    }
    // Deactivate linked package price rows so booking surfaces cannot resolve
    // orphan active prices for a removed course.
    const packId = String(updated.rows[0].id);
    const itemPrefix = `surf_pack_${packId}__`;
    try {
      const hasPriceLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
      if (hasPriceLoc) {
        await client.query(
          `UPDATE tenant_price_rules
              SET active = false, updated_at = NOW(), updated_by = $4::uuid
            WHERE client_slug = $1
              AND location_id = $2
              AND item_type = 'package'
              AND item_code LIKE $3
              AND active = true`,
          [clientSlug, loc, `${itemPrefix}%`, actor.staff_user_id || null],
        );
      } else {
        await client.query(
          `UPDATE tenant_price_rules
              SET active = false, updated_at = NOW(), updated_by = $3::uuid
            WHERE client_slug = $1
              AND item_type = 'package'
              AND item_code LIKE $2
              AND active = true`,
          [clientSlug, `${itemPrefix}%`, actor.staff_user_id || null],
        );
      }
    } catch (_) {
      // tenant_price_rules may be absent in older schemas; pack deactivate still commits.
    }
    await client.query('COMMIT');
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        surf_pack: mapPackRow(updated.rows[0]),
        cache_invalidate: ['admin_config', 'schedule_courses', 'luna_catalog'],
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  PACK_BEACHES,
  PACK_AGE_BANDS,
  PACK_WEEKLY,
  PACK_SCHEDULE_KEYS,
  PACK_GROUP_SIZES,
  PACK_TIER_KEYS,
  PACK_TIER_KEYS_READABLE,
  DEFAULT_PRICE_TIERS,
  defaultPackConfig,
  packPriceItemCode,
  packTierLabel,
  mapPackRow,
  validatePackBody,
  loadSurfPacksFromDb,
  createSurfPackRule,
  patchSurfPackRule,
  deactivateSurfPackRule,
  surfPackTableExists,
};
