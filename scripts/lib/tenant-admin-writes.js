'use strict';

/**
 * Sunset Admin config — DB-first writes with JSON fallback when tenant_* tables absent.
 * School isolation requires migration 023 (location_id on admin tables).
 */

const {
  SUNSET_ADMIN_CLIENT,
  adminConfigTableHasLocationColumn,
  adminConfigTablesExist,
} = require('./tenant-business-config');
const { normalizeSunsetLocationId, DEFAULT_SUNSET_LOCATION_ID } = require('./sunset-school-locations');
const locationStore = require('./sunset-admin-location-store');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;
const UNIT_VALUES = new Set(['person', 'day', 'session', 'item']);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ADMIN_WRITE_MIN_ROLE = 'admin';
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 };

const PRICE_PATCH_FIELDS = new Set([
  'display_name',
  'amount_cents',
  'currency',
  'unit',
  'period_window',
  'active',
  'effective_from',
  'effective_to',
]);

const RENTAL_GROUP_KEYS = new Set(['bundles', 'boards', 'wetsuits', 'sup']);
const RENTAL_GROUP_OFFERING = {
  bundles: 'board_and_suit_rental',
  boards: 'board_rental',
  wetsuits: 'wetsuit_rental',
  sup: 'sup_rental',
};
const RENTAL_GROUP_DISPLAY = {
  bundles: 'Surfboard + Wetsuit',
  boards: 'Surfboard',
  wetsuits: 'Wetsuit',
  sup: 'SUP',
};
const RENTAL_PERIOD_WINDOWS = new Set(['1_hour', '2_hours', 'half_day', '1_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days']);


const LESSON_KINDS = new Set(['lesson', 'pack']);
const LESSON_AGE_BANDS = new Set(['all_ages', '6_and_up', '6_to_11', '12_and_up']);
const LESSON_FREQUENCY_PRESETS = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  sat_sun: [0, 6],
  mon_fri: [1, 2, 3, 4, 5],
};

function buildLessonType(kind, ageBand) {
  return `${kind}__${ageBand}`;
}

function parseLessonTypeValue(lessonType) {
  const raw = String(lessonType || '').trim();
  const m = raw.match(/^(lesson|pack)__(all_ages|6_and_up|6_to_11|12_and_up)$/);
  if (m) return { kind: m[1], age_band: m[2] };
  return { kind: 'lesson', age_band: 'all_ages' };
}

function lessonSlotPriceItemCode(slotId) {
  return `lesson_slot_${slotId}__session`;
}

function resolveLessonFrequencyPreset(key) {
  const k = String(key || 'daily').trim();
  return LESSON_FREQUENCY_PRESETS[k] || LESSON_FREQUENCY_PRESETS.daily;
}

function validateLessonKindAgeFrequency(body, out) {
  if (body.kind != null) {
    const kind = String(body.kind).trim();
    if (!LESSON_KINDS.has(kind)) return { ok: false, error: 'invalid kind' };
    out.kind = kind;
  }
  if (body.age_band != null) {
    const age = String(body.age_band).trim();
    if (!LESSON_AGE_BANDS.has(age)) return { ok: false, error: 'invalid age_band' };
    out.age_band = age;
  }
  if (body.frequency != null) {
    const freq = String(body.frequency).trim();
    if (!LESSON_FREQUENCY_PRESETS[freq]) return { ok: false, error: 'invalid frequency' };
    out.frequency = freq;
    out.weekdays_active = LESSON_FREQUENCY_PRESETS[freq];
  }
  if (body.amount_cents != null) {
    const n = Number(body.amount_cents);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'amount_cents must be integer >= 0' };
    out.amount_cents = n;
  }
  return { ok: true };
}

const LESSON_TIME_PATCH_FIELDS = new Set([
  'label',
  'time_local',
  'time_local_end',
  'lesson_type',
  'weekdays_active',
  'active',
  'capacity',
  'kind',
  'age_band',
  'frequency',
  'amount_cents',
]);

function isSunsetAdminWritesEnabled() {
  const raw = process.env.SUNSET_ADMIN_WRITES_ENABLED;
  if (raw == null || String(raw).trim() === '') return false;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function writesDisabledResponse() {
  return {
    status: 403,
    body: {
      success: false,
      error: 'writes_disabled',
      message: 'Admin writes disabled',
    },
  };
}

function hasMinRole(userRole, minRole) {
  return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[minRole] || 0);
}

function resolveActorRole(user) {
  if (!user) return null;
  return String(user.role || '').trim().toLowerCase();
}

function evaluateAdminWriteGate(ctx) {
  const clientSlug = String(ctx.clientSlug || '').trim();
  if (!isSunsetAdminWritesEnabled()) {
    return { ok: false, ...writesDisabledResponse() };
  }
  if (clientSlug !== SUNSET_ADMIN_CLIENT) {
    return {
      ok: false,
      status: 403,
      body: { success: false, error: 'unsupported_client', client_slug: clientSlug },
    };
  }
  if (ctx.staffAuthRequired !== false) {
    if (!ctx.user) {
      return {
        ok: false,
        status: 401,
        body: {
          success: false,
          error: 'Authentication required. POST /staff/auth/login first.',
          auth_url: '/staff/auth/login',
        },
      };
    }
    const resolveRole = ctx.resolveStaffRole || ((u) => resolveActorRole(u));
    const role = resolveRole(ctx.user);
    if (!hasMinRole(role, ADMIN_WRITE_MIN_ROLE)) {
      return {
        ok: false,
        status: 403,
        body: {
          success: false,
          error: 'forbidden_role',
          message: 'Owner or admin role required for Admin writes',
          current_role: role,
        },
      };
    }
  }
  return { ok: true };
}

function validateUuid(id, label) {
  const text = String(id || '').trim();
  if (!UUID_RE.test(text)) {
    return { ok: false, error: `invalid ${label || 'id'}` };
  }
  return { ok: true, value: text };
}

function rejectUnknownFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid body' };
  }
  const keys = Object.keys(body);
  for (const key of keys) {
    if (!allowed.has(key)) {
      return { ok: false, error: `unknown field: ${key}` };
    }
  }
  if (!keys.length) {
    return { ok: false, error: 'empty body' };
  }
  return { ok: true, keys };
}

function parseOptionalDate(value, fieldName) {
  if (value == null) return { ok: true, value: null };
  const text = String(value).trim();
  if (!text) return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return { ok: false, error: `${fieldName} must be YYYY-MM-DD` };
  }
  return { ok: true, value: text };
}


function parseItemCodeParts(itemCode) {
  const text = String(itemCode || '').trim();
  const parts = text.split('__');
  if (parts.length >= 2) {
    return { offering_key: parts[0], period_window: parts.slice(1).join('__') };
  }
  return { offering_key: text, period_window: null };
}

function resolveRentalGroupOffering(rentalGroup) {
  const key = String(rentalGroup || '').trim();
  if (!RENTAL_GROUP_KEYS.has(key)) return { ok: false, error: 'invalid rental_group' };
  return { ok: true, rental_group: key, offering_key: RENTAL_GROUP_OFFERING[key] };
}

function validatePriceCreateBody(body) {
  const allowed = new Set(['rental_group', 'period_window', 'amount_cents', 'currency']);
  const unknown = rejectUnknownFields(body, allowed);
  if (!unknown.ok) return unknown;
  const group = resolveRentalGroupOffering(body.rental_group);
  if (!group.ok) return group;
  const period = String(body.period_window || '').trim();
  if (!RENTAL_PERIOD_WINDOWS.has(period)) return { ok: false, error: 'invalid period_window' };
  const n = Number(body.amount_cents);
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'amount_cents must be integer >= 0' };
  const currency = body.currency != null ? String(body.currency).trim().toUpperCase() : 'EUR';
  if (body.currency != null && !CURRENCY_RE.test(currency)) return { ok: false, error: 'currency must be 3-letter code' };
  return {
    ok: true,
    patch: {
      rental_group: group.rental_group,
      offering_key: group.offering_key,
      period_window: period,
      amount_cents: n,
      currency,
    },
  };
}

function validatePricePatchBody(body) {
  const unknown = rejectUnknownFields(body, PRICE_PATCH_FIELDS);
  if (!unknown.ok) return unknown;

  const out = {};
  if (body.display_name != null) {
    const text = String(body.display_name).trim();
    if (!text) return { ok: false, error: 'display_name required' };
    out.display_name = text;
  }
  if (body.amount_cents != null) {
    const n = Number(body.amount_cents);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'amount_cents must be integer >= 0' };
    out.amount_cents = n;
  }
  if (body.currency != null) {
    const cur = String(body.currency).trim().toUpperCase();
    if (!CURRENCY_RE.test(cur)) return { ok: false, error: 'currency must be 3-letter code' };
    out.currency = cur;
  }
  if (body.period_window != null) {
    const period = String(body.period_window).trim();
    if (!RENTAL_PERIOD_WINDOWS.has(period)) return { ok: false, error: 'invalid period_window' };
    out.period_window = period;
  }
  if (body.unit != null) {
    const unit = String(body.unit).trim().toLowerCase();
    if (!UNIT_VALUES.has(unit)) return { ok: false, error: 'invalid unit' };
    out.unit = unit;
  }
  if (body.active != null) {
    if (typeof body.active !== 'boolean') return { ok: false, error: 'active must be boolean' };
    out.active = body.active;
  }
  if (body.effective_from != null) {
    const parsed = parseOptionalDate(body.effective_from, 'effective_from');
    if (!parsed.ok) return parsed;
    out.effective_from = parsed.value;
  }
  if (body.effective_to != null) {
    const parsed = parseOptionalDate(body.effective_to, 'effective_to');
    if (!parsed.ok) return parsed;
    out.effective_to = parsed.value;
  }
  if (!Object.keys(out).length) return { ok: false, error: 'empty body' };
  return { ok: true, patch: out };
}

function validateLessonCapacityBody(body) {
  const unknown = rejectUnknownFields(body, new Set(['default_daily_cap']));
  if (!unknown.ok) return unknown;
  if (body.default_daily_cap == null) {
    return { ok: false, error: 'default_daily_cap required' };
  }
  const n = Number(body.default_daily_cap);
  if (!Number.isInteger(n) || n < 1 || n > 999) {
    return { ok: false, error: 'default_daily_cap must be integer 1-999' };
  }
  return { ok: true, patch: { default_daily_cap: n } };
}

function validateWeekdaysActive(value) {
  if (!Array.isArray(value)) return { ok: false, error: 'weekdays_active must be array' };
  const out = [];
  for (const item of value) {
    const n = Number(item);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      return { ok: false, error: 'weekdays_active values must be 0-6' };
    }
    if (!out.includes(n)) out.push(n);
  }
  out.sort((a, b) => a - b);
  return { ok: true, value: out };
}


function validateLessonTimeCreateBody(body) {
  const unknown = rejectUnknownFields(body, LESSON_TIME_PATCH_FIELDS);
  if (!unknown.ok) return unknown;
  const out = {};
  const label = String(body.label || '').trim();
  if (!label) return { ok: false, error: 'label required' };
  out.label = label;
  const start = String(body.time_local || '').trim();
  if (!TIME_RE.test(start)) return { ok: false, error: 'time_local must be HH:MM' };
  out.time_local = start;
  if (body.time_local_end != null && String(body.time_local_end).trim() !== '') {
    const end = String(body.time_local_end).trim();
    if (!TIME_RE.test(end)) return { ok: false, error: 'time_local_end must be HH:MM' };
    if (end <= start) return { ok: false, error: 'time_local_end must be after time_local' };
    out.time_local_end = end;
  }
  const type = String(body.lesson_type || 'group_surf_lesson').trim();
  if (!type) return { ok: false, error: 'lesson_type required' };
  out.lesson_type = type;
  if (body.weekdays_active != null) {
    const weekdays = validateWeekdaysActive(body.weekdays_active);
    if (!weekdays.ok) return weekdays;
    out.weekdays_active = weekdays.value;
  } else {
    out.weekdays_active = [0, 1, 2, 3, 4, 5, 6];
  }
  out.active = body.active !== false;
  const kindAge = validateLessonKindAgeFrequency(body, out);
  if (!kindAge.ok) return kindAge;
  const kind = out.kind || 'lesson';
  const age = out.age_band || 'all_ages';
  out.lesson_type = buildLessonType(kind, age);
  delete out.kind;
  delete out.age_band;
  delete out.frequency;
  if (body.amount_cents == null) return { ok: false, error: 'amount_cents required' };
  return { ok: true, patch: out };
}

function validateLessonTimePatchBody(body) {
  const unknown = rejectUnknownFields(body, LESSON_TIME_PATCH_FIELDS);
  if (!unknown.ok) return unknown;

  const out = {};
  if (body.label != null) {
    const text = String(body.label).trim();
    if (!text) return { ok: false, error: 'label required' };
    out.label = text;
  }
  if (body.time_local != null) {
    const t = String(body.time_local).trim();
    if (!TIME_RE.test(t)) return { ok: false, error: 'time_local must be HH:MM' };
    out.time_local = t;
  }
  if (body.time_local_end != null) {
    if (body.time_local_end === null) {
      out.time_local_end = null;
    } else {
      const t = String(body.time_local_end).trim();
      if (!TIME_RE.test(t)) return { ok: false, error: 'time_local_end must be HH:MM' };
      out.time_local_end = t;
    }
  }
  if (body.lesson_type != null) {
    const text = String(body.lesson_type).trim();
    if (!text) return { ok: false, error: 'lesson_type required' };
    out.lesson_type = text;
  }
  if (body.weekdays_active != null) {
    const weekdays = validateWeekdaysActive(body.weekdays_active);
    if (!weekdays.ok) return weekdays;
    out.weekdays_active = weekdays.value;
  }
  if (body.capacity != null) {
    const n = Number(body.capacity);
    if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, error: 'capacity must be integer 1-999' };
    out.capacity = n;
  }
  if (body.active != null) {
    if (typeof body.active !== 'boolean') return { ok: false, error: 'active must be boolean' };
    out.active = body.active;
  }

  const kindAge = validateLessonKindAgeFrequency(body, out);
  if (!kindAge.ok) return kindAge;
  if (out.kind != null || out.age_band != null) {
    const kind = out.kind || 'lesson';
    const age = out.age_band || 'all_ages';
    out.lesson_type = buildLessonType(kind, age);
    delete out.kind;
    delete out.age_band;
  }
  delete out.frequency;

  if (!Object.keys(out).length) return { ok: false, error: 'empty body' };

  if (out.time_local && out.time_local_end && out.time_local_end <= out.time_local) {
    return { ok: false, error: 'time_local_end must be after time_local' };
  }
  return { ok: true, patch: out };
}

function rowToAuditJson(row) {
  if (!row) return null;
  return JSON.parse(JSON.stringify(row));
}

function mapCategoryToItemType(category) {
  if (category === 'package') return 'package';
  if (category === 'lesson') return 'lesson';
  return 'rental';
}

function buildDbItemCode(offeringKey, baselineUnit) {
  return `${offeringKey}__${baselineUnit}`;
}

function mapBaselineUnitToDb(unitKey) {
  const key = String(unitKey || '').trim();
  if (/surfer|person|single_lesson/i.test(key)) return 'person';
  if (/^(1|2|5|7)_days?$/.test(key) || key === '1_day') return 'day';
  if (/hour|half_day|lesson/i.test(key)) return 'session';
  return 'item';
}

async function insertConfigAudit(client, {
  tenantId,
  clientSlug,
  actor,
  action,
  entityType,
  entityId,
  beforeJson,
  afterJson,
}) {
  await client.query(
    `INSERT INTO tenant_config_audit_log (
       tenant_id, client_slug, actor_user_id, actor_email, action,
       entity_type, entity_id, before_json, after_json
     ) VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::uuid, $8::jsonb, $9::jsonb)`,
    [
      tenantId,
      clientSlug,
      actor.staff_user_id || null,
      actor.email || 'unknown',
      action,
      entityType,
      entityId,
      beforeJson ? JSON.stringify(beforeJson) : null,
      afterJson ? JSON.stringify(afterJson) : null,
    ],
  );
}

async function findPriceRuleRow(client, {
  clientSlug, locationId, itemType, itemCode, ruleId, hasLoc,
}) {
  const loc = normalizeSunsetLocationId(locationId);
  if (ruleId) {
    return client.query(
      hasLoc
        ? `SELECT * FROM tenant_price_rules WHERE id = $1::uuid AND client_slug = $2 AND location_id = $3 FOR UPDATE`
        : `SELECT * FROM tenant_price_rules WHERE id = $1::uuid AND client_slug = $2 FOR UPDATE`,
      hasLoc ? [ruleId, clientSlug, loc] : [ruleId, clientSlug],
    );
  }
  return client.query(
    hasLoc
      ? `SELECT * FROM tenant_price_rules
          WHERE client_slug = $1 AND location_id = $2 AND item_type = $3 AND item_code = $4 AND active = true
          FOR UPDATE`
      : `SELECT * FROM tenant_price_rules
          WHERE client_slug = $1 AND item_type = $2 AND item_code = $3 AND active = true
          FOR UPDATE`,
    hasLoc ? [clientSlug, loc, itemType, itemCode] : [clientSlug, itemType, itemCode],
  );
}


async function applyPricePatchFields(client, before, patch, actor) {
  const parsed = parseItemCodeParts(before.item_code);
  const offeringKey = parsed.offering_key;
  const nextPeriod = patch.period_window != null ? patch.period_window : parsed.period_window;
  const nextItemCode = nextPeriod ? buildDbItemCode(offeringKey, nextPeriod) : before.item_code;
  const nextUnit = nextPeriod ? mapBaselineUnitToDb(nextPeriod) : before.unit;
  const nextDisplay = patch.display_name != null
    ? patch.display_name
    : (Object.values(RENTAL_GROUP_OFFERING).includes(offeringKey)
      ? (RENTAL_GROUP_DISPLAY[Object.keys(RENTAL_GROUP_OFFERING).find((k) => RENTAL_GROUP_OFFERING[k] === offeringKey)] || before.display_name)
      : before.display_name);

  const dbPatch = { ...patch };
  delete dbPatch.period_window;
  dbPatch.item_code = nextItemCode;
  dbPatch.unit = nextUnit;
  dbPatch.display_name = nextDisplay;
  return dbPatch;
}



async function upsertLessonSlotPriceRule(client, {
  clientSlug, locationId, slotId, label, amountCents, currency, actor,
}) {
  const itemCode = lessonSlotPriceItemCode(slotId);
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  const loc = normalizeSunsetLocationId(locationId);
  const existing = await findPriceRuleRow(client, {
    clientSlug, locationId: loc, itemType: 'lesson', itemCode, hasLoc,
  });
  let cents = amountCents;
  if (cents == null && existing.rows[0]) cents = existing.rows[0].amount_cents;
  if (cents == null) return { ok: true };
  return upsertConfigPriceRule(client, {
    clientSlug,
    locationId,
    category: 'lesson',
    offeringKey: itemCode,
    unit: 'session',
    patch: {
      display_name: label,
      amount_cents: cents,
      currency: currency || 'EUR',
    },
    actor,
    forceItemCode: itemCode,
    forceDbUnit: 'session',
  });
}

async function createRentalPriceRule(client, { clientSlug, locationId, patch, actor }) {
  const tablesExist = await adminConfigTablesExist(client);
  if (!tablesExist) {
    return { ok: false, status: 503, body: { success: false, error: 'admin_db_tables_missing' } };
  }
  const loc = normalizeSunsetLocationId(locationId);
  const itemType = 'rental';
  const itemCode = buildDbItemCode(patch.offering_key, patch.period_window);
  const dbUnit = mapBaselineUnitToDb(patch.period_window);
  const displayName = RENTAL_GROUP_DISPLAY[patch.rental_group] || patch.offering_key;
  return upsertConfigPriceRule(client, {
    clientSlug,
    locationId: loc,
    category: 'rental',
    offeringKey: patch.offering_key,
    unit: patch.period_window,
    patch: {
      display_name: displayName,
      amount_cents: patch.amount_cents,
      currency: patch.currency || 'EUR',
    },
    actor,
    forceItemCode: itemCode,
    forceDbUnit: dbUnit,
  });
}

async function deactivatePriceRule(client, { ruleId, clientSlug, locationId, actor }) {
  const tablesExist = await adminConfigTablesExist(client);
  const loc = normalizeSunsetLocationId(locationId);
  if (!tablesExist) {
    return { ok: false, status: 503, body: { success: false, error: 'admin_db_tables_missing' } };
  }
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  await client.query('BEGIN');
  try {
    const existing = await client.query(
      hasLoc
        ? `SELECT * FROM tenant_price_rules WHERE id = $1::uuid AND client_slug = $2 AND location_id = $3 AND active = true FOR UPDATE`
        : `SELECT * FROM tenant_price_rules WHERE id = $1::uuid AND client_slug = $2 AND active = true FOR UPDATE`,
      hasLoc ? [ruleId, clientSlug, loc] : [ruleId, clientSlug],
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
    }
    const before = existing.rows[0];
    const updated = await client.query(
      `UPDATE tenant_price_rules SET active = false, updated_at = NOW(), updated_by = $3::uuid
         WHERE id = $1::uuid AND client_slug = $2 RETURNING *`,
      [ruleId, clientSlug, actor.staff_user_id || null],
    );
    const after = updated.rows[0];
    await insertConfigAudit(client, {
      tenantId: before.tenant_id,
      clientSlug,
      actor,
      action: 'deactivate',
      entityType: 'price_rule',
      entityId: ruleId,
      beforeJson: rowToAuditJson(before),
      afterJson: rowToAuditJson(after),
    });
    await client.query('COMMIT');
    return { ok: true, status: 200, body: { success: true, price_rule: after, storage: 'db' } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function upsertConfigPriceRule(client, {
  clientSlug, locationId, category, offeringKey, unit, patch, actor, forceItemCode, forceDbUnit,
}) {
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  const loc = normalizeSunsetLocationId(locationId);
  const itemType = mapCategoryToItemType(category);
  const itemCode = forceItemCode || buildDbItemCode(offeringKey, unit);
  const dbUnit = forceDbUnit || mapBaselineUnitToDb(unit);

  await client.query('BEGIN');
  try {
    const existing = await findPriceRuleRow(client, {
      clientSlug, locationId: loc, itemType, itemCode, hasLoc,
    });
    let before = existing.rows[0] || null;
    let after;

    if (before) {
      const sets = [];
      const params = [];
      let idx = 3;
      for (const [key, value] of Object.entries(dbPatchLesson)) {
        sets.push(`${key} = $${idx}`);
        params.push(value);
        idx += 1;
      }
      sets.push('updated_at = NOW()');
      sets.push(`updated_by = $${idx}::uuid`);
      params.push(actor.staff_user_id || null);
      const updated = await client.query(
        `UPDATE tenant_price_rules SET ${sets.join(', ')}
          WHERE id = $1::uuid AND client_slug = $2
          RETURNING *`,
        [before.id, clientSlug, ...params],
      );
      after = updated.rows[0];
    } else {
      const displayName = patch.display_name || `${offeringKey} (${unit})`;
      const amountCents = patch.amount_cents != null ? patch.amount_cents : 0;
      const currency = patch.currency || 'EUR';
      const insertCols = hasLoc
        ? `(tenant_id, client_slug, location_id, item_type, item_code, display_name, currency, amount_cents, unit, active, updated_by)`
        : `(tenant_id, client_slug, item_type, item_code, display_name, currency, amount_cents, unit, active, updated_by)`;
      const insertVals = hasLoc
        ? `($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10::uuid)`
        : `($1, $2, $3, $4, $5, $6, $7, $8, true, $9::uuid)`;
      const insertParams = hasLoc
        ? ['sunset', clientSlug, loc, itemType, itemCode, displayName, currency, amountCents, dbUnit, actor.staff_user_id || null]
        : ['sunset', clientSlug, itemType, itemCode, displayName, currency, amountCents, dbUnit, actor.staff_user_id || null];
      const inserted = await client.query(
        `INSERT INTO tenant_price_rules ${insertCols} VALUES ${insertVals} RETURNING *`,
        insertParams,
      );
      after = inserted.rows[0];
    }

    await insertConfigAudit(client, {
      tenantId: after.tenant_id,
      clientSlug,
      actor,
      action: before ? 'update' : 'create',
      entityType: 'price_rule',
      entityId: after.id,
      beforeJson: rowToAuditJson(before),
      afterJson: rowToAuditJson(after),
    });

    await client.query('COMMIT');
    return {
      ok: true,
      status: 200,
      body: { success: true, price_rule: after, storage: 'db' },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function patchPriceRule(client, { ruleId, clientSlug, locationId, patch, actor }) {
  const tablesExist = await adminConfigTablesExist(client);
  const parsedCfg = locationStore.parseConfigPriceId(ruleId);
  const reqLoc = normalizeSunsetLocationId(locationId);

  if (parsedCfg) {
    if (parsedCfg.locationId !== reqLoc) {
      return { ok: false, status: 403, body: { success: false, error: 'location_mismatch' } };
    }
    if (tablesExist) {
      return upsertConfigPriceRule(client, {
        clientSlug,
        locationId: reqLoc,
        category: parsedCfg.category,
        offeringKey: parsedCfg.offering_key,
        unit: parsedCfg.unit,
        patch,
        actor,
      });
    }
    const result = locationStore.patchConfigPrice(
      reqLoc,
      parsedCfg.category,
      parsedCfg.offering_key,
      parsedCfg.unit,
      patch,
    );
    locationStore.appendLocationAudit(reqLoc, {
      action: 'update',
      entity_type: 'price_rule',
      entity_id: ruleId,
      actor_email: actor.email || 'unknown',
      after_json: result.body.price_rule,
    });
    return { ...result, body: { ...result.body, storage: 'location_store' } };
  }

  if (!tablesExist) {
    return { ok: false, status: 503, body: { success: false, error: 'admin_db_tables_missing' } };
  }

  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
  await client.query('BEGIN');
  try {
    const existing = await findPriceRuleRow(client, {
      clientSlug, locationId: reqLoc, ruleId, hasLoc,
    });
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
    }
    const before = existing.rows[0];
    const sets = [];
    const params = [];
    let idx = 3;
    const dbPatch = await applyPricePatchFields(client, before, patch, actor);
    for (const [key, value] of Object.entries(dbPatch)) {
      sets.push(`${key} = $${idx}`);
      params.push(value);
      idx += 1;
    }
    sets.push('updated_at = NOW()');
    sets.push(`updated_by = $${idx}::uuid`);
    params.push(actor.staff_user_id || null);

    const updated = await client.query(
      `UPDATE tenant_price_rules SET ${sets.join(', ')}
        WHERE id = $1::uuid AND client_slug = $2
        RETURNING *`,
      [ruleId, clientSlug, ...params],
    );
    const after = updated.rows[0];

    await insertConfigAudit(client, {
      tenantId: before.tenant_id,
      clientSlug,
      actor,
      action: 'update',
      entityType: 'price_rule',
      entityId: ruleId,
      beforeJson: rowToAuditJson(before),
      afterJson: rowToAuditJson(after),
    });

    await client.query('COMMIT');
    return { ok: true, status: 200, body: { success: true, price_rule: after, storage: 'db' } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function putLessonCapacityDefault(client, { clientSlug, locationId, capacity, actor }) {
  const tablesExist = await adminConfigTablesExist(client);
  const loc = normalizeSunsetLocationId(locationId);

  if (!tablesExist) {
    const result = locationStore.putLocationCapacity(loc, capacity);
    locationStore.appendLocationAudit(loc, {
      action: 'update',
      entity_type: 'capacity_rule',
      entity_id: loc,
      actor_email: actor.email || 'unknown',
      after_json: result.body.lesson_capacity,
    });
    return { ...result, body: { ...result.body, storage: 'location_store' } };
  }

  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_lesson_capacity_rules');
  await client.query('BEGIN');
  try {
    const existing = await client.query(
      hasLoc
        ? `SELECT * FROM tenant_lesson_capacity_rules
            WHERE client_slug = $1 AND location_id = $2 AND scope = 'default' AND active = true
            FOR UPDATE`
        : `SELECT * FROM tenant_lesson_capacity_rules
            WHERE client_slug = $1 AND scope = 'default' AND active = true
            FOR UPDATE`,
      hasLoc ? [clientSlug, loc] : [clientSlug],
    );

    let after;
    const before = existing.rows[0] || null;
    const tenantId = before ? before.tenant_id : 'sunset';

    if (before) {
      const updated = await client.query(
        `UPDATE tenant_lesson_capacity_rules
            SET capacity = $3, updated_at = NOW(), updated_by = $4::uuid
          WHERE id = $1::uuid AND client_slug = $2
          RETURNING *`,
        [before.id, clientSlug, capacity, actor.staff_user_id || null],
      );
      after = updated.rows[0];
    } else {
      const inserted = await client.query(
        hasLoc
          ? `INSERT INTO tenant_lesson_capacity_rules (
               tenant_id, client_slug, location_id, scope, weekday, service_date, capacity,
               active, updated_by
             ) VALUES ($1, $2, $3, 'default', NULL, NULL, $4, true, $5::uuid)
             RETURNING *`
          : `INSERT INTO tenant_lesson_capacity_rules (
               tenant_id, client_slug, scope, weekday, service_date, capacity,
               active, updated_by
             ) VALUES ($1, $2, 'default', NULL, NULL, $3, true, $4::uuid)
             RETURNING *`,
        hasLoc
          ? [tenantId, clientSlug, loc, capacity, actor.staff_user_id || null]
          : [tenantId, clientSlug, capacity, actor.staff_user_id || null],
      );
      after = inserted.rows[0];
    }

    await insertConfigAudit(client, {
      tenantId: after.tenant_id,
      clientSlug,
      actor,
      action: before ? 'update' : 'create',
      entityType: 'capacity_rule',
      entityId: after.id,
      beforeJson: rowToAuditJson(before),
      afterJson: rowToAuditJson(after),
    });

    await client.query('COMMIT');
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        lesson_capacity: { default_daily_cap: Number(after.capacity) },
        storage: 'db',
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function patchLessonTimeRule(client, { ruleId, clientSlug, locationId, patch, actor }) {
  const tablesExist = await adminConfigTablesExist(client);
  const loc = normalizeSunsetLocationId(locationId);

  if (locationStore.isConfigTimeId(ruleId) && !tablesExist) {
    const result = locationStore.patchLocationLessonTime(loc, ruleId, patch);
    locationStore.appendLocationAudit(loc, {
      action: 'update',
      entity_type: 'lesson_time_rule',
      entity_id: ruleId,
      actor_email: actor.email || 'unknown',
      after_json: result.body.lesson_time_rule,
    });
    return { ...result, body: { ...result.body, storage: 'location_store' } };
  }

  if (locationStore.isConfigTimeId(ruleId)) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: 'config_slot_use_db_uuid',
        message: 'Lesson time edits require DB-backed slot ids after admin tables exist',
      },
    };
  }

  if (!tablesExist) {
    return { ok: false, status: 503, body: { success: false, error: 'admin_db_tables_missing' } };
  }

  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_lesson_time_rules');
  const hasCapacity = await adminConfigTableHasColumn(client, 'tenant_lesson_time_rules', 'capacity');
  await client.query('BEGIN');
  try {
    const existing = await client.query(
      hasLoc
        ? `SELECT * FROM tenant_lesson_time_rules WHERE id = $1::uuid AND client_slug = $2 AND location_id = $3 FOR UPDATE`
        : `SELECT * FROM tenant_lesson_time_rules WHERE id = $1::uuid AND client_slug = $2 FOR UPDATE`,
      hasLoc ? [ruleId, clientSlug, loc] : [ruleId, clientSlug],
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
    }
    const before = existing.rows[0];
    const amountCentsPatch = patch.amount_cents;
    const priceLabelPatch = patch.label;
    const dbPatchLesson = { ...patch };
    delete dbPatchLesson.amount_cents;
    const nextStart = dbPatchLesson.time_local || String(before.time_local).slice(0, 5);
    const nextEndRaw = dbPatchLesson.time_local_end !== undefined ? dbPatchLesson.time_local_end : before.time_local_end;
    const nextEnd = nextEndRaw == null ? null : String(nextEndRaw).slice(0, 5);
    if (nextEnd && nextEnd <= nextStart) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, body: { success: false, error: 'time_local_end must be after time_local' } };
    }

    const sets = [];
    const params = [];
    let idx = 3;
    delete dbPatchLesson.kind;
    delete dbPatchLesson.age_band;
    delete dbPatchLesson.frequency;
    for (const [key, value] of Object.entries(dbPatchLesson)) {
      if (key === 'capacity' && !hasCapacity) continue;
      if (key === 'weekdays_active') {
        sets.push(`${key} = $${idx}::smallint[]`);
        params.push(value);
      } else if (key === 'capacity') {
        sets.push(`${key} = $${idx}::integer`);
        params.push(value);
      } else {
        sets.push(`${key} = $${idx}`);
        params.push(value);
      }
      idx += 1;
    }
    sets.push('updated_at = NOW()');
    sets.push(`updated_by = $${idx}::uuid`);
    params.push(actor.staff_user_id || null);

    const updated = await client.query(
      `UPDATE tenant_lesson_time_rules SET ${sets.join(', ')}
        WHERE id = $1::uuid AND client_slug = $2
        RETURNING *`,
      [ruleId, clientSlug, ...params],
    );
    const after = updated.rows[0];

    await insertConfigAudit(client, {
      tenantId: before.tenant_id,
      clientSlug,
      actor,
      action: 'update',
      entityType: 'lesson_time_rule',
      entityId: ruleId,
      beforeJson: rowToAuditJson(before),
      afterJson: rowToAuditJson(after),
    });

    await client.query('COMMIT');
    if (amountCentsPatch != null || priceLabelPatch != null) {
      await upsertLessonSlotPriceRule(client, {
        clientSlug,
        locationId: loc,
        slotId: after.id,
        label: priceLabelPatch || after.label,
        amountCents: amountCentsPatch != null ? amountCentsPatch : undefined,
        actor,
      });
    }
    return { ok: true, status: 200, body: { success: true, lesson_time_rule: after, storage: 'db' } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
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

async function createLessonTimeRule(client, { clientSlug, locationId, patch, actor }) {
  const tablesExist = await adminConfigTablesExist(client);
  const loc = normalizeSunsetLocationId(locationId);
  if (!tablesExist) {
    return { ok: false, status: 503, body: { success: false, error: 'admin_db_tables_missing' } };
  }
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_lesson_time_rules');
  const hasCapacity = await adminConfigTableHasColumn(client, 'tenant_lesson_time_rules', 'capacity');
  const amountCents = patch.amount_cents;
  const priceLabel = patch.label;
  const priceCurrency = patch.currency || 'EUR';
  const dbPatch = { ...patch };
  delete dbPatch.amount_cents;
  delete dbPatch.currency;
  await client.query('BEGIN');
  try {
    const tenantId = 'sunset';
    const columns = hasLoc
      ? ['tenant_id', 'client_slug', 'location_id', 'time_local', 'time_local_end', 'label', 'lesson_type', 'weekdays_active', 'active', 'updated_by']
      : ['tenant_id', 'client_slug', 'time_local', 'time_local_end', 'label', 'lesson_type', 'weekdays_active', 'active', 'updated_by'];
    const params = hasLoc
      ? [tenantId, clientSlug, loc, dbPatch.time_local, dbPatch.time_local_end || null, dbPatch.label, dbPatch.lesson_type, dbPatch.weekdays_active, dbPatch.active !== false, actor.staff_user_id || null]
      : [tenantId, clientSlug, dbPatch.time_local, dbPatch.time_local_end || null, dbPatch.label, dbPatch.lesson_type, dbPatch.weekdays_active, dbPatch.active !== false, actor.staff_user_id || null];
    if (hasCapacity && dbPatch.capacity != null) {
      columns.splice(columns.length - 1, 0, 'capacity');
      params.splice(params.length - 1, 0, dbPatch.capacity);
    }
    const cols = `(${columns.join(', ')})`;
    const vals = `(${params.map((_, i) => {
      const col = columns[i];
      if (col === 'time_local' || col === 'time_local_end') return `$${i + 1}::time`;
      if (col === 'weekdays_active') return `$${i + 1}::smallint[]`;
      if (col === 'updated_by') return `$${i + 1}::uuid`;
      if (col === 'capacity') return `$${i + 1}::integer`;
      return `$${i + 1}`;
    }).join(', ')})`;
    const inserted = await client.query(`INSERT INTO tenant_lesson_time_rules ${cols} VALUES ${vals} RETURNING *`, params);
    const after = inserted.rows[0];
    await insertConfigAudit(client, {
      tenantId: after.tenant_id,
      clientSlug,
      actor,
      action: 'create',
      entityType: 'lesson_time_rule',
      entityId: after.id,
      beforeJson: null,
      afterJson: rowToAuditJson(after),
    });
    await client.query('COMMIT');
    if (amountCents != null) {
      await upsertLessonSlotPriceRule(client, {
        clientSlug,
        locationId: loc,
        slotId: after.id,
        label: priceLabel,
        amountCents,
        currency: priceCurrency,
        actor,
      });
    }
    return { ok: true, status: 201, body: { success: true, lesson_time_rule: after, storage: 'db' } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function deactivateLessonTimeRule(client, { ruleId, clientSlug, locationId, actor }) {
  const tablesExist = await adminConfigTablesExist(client);
  const loc = normalizeSunsetLocationId(locationId);
  if (!tablesExist) {
    return { ok: false, status: 503, body: { success: false, error: 'admin_db_tables_missing' } };
  }
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_lesson_time_rules');
  await client.query('BEGIN');
  try {
    const existing = await client.query(
      hasLoc
        ? `SELECT * FROM tenant_lesson_time_rules WHERE id = $1::uuid AND client_slug = $2 AND location_id = $3 AND active = true FOR UPDATE`
        : `SELECT * FROM tenant_lesson_time_rules WHERE id = $1::uuid AND client_slug = $2 AND active = true FOR UPDATE`,
      hasLoc ? [ruleId, clientSlug, loc] : [ruleId, clientSlug],
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
    }
    const before = existing.rows[0];
    const updated = await client.query(
      hasLoc
        ? `UPDATE tenant_lesson_time_rules
            SET active = false, updated_at = NOW(), updated_by = $4::uuid
          WHERE id = $1::uuid AND client_slug = $2 AND location_id = $3
          RETURNING *`
        : `UPDATE tenant_lesson_time_rules
            SET active = false, updated_at = NOW(), updated_by = $3::uuid
          WHERE id = $1::uuid AND client_slug = $2
          RETURNING *`,
      hasLoc ? [ruleId, clientSlug, loc, actor.staff_user_id || null] : [ruleId, clientSlug, actor.staff_user_id || null],
    );
    const after = updated.rows[0];
    await insertConfigAudit(client, {
      tenantId: before.tenant_id,
      clientSlug,
      actor,
      action: 'deactivate',
      entityType: 'lesson_time_rule',
      entityId: ruleId,
      beforeJson: rowToAuditJson(before),
      afterJson: rowToAuditJson(after),
    });
    await client.query('COMMIT');
    return { ok: true, status: 200, body: { success: true, lesson_time_rule: after, storage: 'db' } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  SUNSET_ADMIN_CLIENT,
  ADMIN_WRITE_MIN_ROLE,
  isSunsetAdminWritesEnabled,
  writesDisabledResponse,
  evaluateAdminWriteGate,
  validateUuid,
  validatePricePatchBody,
  validateLessonCapacityBody,
  validateLessonTimeCreateBody,
  validateLessonTimePatchBody,
  validatePriceCreateBody,
  createRentalPriceRule,
  deactivatePriceRule,
  parseItemCodeParts,
  patchPriceRule,
  upsertConfigPriceRule,
  putLessonCapacityDefault,
  createLessonTimeRule,
  patchLessonTimeRule,
  deactivateLessonTimeRule,
  buildDbItemCode,
  mapBaselineUnitToDb,
};
