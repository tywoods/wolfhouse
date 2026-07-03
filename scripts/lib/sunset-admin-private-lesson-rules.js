'use strict';

/**
 * Sunset Admin — single private lesson product per client/location.
 */

const { normalizeSunsetLocationId } = require('./sunset-school-locations');

async function adminConfigTableHasLocationColumn(client, tableName) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = 'location_id'
      LIMIT 1`,
    [tableName],
  );
  return result.rows.length > 0;
}

const PRIVATE_LESSON_PRICE_ITEM_CODE = 'private_lesson__session';
const DEFAULT_DURATION_MINUTES = 120;
const DEFAULT_LABEL = 'Private lesson';
const PRICE_BASIS_VALUES = new Set(['per_session']);

function defaultPrivateLessonApi(overrides) {
  return {
    enabled: false,
    label: DEFAULT_LABEL,
    amount_cents: 0,
    currency: 'EUR',
    price_basis: 'per_session',
    default_duration_minutes: DEFAULT_DURATION_MINUTES,
    notes: '',
    source: 'default',
    ...(overrides || {}),
  };
}

function defaultPrivateLessonFromConfig(baseline) {
  const offering = baseline
    && baseline.catalog
    && baseline.catalog.lessons
    && baseline.catalog.lessons.offerings
    && baseline.catalog.lessons.offerings.private_coaching;
  const currency = (baseline && baseline.pricing_policy && baseline.pricing_policy.currency)
    || (baseline && baseline._meta && baseline._meta.currency)
    || 'EUR';
  const label = (offering && offering.label) ? String(offering.label).trim() : DEFAULT_LABEL;
  return defaultPrivateLessonApi({
    label,
    currency,
    source: 'config',
  });
}

function mapPrivateLessonRow(row) {
  if (!row) return defaultPrivateLessonApi();
  const cfg = row.config_json && typeof row.config_json === 'object' ? row.config_json : {};
  const amount = cfg.amount_cents != null ? Number(cfg.amount_cents) : 0;
  return {
    rule_id: row.id ? String(row.id) : null,
    enabled: row.active !== false,
    label: row.label || DEFAULT_LABEL,
    amount_cents: Number.isInteger(amount) && amount >= 0 ? amount : 0,
    currency: String(cfg.currency || 'EUR').trim().toUpperCase() || 'EUR',
    price_basis: PRICE_BASIS_VALUES.has(String(cfg.price_basis || '').trim())
      ? String(cfg.price_basis).trim()
      : 'per_session',
    default_duration_minutes: Number.isInteger(Number(cfg.default_duration_minutes))
      && Number(cfg.default_duration_minutes) >= 15
      && Number(cfg.default_duration_minutes) <= 480
      ? Number(cfg.default_duration_minutes)
      : DEFAULT_DURATION_MINUTES,
    notes: cfg.notes != null ? String(cfg.notes) : '',
    source: 'db',
  };
}

function validatePrivateLessonBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid body' };
  }
  const out = {};
  if (body.enabled != null) {
    if (typeof body.enabled !== 'boolean') return { ok: false, error: 'enabled must be boolean' };
    out.enabled = body.enabled;
  }
  const labelRaw = body.label != null ? body.label : body.display_name;
  if (labelRaw != null) {
    const label = String(labelRaw).trim();
    if (!label) return { ok: false, error: 'label required' };
    if (label.length > 120) return { ok: false, error: 'label too long' };
    out.label = label;
  }
  if (body.amount_cents != null) {
    const n = Number(body.amount_cents);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'amount_cents must be integer >= 0' };
    out.amount_cents = n;
  }
  if (body.currency != null) {
    const cur = String(body.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) return { ok: false, error: 'invalid currency' };
    out.currency = cur;
  }
  if (body.price_basis != null) {
    const basis = String(body.price_basis).trim();
    if (!PRICE_BASIS_VALUES.has(basis)) return { ok: false, error: 'invalid price_basis' };
    out.price_basis = basis;
  }
  if (body.default_duration_minutes != null) {
    const mins = Number(body.default_duration_minutes);
    if (!Number.isInteger(mins) || mins < 15 || mins > 480) {
      return { ok: false, error: 'default_duration_minutes must be 15–480' };
    }
    out.default_duration_minutes = mins;
  }
  if (body.notes != null) {
    out.notes = String(body.notes).trim().slice(0, 2000);
  }
  if (!Object.keys(out).length) return { ok: false, error: 'empty body' };
  return { ok: true, patch: out };
}

async function ensurePrivateLessonTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS tenant_private_lesson_rules (
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
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_private_lesson_client_loc
      ON tenant_private_lesson_rules (client_slug, COALESCE(location_id, ''))
      WHERE active = true`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_private_lesson_client_active
      ON tenant_private_lesson_rules (client_slug, active)`);
}

async function loadPrivateLessonFromDb(client, clientSlug, locationId) {
  await ensurePrivateLessonTable(client);
  const loc = normalizeSunsetLocationId(locationId);
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_private_lesson_rules');
  const params = hasLoc ? [clientSlug, loc] : [clientSlug];
  const where = hasLoc
    ? 'client_slug = $1 AND location_id = $2'
    : 'client_slug = $1';
  const result = await client.query(
    `SELECT id, label, config_json, active
       FROM tenant_private_lesson_rules
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT 1`,
    params,
  );
  if (!result.rows[0]) return { row: null, api: null };
  return { row: result.rows[0], api: mapPrivateLessonRow(result.rows[0]) };
}

async function syncPrivateLessonPriceRule(client, {
  clientSlug, locationId, label, amountCents, currency, enabled, actor,
}) {
  const { upsertConfigPriceRule } = require('./tenant-admin-writes');
  const loc = normalizeSunsetLocationId(locationId);
  if (!enabled) {
    const { deactivatePriceRule } = require('./tenant-admin-writes');
    const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
    const itemType = 'lesson';
    const itemCode = PRIVATE_LESSON_PRICE_ITEM_CODE;
    const params = hasLoc ? [clientSlug, loc, itemType, itemCode] : [clientSlug, itemType, itemCode];
    const where = hasLoc
      ? 'client_slug = $1 AND location_id = $2 AND item_type = $3 AND item_code = $4 AND active = true'
      : 'client_slug = $1 AND item_type = $2 AND item_code = $3 AND active = true';
    const existing = await client.query(
      `SELECT id FROM tenant_price_rules WHERE ${where} LIMIT 1`,
      params,
    );
    if (!existing.rows[0]) return;
    await deactivatePriceRule(client, {
      ruleId: existing.rows[0].id,
      clientSlug,
      locationId: loc,
      actor,
    });
    return;
  }
  await upsertConfigPriceRule(client, {
    clientSlug,
    locationId: loc,
    category: 'lesson',
    offeringKey: 'private_lesson',
    unit: 'session',
    patch: {
      display_name: label,
      amount_cents: amountCents,
      currency: currency || 'EUR',
      active: true,
    },
    actor,
    forceItemCode: PRIVATE_LESSON_PRICE_ITEM_CODE,
    forceDbUnit: 'session',
  });
}

async function putPrivateLessonRule(client, { clientSlug, locationId, body, actor }) {
  await ensurePrivateLessonTable(client);
  const validated = validatePrivateLessonBody(body);
  if (!validated.ok) return { ok: false, status: 400, body: { success: false, error: validated.error } };

  const loc = normalizeSunsetLocationId(locationId);
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_private_lesson_rules');
  const existing = await loadPrivateLessonFromDb(client, clientSlug, loc);
  const prev = existing.api || defaultPrivateLessonApi();
  const patch = validated.patch;

  const next = {
    enabled: patch.enabled != null ? patch.enabled : prev.enabled,
    label: patch.label != null ? patch.label : prev.label,
    amount_cents: patch.amount_cents != null ? patch.amount_cents : prev.amount_cents,
    currency: patch.currency != null ? patch.currency : prev.currency,
    price_basis: patch.price_basis != null ? patch.price_basis : prev.price_basis,
    default_duration_minutes: patch.default_duration_minutes != null
      ? patch.default_duration_minutes
      : prev.default_duration_minutes,
    notes: patch.notes != null ? patch.notes : prev.notes,
  };

  const configJson = {
    amount_cents: next.amount_cents,
    currency: next.currency,
    price_basis: next.price_basis,
    default_duration_minutes: next.default_duration_minutes,
    notes: next.notes,
  };

  await client.query('BEGIN');
  try {
    let row;
    if (existing.row) {
      const updated = await client.query(
        hasLoc
          ? `UPDATE tenant_private_lesson_rules
                SET label = $4, config_json = $5::jsonb, active = $6,
                    updated_at = NOW(), updated_by = $7::uuid
              WHERE id = $1::uuid AND client_slug = $2 AND location_id = $3
              RETURNING *`
          : `UPDATE tenant_private_lesson_rules
                SET label = $3, config_json = $4::jsonb, active = $5,
                    updated_at = NOW(), updated_by = $6::uuid
              WHERE id = $1::uuid AND client_slug = $2
              RETURNING *`,
        hasLoc
          ? [existing.row.id, clientSlug, loc, next.label, JSON.stringify(configJson), next.enabled, actor.staff_user_id || null]
          : [existing.row.id, clientSlug, next.label, JSON.stringify(configJson), next.enabled, actor.staff_user_id || null],
      );
      row = updated.rows[0];
    } else {
      const inserted = await client.query(
        hasLoc
          ? `INSERT INTO tenant_private_lesson_rules (
               tenant_id, client_slug, location_id, label, config_json, active, updated_by
             ) VALUES ('sunset', $1, $2, $3, $4::jsonb, $5, $6::uuid)
             RETURNING *`
          : `INSERT INTO tenant_private_lesson_rules (
               tenant_id, client_slug, label, config_json, active, updated_by
             ) VALUES ('sunset', $1, $2, $3::jsonb, $4, $5::uuid)
             RETURNING *`,
        hasLoc
          ? [clientSlug, loc, next.label, JSON.stringify(configJson), next.enabled, actor.staff_user_id || null]
          : [clientSlug, next.label, JSON.stringify(configJson), next.enabled, actor.staff_user_id || null],
      );
      row = inserted.rows[0];
    }
    await client.query('COMMIT');
    try {
      await syncPrivateLessonPriceRule(client, {
        clientSlug,
        locationId: loc,
        label: next.label,
        amountCents: next.amount_cents,
        currency: next.currency,
        enabled: next.enabled,
        actor,
      });
    } catch (priceErr) {
      return {
        ok: false,
        status: 500,
        body: { success: false, error: 'private_lesson_price_sync_failed', message: priceErr.message },
      };
    }
    const api = mapPrivateLessonRow(row);
    return { ok: true, status: 200, body: { success: true, private_lesson: api } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  PRIVATE_LESSON_PRICE_ITEM_CODE,
  DEFAULT_DURATION_MINUTES,
  DEFAULT_LABEL,
  defaultPrivateLessonApi,
  defaultPrivateLessonFromConfig,
  mapPrivateLessonRow,
  validatePrivateLessonBody,
  ensurePrivateLessonTable,
  loadPrivateLessonFromDb,
  putPrivateLessonRule,
};
