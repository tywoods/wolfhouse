'use strict';

/**
 * tenant-business-config.js
 *
 * Read-only tenant business configuration resolver for Sunset Admin.
 * Config file: config/clients/{slug}.baseline.json
 * Optional DB: tenant_* tables when SUNSET_ADMIN_DB_READ_ENABLED=true (default off).
 *
 * @see docs/sunset/SUNSET-ADMIN-CONFIG-SPEC.md
 * @module tenant-business-config
 */

const { loadBaselineJson, loadClientPortalProfile } = require('./staff-portal-clients');
const { normalizeSunsetLocationId, DEFAULT_SUNSET_LOCATION_ID } = require('./sunset-school-locations');
const locationStore = require('./sunset-admin-location-store');
const { priceIdFromParts } = require('./sunset-admin-location-store');
const { loadSurfPacksFromDb, defaultPackConfig } = require('./sunset-admin-pack-rules');

const SUNSET_ADMIN_CLIENT = 'sunset';
const DEFAULT_DAILY_CAP = 24;
const TABLE_MISSING_CODE = '42P01';
const ADMIN_CONFIG_TABLES = [
  'tenant_price_rules',
  'tenant_lesson_capacity_rules',
  'tenant_lesson_time_rules',
  'tenant_config_audit_log',
];

function isSunsetAdminDbReadEnabled() {
  const raw = process.env.SUNSET_ADMIN_DB_READ_ENABLED;
  if (raw == null || String(raw).trim() === '') return false;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function flattenOfferingPrices(offerings, category, currency) {
  const prices = [];
  if (!offerings || typeof offerings !== 'object') return prices;
  for (const [offeringKey, offering] of Object.entries(offerings)) {
    if (!offering || typeof offering !== 'object') continue;
    const pricesEur = offering.prices_eur;
    if (!pricesEur || typeof pricesEur !== 'object') continue;
    for (const [unitKey, amount] of Object.entries(pricesEur)) {
      if (unitKey.startsWith('_')) continue;
      if (amount == null || typeof amount !== 'number') continue;
      prices.push({
        category,
        offering_key: offeringKey,
        label: offering.label || offeringKey,
        currency,
        unit: unitKey,
        amount,
        pricing_status: offering.pricing_status || null,
        active: true,
        effective_state: offering.pricing_status === 'confirmed' ? 'confirmed' : (offering.pricing_status || 'unverified_seed'),
        source: 'config',
      });
    }
  }
  return prices;
}

function loadLessonTimesFromConfig(cfg) {
  const slots = cfg && cfg.portal_demo && Array.isArray(cfg.portal_demo.lesson_slots)
    ? cfg.portal_demo.lesson_slots
    : [];
  if (slots.length) {
    return slots.map((s) => ({
      slot_id: s.slot_id || null,
      date: s.date || null,
      slot_time: s.slot_time || null,
      offering_label: s.offering_label || null,
      session_type: s.session_type || null,
      capacity: s.capacity != null ? Number(s.capacity) : null,
      source: s.source || 'config',
    }));
  }
  const common = cfg
    && cfg.catalog
    && cfg.catalog.lessons
    && cfg.catalog.lessons.scheduling
    && cfg.catalog.lessons.scheduling.common_slot_times;
  if (Array.isArray(common) && common.length) {
    return common.map((slotTime, idx) => ({
      slot_id: `fallback-slot-${idx + 1}`,
      date: null,
      slot_time: slotTime,
      offering_label: null,
      session_type: null,
      capacity: null,
      source: 'fallback',
    }));
  }
  return [];
}

function formatPgTime(value) {
  if (value == null) return null;
  const text = String(value);
  return text.length >= 5 ? text.slice(0, 5) : text;
}

function formatPgDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function formatLessonSlotTime(timeLocal, timeLocalEnd) {
  const start = formatPgTime(timeLocal);
  if (!start) return null;
  const end = formatPgTime(timeLocalEnd);
  return end ? `${start}-${end}` : start;
}

function mapPriceRows(rows) {
  return rows.map((row) => ({
    id: row.id ? String(row.id) : null,
    category: row.item_type,
    offering_key: row.item_code,
    label: row.display_name,
    currency: String(row.currency || 'EUR').trim(),
    unit: row.unit,
    amount: Number(row.amount_cents) / 100,
    active: row.active !== false,
    effective_state: 'db',
    effective_from: formatPgDate(row.effective_from),
    effective_to: formatPgDate(row.effective_to),
    source: 'db',
  }));
}

function mapCapacityRows(rows) {
  let default_daily_cap = DEFAULT_DAILY_CAP;
  let hasDefaultRow = false;
  const overrides = [];

  for (const row of rows) {
    if (row.scope === 'default') {
      default_daily_cap = Number(row.capacity);
      hasDefaultRow = true;
    } else if (row.scope === 'weekday') {
      overrides.push({
        scope: 'weekday',
        weekday: Number(row.weekday),
        capacity: Number(row.capacity),
        source: 'db',
      });
    } else if (row.scope === 'date') {
      overrides.push({
        scope: 'date',
        date: formatPgDate(row.service_date),
        capacity: Number(row.capacity),
        source: 'db',
      });
    }
  }

  return {
    default_daily_cap,
    overrides,
    fromDb: rows.length > 0,
    hasDefaultRow,
  };
}


function parseAdminLessonType(lessonType) {
  const raw = String(lessonType || '').trim();
  const m = raw.match(/^(lesson|pack)__(all_ages|6_and_up|6_to_11|12_and_up)$/);
  if (m) return { kind: m[1], age_band: m[2] };
  return { kind: 'lesson', age_band: 'all_ages' };
}

function lessonSlotPriceItemCode(slotId) {
  return `lesson_slot_${slotId}__session`;
}

function detectLessonFrequency(weekdays) {
  const w = Array.isArray(weekdays) ? weekdays.slice().sort((a, b) => a - b) : [];
  const key = w.join(',');
  if (key === '0,1,2,3,4,5,6') return 'daily';
  if (key === '0,6') return 'sat_sun';
  if (key === '1,2,3,4,5') return 'mon_fri';
  return 'daily';
}

function attachLessonPrices(lessonTimes, prices) {
  const byCode = new Map();
  for (const p of prices || []) {
    if (String(p.category || '').toLowerCase() === 'lesson') {
      byCode.set(String(p.offering_key || ''), p);
    }
  }
  return (lessonTimes || []).map((slot) => {
    const code = slot.slot_id ? lessonSlotPriceItemCode(slot.slot_id) : null;
    const price = code ? byCode.get(code) : null;
    const parsed = parseAdminLessonType(slot.session_type);
    return {
      ...slot,
      kind: parsed.kind,
      age_band: parsed.age_band,
      frequency: detectLessonFrequency(slot.weekdays_active),
      price_id: price ? price.id : null,
      price_amount: price ? price.amount : null,
      price_currency: price ? price.currency : 'EUR',
    };
  });
}

function mapLessonTimeRows(rows) {
  return rows.map((row) => ({
    slot_id: row.id ? String(row.id) : null,
    date: formatPgDate(row.service_date),
    slot_time: formatLessonSlotTime(row.time_local, row.time_local_end),
    offering_label: row.label || null,
    session_type: row.lesson_type || null,
    capacity: row.capacity != null ? Number(row.capacity) : null,
    weekdays_active: Array.isArray(row.weekdays_active) ? row.weekdays_active : [],
    source: 'db',
  }));
}

function mapAuditRows(rows) {
  return rows.map((row) => ({
    id: row.id ? String(row.id) : null,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id ? String(row.entity_id) : null,
    actor_email: row.actor_email,
    changed_at: row.created_at,
    before_json: row.before_json || null,
    after_json: row.after_json || null,
    source: 'db',
  }));
}

function buildBusinessInfo(slug, baseline) {
  if (!baseline) {
    return {
      name: slug,
      timezone: null,
      staging: true,
      config_source: 'fallback',
    };
  }
  const demoMode = !!(baseline.portal_demo && baseline.portal_demo.demo_mode);
  const deploymentEnabled = !!(baseline.deployment && baseline.deployment.enabled);
  return {
    name: (baseline._meta && baseline._meta.client_name)
      || (baseline.persona && baseline.persona.brand_name)
      || slug,
    timezone: (baseline._meta && baseline._meta.timezone) || null,
    staging: demoMode || !deploymentEnabled,
    config_source: `${slug}.baseline.json`,
  };
}

function resolveFromConfigFile(clientSlug) {
  const slug = String(clientSlug || '').trim();
  const profile = loadClientPortalProfile(slug);

  if (!profile.is_surf_vertical || slug !== SUNSET_ADMIN_CLIENT) {
    return { ok: false, reason: 'unsupported_client', client_slug: slug };
  }

  const baseline = loadBaselineJson(slug);
  if (!baseline) {
    return {
      ok: true,
      client_slug: slug,
      read_only: true,
      source: 'fallback',
      prices: [],
      lesson_capacity: { default_daily_cap: DEFAULT_DAILY_CAP, overrides: [] },
      lesson_times: [],
      surf_packs: [],
      business_info: buildBusinessInfo(slug, null),
      change_history: [],
    };
  }

  const currency = (baseline.pricing_policy && baseline.pricing_policy.currency)
    || (baseline._meta && baseline._meta.currency)
    || 'EUR';

  const rentals = baseline.catalog && baseline.catalog.rentals && baseline.catalog.rentals.offerings;
  const lessons = baseline.catalog && baseline.catalog.lessons && baseline.catalog.lessons.offerings;
  const packages = baseline.catalog && baseline.catalog.accommodation && baseline.catalog.accommodation.offerings;
  const prices = [
    ...flattenOfferingPrices(rentals, 'rental', currency),
    ...flattenOfferingPrices(lessons, 'lesson', currency),
    ...flattenOfferingPrices(packages, 'package', currency),
  ];

  return {
    ok: true,
    client_slug: slug,
    read_only: true,
    source: 'config',
    prices,
    lesson_capacity: {
      default_daily_cap: DEFAULT_DAILY_CAP,
      overrides: [],
    },
    lesson_times: loadLessonTimesFromConfig(baseline),
    surf_packs: [],
    business_info: buildBusinessInfo(slug, baseline),
    change_history: [],
  };
}

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

async function adminConfigTableHasColumn(client, tableName, columnName) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [tableName, columnName],
  );
  return result.rows.length > 0;
}

async function adminConfigTablesExist(client) {
  const result = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [ADMIN_CONFIG_TABLES],
  );
  return result.rows.length === ADMIN_CONFIG_TABLES.length;
}

/**
 * Load Sunset Admin config rows from Postgres. Caller must pass a scoped client slug.
 *
 * @param {string} clientSlug
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ ok: boolean, reason?: string, hasData: boolean, prices?: any[], lesson_capacity?: any, lesson_times?: any[], change_history?: any[] }>}
 */
async function loadTenantBusinessConfigFromDb(clientSlug, client, locationId) {
  const slug = String(clientSlug || '').trim();
  if (slug !== SUNSET_ADMIN_CLIENT) {
    throw new Error('tenant_scope_violation');
  }

  if (!(await adminConfigTablesExist(client))) {
    return { ok: false, reason: 'tables_missing', hasData: false };
  }

  const loc = normalizeSunsetLocationId(locationId);
  const priceHasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  const capHasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_lesson_capacity_rules');
  const timeHasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_lesson_time_rules');

  const priceParams = priceHasLoc ? [slug, loc] : [slug];
  const capParams = capHasLoc ? [slug, loc] : [slug];
  const timeParams = timeHasLoc ? [slug, loc] : [slug];
  const auditParams = [slug];

  const priceWhere = priceHasLoc
    ? 'client_slug = $1 AND location_id = $2 AND active = true'
    : 'client_slug = $1 AND active = true';
  const capWhere = capHasLoc
    ? 'client_slug = $1 AND location_id = $2 AND active = true'
    : 'client_slug = $1 AND active = true';
  const timeWhere = timeHasLoc
    ? 'client_slug = $1 AND location_id = $2 AND active = true'
    : 'client_slug = $1 AND active = true';
  const timeHasCapacity = await adminConfigTableHasColumn(client, 'tenant_lesson_time_rules', 'capacity');
  const timeCapacitySelect = timeHasCapacity ? ', capacity' : ', NULL::integer AS capacity';

  const [priceRes, capacityRes, timeRes, auditRes] = await Promise.all([
    client.query(
      `SELECT id, item_type, item_code, display_name, currency, amount_cents, unit, active,
              effective_from, effective_to
         FROM tenant_price_rules
        WHERE ${priceWhere}
        ORDER BY item_type, item_code, unit`,
      priceParams,
    ),
    client.query(
      `SELECT scope, weekday, service_date, capacity
         FROM tenant_lesson_capacity_rules
        WHERE ${capWhere}
        ORDER BY scope, weekday NULLS FIRST, service_date NULLS FIRST`,
      capParams,
    ),
    client.query(
      `SELECT id, time_local, time_local_end, label, lesson_type, weekdays_active, service_date${timeCapacitySelect}
         FROM tenant_lesson_time_rules
        WHERE ${timeWhere}
        ORDER BY service_date NULLS FIRST, time_local`,
      timeParams,
    ),
    client.query(
      `SELECT id, action, entity_type, entity_id, actor_email, before_json, after_json, created_at
         FROM tenant_config_audit_log
        WHERE client_slug = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      auditParams,
    ),
  ]);

  const prices = mapPriceRows(priceRes.rows);
  const lessonCapacityRaw = mapCapacityRows(capacityRes.rows);
  const lesson_times = attachLessonPrices(mapLessonTimeRows(timeRes.rows), prices);
  const surf_packs = await loadSurfPacksFromDb(client, slug, loc);
  const change_history = mapAuditRows(auditRes.rows);

  const lesson_capacity = {
    default_daily_cap: lessonCapacityRaw.default_daily_cap,
    overrides: lessonCapacityRaw.overrides,
    fromDb: lessonCapacityRaw.fromDb,
  };

  const hasData = prices.length > 0
    || lessonCapacityRaw.fromDb
    || lesson_times.length > 0
    || change_history.length > 0;

  return {
    ok: true,
    hasData,
    prices,
    lesson_capacity,
    lesson_times,
    surf_packs,
    change_history,
  };
}

function mergeDbWithConfig(configBaseline, dbResult) {
  const prices = dbResult.prices.length ? dbResult.prices : configBaseline.prices;
  const lesson_capacity = dbResult.lesson_capacity.fromDb
    ? {
      default_daily_cap: dbResult.lesson_capacity.default_daily_cap,
      overrides: dbResult.lesson_capacity.overrides,
    }
    : configBaseline.lesson_capacity;
  const lesson_timesRaw = dbResult.lesson_times.length ? dbResult.lesson_times : configBaseline.lesson_times;
  const lesson_times = attachLessonPrices(lesson_timesRaw, prices);
  const change_history = dbResult.change_history.length ? dbResult.change_history : configBaseline.change_history;

  const hasAnyDb = dbResult.prices.length > 0
    || dbResult.lesson_capacity.fromDb
    || dbResult.lesson_times.length > 0
    || dbResult.change_history.length > 0;

  return {
    ...configBaseline,
    source: hasAnyDb ? 'db' : configBaseline.source,
    prices,
    lesson_capacity,
    lesson_times,
    surf_packs,
    change_history,
    read_only: true,
  };
}

async function defaultLoadFromDb(clientSlug, pgClient, locationId) {
  if (pgClient) {
    return loadTenantBusinessConfigFromDb(clientSlug, pgClient, locationId);
  }
  const { withPgClient } = require('./pg-connect');
  return withPgClient((client) => loadTenantBusinessConfigFromDb(clientSlug, client, locationId));
}

/**
 * Resolve read-only business config for Admin tab / GET /staff/admin/config.
 * Sync path — config file only (flag ignored). Use when DB reads are disabled.
 *
 * @param {string} clientSlug
 */
function withLocationMeta(config, locationId) {
  const loc = normalizeSunsetLocationId(locationId);
  const next = {
    ...config,
    location_id: loc,
    location_label: locationStore.resolveLocationLabel(loc),
  };
  if (next.prices && Array.isArray(next.prices)) {
    next.prices = next.prices.map((p) => {
      if (!p || p.id) return p;
      const category = p.category || 'rental';
      const offeringKey = p.offering_key || p.item_code || '';
      const unit = p.unit || '';
      if (!offeringKey || !unit) return p;
      return { ...p, id: priceIdFromParts(loc, category, offeringKey, unit) };
    });
  }
  return next;
}

async function shouldApplyJsonLocationOverlay(clientSlug, locationId, pgClient) {
  if (clientSlug !== SUNSET_ADMIN_CLIENT) return false;
  const raw = process.env.SUNSET_ADMIN_JSON_OVERLAY;
  if (raw != null && /^(0|false|no|off)$/i.test(String(raw).trim())) return false;
  if (raw != null && /^(1|true|yes|on)$/i.test(String(raw).trim())) return true;
  try {
    const client = pgClient;
    if (!client) return locationStore.hasLocationOverrides(locationId);
    const tablesExist = await adminConfigTablesExist(client);
    if (!tablesExist) return true;
    const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
    if (hasLoc) return false;
    return locationStore.hasLocationOverrides(locationId);
  } catch (_) {
    return locationStore.hasLocationOverrides(locationId);
  }
}

function resolveTenantBusinessConfig(clientSlug, locationId) {
  const baseline = resolveFromConfigFile(clientSlug);
  if (!baseline.ok) return baseline;
  const loc = normalizeSunsetLocationId(locationId);
  const withMeta = withLocationMeta(baseline, loc);
  if (!locationStore.hasLocationOverrides(loc)) return withMeta;
  return locationStore.applyStoreToResolvedConfig(withMeta, loc);
}

/**
 * Async resolver with optional DB layer when SUNSET_ADMIN_DB_READ_ENABLED=true.
 *
 * @param {string} clientSlug
 * @param {{ skipDb?: boolean, pgClient?: import('pg').PoolClient, loadFromDb?: Function }} [options]
 */
async function resolveTenantBusinessConfigAsync(clientSlug, options = {}) {
  const locationId = normalizeSunsetLocationId(options.locationId);
  const configBaseline = resolveFromConfigFile(clientSlug);
  if (!configBaseline.ok) {
    return configBaseline;
  }

  let merged = configBaseline;
  if (isSunsetAdminDbReadEnabled() && !options.skipDb) {
    try {
      const loadFn = options.loadFromDb || defaultLoadFromDb;
      const dbResult = await loadFn(clientSlug, options.pgClient, locationId);

      if (!dbResult || dbResult.reason === 'tables_missing') {
        merged = {
          ...configBaseline,
          db_read_warning: 'tables_missing',
        };
      } else if (dbResult.hasData) {
        merged = mergeDbWithConfig(configBaseline, dbResult);
      }
    } catch (err) {
      const warning = err.code === TABLE_MISSING_CODE || /relation .* does not exist/i.test(String(err.message || ''))
        ? 'tables_missing'
        : (err.message || 'db_read_failed');
      merged = {
        ...configBaseline,
        db_read_warning: warning,
      };
    }
  }

  const withMeta = withLocationMeta(merged, locationId);
  const overlay = await shouldApplyJsonLocationOverlay(clientSlug, locationId, options.pgClient);
  if (!overlay) return withMeta;
  return locationStore.applyStoreToResolvedConfig(withMeta, locationId);
}

module.exports = {
  attachLessonPrices,
  parseAdminLessonType,

  SUNSET_ADMIN_CLIENT,
  DEFAULT_DAILY_CAP,
  ADMIN_CONFIG_TABLES,
  flattenOfferingPrices,
  loadLessonTimesFromConfig,
  isSunsetAdminDbReadEnabled,
  loadTenantBusinessConfigFromDb,
  adminConfigTableHasLocationColumn,
  adminConfigTablesExist,
  shouldApplyJsonLocationOverlay,
  withLocationMeta,
  resolveFromConfigFile,
  resolveTenantBusinessConfig,
  resolveTenantBusinessConfigAsync,
  mergeDbWithConfig,
};
