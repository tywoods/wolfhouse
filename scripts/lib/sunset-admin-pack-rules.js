'use strict';

/**
 * Sunset Admin surf pack CRUD — beaches, schedules, age, group size, tier prices.
 */

const {
  adminConfigTablesExist,
  adminConfigTableHasLocationColumn,
} = require('./tenant-business-config');
const { normalizeSunsetLocationId } = require('./sunset-school-locations');

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
const PACK_GROUP_SIZES = new Set([8, 12, 16, 20, 24]);
const PACK_TIER_KEYS = new Set(['1_week', '2_weeks', '3_weeks', '4_weeks', 'single_class']);

const DEFAULT_PRICE_TIERS = [
  { key: '1_week', label: 'Price for 1 week (10 hours)', hours: 10, amount_cents: 18000 },
  { key: '2_weeks', label: 'Price for 2 weeks (20 hours)', hours: 20, amount_cents: 33500 },
  { key: '3_weeks', label: 'Price for 3 weeks (30 hours)', hours: 30, amount_cents: 48000 },
  { key: '4_weeks', label: 'Price for 4 weeks (40 hours)', hours: 40, amount_cents: 60000 },
  { key: 'single_class', label: 'Price for 1 single class (2 hours)', hours: 2, amount_cents: 4000 },
];

function defaultPackConfig() {
  return {
    age_band: '12_and_up',
    group_size: 16,
    beaches: ['el_sardinero', 'liencres', 'somo'],
    weekly: 'mon_fri',
    schedules: ['0930_1130', '1215_1415'],
    price_tiers: DEFAULT_PRICE_TIERS.map((t) => ({ ...t })),
  };
}

function packPriceItemCode(packId, tierKey) {
  return `surf_pack_${packId}__${tierKey}`;
}

function mapPackRow(row) {
  const cfg = row.config_json && typeof row.config_json === 'object' ? row.config_json : {};
  return {
    pack_id: row.id ? String(row.id) : null,
    label: row.label || 'Surf pack',
    age_band: cfg.age_band || '12_and_up',
    group_size: cfg.group_size != null ? Number(cfg.group_size) : 16,
    beaches: Array.isArray(cfg.beaches) ? cfg.beaches : [],
    weekly: cfg.weekly || 'mon_fri',
    schedules: Array.isArray(cfg.schedules) ? cfg.schedules : [],
    price_tiers: Array.isArray(cfg.price_tiers) ? cfg.price_tiers : DEFAULT_PRICE_TIERS,
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
    if (!PACK_GROUP_SIZES.has(n)) return { ok: false, error: 'invalid group_size' };
    out.group_size = n;
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
    if (!Array.isArray(body.price_tiers) || !body.price_tiers.length) {
      return { ok: false, error: 'price_tiers required' };
    }
    const tiers = [];
    for (const t of body.price_tiers) {
      const key = String(t.key || '').trim();
      if (!PACK_TIER_KEYS.has(key)) return { ok: false, error: 'invalid price tier key' };
      const label = String(t.label || '').trim();
      if (!label) return { ok: false, error: 'price tier label required' };
      const hours = Number(t.hours);
      if (!Number.isFinite(hours) || hours < 0) return { ok: false, error: 'invalid tier hours' };
      const amount = Number(t.amount_cents);
      if (!Number.isInteger(amount) || amount < 0) return { ok: false, error: 'invalid tier amount_cents' };
      tiers.push({ key, label, hours, amount_cents: amount });
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
  clientSlug, locationId, packId, packLabel, tiers, actor,
}) {
  const { upsertConfigPriceRule } = require('./tenant-admin-writes');
  const loc = normalizeSunsetLocationId(locationId);
  for (const tier of tiers || []) {
    const itemCode = packPriceItemCode(packId, tier.key);
    await upsertConfigPriceRule(client, {
      clientSlug,
      locationId: loc,
      category: 'package',
      offeringKey: itemCode,
      unit: tier.key === 'single_class' ? 'session' : 'week',
      patch: {
        display_name: `${packLabel} — ${tier.label}`,
        amount_cents: tier.amount_cents,
        currency: 'EUR',
      },
      actor,
      forceItemCode: itemCode,
      forceDbUnit: tier.key === 'single_class' ? 'session' : 'day',
    });
  }
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
    await client.query('COMMIT');
    try {
      await upsertPackPriceTiers(client, {
        clientSlug,
        locationId: loc,
        packId: row.id,
        packLabel: label,
        tiers: cfg.price_tiers,
        actor,
      });
    } catch (tierErr) {
      return {
        ok: false,
        status: 500,
        body: { success: false, error: 'pack_price_tiers_failed', message: tierErr.message },
      };
    }
    return { ok: true, status: 201, body: { success: true, surf_pack: mapPackRow(row) } };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already committed or idle */ }
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
    const nextLabel = validated.patch.label || before.label;
    const updated = await client.query(
      `UPDATE tenant_surf_pack_rules
          SET label = $3, config_json = $4::jsonb, updated_at = NOW(), updated_by = $5::uuid
        WHERE id = $1::uuid AND client_slug = $2
        RETURNING *`,
      [ruleId, clientSlug, nextLabel, JSON.stringify(nextCfg), actor.staff_user_id || null],
    );
    const after = updated.rows[0];
    await client.query('COMMIT');
    if (validated.patch.price_tiers || body.label != null) {
      await upsertPackPriceTiers(client, {
        clientSlug,
        locationId: loc,
        packId: after.id,
        packLabel: after.label,
        tiers: nextCfg.price_tiers || prevCfg.price_tiers || DEFAULT_PRICE_TIERS,
        actor,
      });
    }
    return { ok: true, status: 200, body: { success: true, surf_pack: mapPackRow(after) } };
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
    await client.query('COMMIT');
    return { ok: true, status: 200, body: { success: true, surf_pack: mapPackRow(updated.rows[0]) } };
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
  DEFAULT_PRICE_TIERS,
  defaultPackConfig,
  mapPackRow,
  validatePackBody,
  loadSurfPacksFromDb,
  createSurfPackRule,
  patchSurfPackRule,
  deactivateSurfPackRule,
  surfPackTableExists,
};
