#!/usr/bin/env python3
"""Sunset Admin UI v2: compact rentals, lesson cards with price/age/frequency."""
from pathlib import Path
import re

ROOT = Path('/opt/wolfhouse/WH')

# ── tenant-admin-writes.js ───────────────────────────────────────────────────
writes = (ROOT / 'scripts/lib/tenant-admin-writes.js').read_text(encoding='utf-8')

OLD_PERIODS = "const RENTAL_PERIOD_WINDOWS = new Set(['1_hour', 'half_day', '1_day', '2_days', '5_days', '7_days']);"
NEW_PERIODS = "const RENTAL_PERIOD_WINDOWS = new Set(['1_hour', '2_hours', 'half_day', '1_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days']);"
if OLD_PERIODS in writes:
    writes = writes.replace(OLD_PERIODS, NEW_PERIODS)

LESSON_CONSTS = """
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
"""

if 'const LESSON_KINDS' not in writes:
    writes = writes.replace('const LESSON_TIME_PATCH_FIELDS', LESSON_CONSTS + '\nconst LESSON_TIME_PATCH_FIELDS')

PATCH_FIELDS_OLD = """const LESSON_TIME_PATCH_FIELDS = new Set([
  'label',
  'time_local',
  'time_local_end',
  'lesson_type',
  'weekdays_active',
  'active',
  'capacity',
]);"""
PATCH_FIELDS_NEW = """const LESSON_TIME_PATCH_FIELDS = new Set([
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
]);"""
writes = writes.replace(PATCH_FIELDS_OLD, PATCH_FIELDS_NEW)

# Extend validateLessonTimeCreateBody
create_marker = "  out.active = body.active !== false;\n  return { ok: true, patch: out };\n}"
create_insert = """  out.active = body.active !== false;
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
}"""
if 'amount_cents required' not in writes:
    writes = writes.replace(create_marker, create_insert, 1)

# Extend validateLessonTimePatchBody before final return
patch_marker = """  if (!Object.keys(out).length) return { ok: false, error: 'empty body' };

  if (out.time_local && out.time_local_end && out.time_local_end <= out.time_local) {
    return { ok: false, error: 'time_local_end must be after time_local' };
  }
  return { ok: true, patch: out };
}"""
patch_insert = """  if (!Object.keys(out).length) return { ok: false, error: 'empty body' };

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

  if (out.time_local && out.time_local_end && out.time_local_end <= out.time_local) {
    return { ok: false, error: 'time_local_end must be after time_local' };
  }
  return { ok: true, patch: out };
}"""
if 'parseLessonTypeValue(body.lesson_type' not in writes:
    writes = writes.replace(patch_marker, patch_insert, 1)

UPSERT_LESSON_PRICE = """
async function upsertLessonSlotPriceRule(client, {
  clientSlug, locationId, slotId, label, amountCents, currency, actor,
}) {
  const itemCode = lessonSlotPriceItemCode(slotId);
  return upsertConfigPriceRule(client, {
    clientSlug,
    locationId,
    category: 'lesson',
    offeringKey: itemCode,
    unit: 'session',
    patch: {
      display_name: label,
      amount_cents: amountCents,
      currency: currency || 'EUR',
    },
    actor,
    forceItemCode: itemCode,
    forceDbUnit: 'session',
  });
}
"""

if 'upsertLessonSlotPriceRule' not in writes:
    writes = writes.replace('async function createRentalPriceRule', UPSERT_LESSON_PRICE + '\nasync function createRentalPriceRule')

# createLessonTimeRule - save amount before delete, upsert price after insert
if 'upsertLessonSlotPriceRule(client' not in writes.split('async function createLessonTimeRule')[1].split('async function deactivateLessonTimeRule')[0]:
    writes = writes.replace(
        "  await client.query('BEGIN');\n  try {\n    const tenantId = 'sunset';\n    const columns = hasLoc",
        "  const amountCents = patch.amount_cents;\n  const priceLabel = patch.label;\n  const priceCurrency = patch.currency || 'EUR';\n  const dbPatch = { ...patch };\n  delete dbPatch.amount_cents;\n  delete dbPatch.currency;\n  await client.query('BEGIN');\n  try {\n    const tenantId = 'sunset';\n    const columns = hasLoc",
        1,
    )
    writes = writes.replace(
        "? [tenantId, clientSlug, loc, patch.time_local, patch.time_local_end || null, patch.label, patch.lesson_type, patch.weekdays_active, patch.active !== false, actor.staff_user_id || null]\n      : [tenantId, clientSlug, patch.time_local, patch.time_local_end || null, patch.label, patch.lesson_type, patch.weekdays_active, patch.active !== false, actor.staff_user_id || null];",
        "? [tenantId, clientSlug, loc, dbPatch.time_local, dbPatch.time_local_end || null, dbPatch.label, dbPatch.lesson_type, dbPatch.weekdays_active, dbPatch.active !== false, actor.staff_user_id || null]\n      : [tenantId, clientSlug, dbPatch.time_local, dbPatch.time_local_end || null, dbPatch.label, dbPatch.lesson_type, dbPatch.weekdays_active, dbPatch.active !== false, actor.staff_user_id || null];",
        1,
    )
    writes = writes.replace(
        "    if (hasCapacity && patch.capacity != null) {\n      columns.splice(columns.length - 1, 0, 'capacity');\n      params.splice(params.length - 1, 0, patch.capacity);",
        "    if (hasCapacity && dbPatch.capacity != null) {\n      columns.splice(columns.length - 1, 0, 'capacity');\n      params.splice(params.length - 1, 0, dbPatch.capacity);",
        1,
    )
    writes = writes.replace(
        "    await client.query('COMMIT');\n    return { ok: true, status: 201, body: { success: true, lesson_time_rule: after, storage: 'db' } };\n  } catch (err) {\n    await client.query('ROLLBACK');\n    throw err;\n  }\n}\n\nasync function deactivateLessonTimeRule",
        "    await client.query('COMMIT');\n    if (amountCents != null) {\n      await upsertLessonSlotPriceRule(client, {\n        clientSlug,\n        locationId: loc,\n        slotId: after.id,\n        label: priceLabel,\n        amountCents,\n        currency: priceCurrency,\n        actor,\n      });\n    }\n    return { ok: true, status: 201, body: { success: true, lesson_time_rule: after, storage: 'db' } };\n  } catch (err) {\n    await client.query('ROLLBACK');\n    throw err;\n  }\n}\n\nasync function deactivateLessonTimeRule",
        1,
    )

# patchLessonTimeRule - upsert price when amount or label changes
if 'amountCentsPatch' not in writes:
    writes = writes.replace(
        "    const before = existing.rows[0];\n    const nextStart = patch.time_local || String(before.time_local).slice(0, 5);",
        "    const before = existing.rows[0];\n    const amountCentsPatch = patch.amount_cents;\n    const priceLabelPatch = patch.label;\n    const dbPatchLesson = { ...patch };\n    delete dbPatchLesson.amount_cents;\n    const nextStart = dbPatchLesson.time_local || String(before.time_local).slice(0, 5);",
        1,
    )
    writes = writes.replace(
        "    const nextEndRaw = patch.time_local_end !== undefined ? patch.time_local_end : before.time_local_end;",
        "    const nextEndRaw = dbPatchLesson.time_local_end !== undefined ? dbPatchLesson.time_local_end : before.time_local_end;",
        1,
    )
    writes = writes.replace(
        "    for (const [key, value] of Object.entries(patch)) {",
        "    for (const [key, value] of Object.entries(dbPatchLesson)) {",
        1,
    )
    writes = writes.replace(
        "    const after = updated.rows[0];\n\n    await insertConfigAudit(client, {\n      tenantId: before.tenant_id,\n      clientSlug,\n      actor,\n      action: 'update',\n      entityType: 'lesson_time_rule',\n      entityId: ruleId,\n      beforeJson: rowToAuditJson(before),\n      afterJson: rowToAuditJson(after),\n    });\n\n    await client.query('COMMIT');\n    return { ok: true, status: 200, body: { success: true, lesson_time_rule: after, storage: 'db' } };\n  } catch (err) {\n    await client.query('ROLLBACK');\n    throw err;\n  }\n}\n\n\n\nasync function adminConfigTableHasColumn",
        "    const after = updated.rows[0];\n\n    await insertConfigAudit(client, {\n      tenantId: before.tenant_id,\n      clientSlug,\n      actor,\n      action: 'update',\n      entityType: 'lesson_time_rule',\n      entityId: ruleId,\n      beforeJson: rowToAuditJson(before),\n      afterJson: rowToAuditJson(after),\n    });\n\n    await client.query('COMMIT');\n    if (amountCentsPatch != null || priceLabelPatch != null) {\n      await upsertLessonSlotPriceRule(client, {\n        clientSlug,\n        locationId: loc,\n        slotId: after.id,\n        label: priceLabelPatch || after.label,\n        amountCents: amountCentsPatch != null ? amountCentsPatch : undefined,\n        actor,\n      });\n    }\n    return { ok: true, status: 200, body: { success: true, lesson_time_rule: after, storage: 'db' } };\n  } catch (err) {\n    await client.query('ROLLBACK');\n    throw err;\n  }\n}\n\n\n\nasync function adminConfigTableHasColumn",
        1,
    )

# Fix upsertLessonSlotPrice when amountCents undefined on patch - need to fetch existing price amount
# Simpler: require amount_cents on patch when provided; upsert only when amountCentsPatch != null OR priceLabelPatch
# For label-only update, still call upsert with existing amount - need read first. Skip label-only upsert if no amount.
# Actually patch handler passes amountCents only when user sends it - label change should update display_name on price.
# Update upsertLessonSlotPriceRule to handle partial - read existing amount if missing.

UPSERT_FIX = """
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
"""
writes = re.sub(
    r'async function upsertLessonSlotPriceRule[\s\S]*?\n}\n\nasync function createRentalPriceRule',
    UPSERT_FIX + '\nasync function createRentalPriceRule',
    writes,
    count=1,
)

(ROOT / 'scripts/lib/tenant-admin-writes.js').write_text(writes, encoding='utf-8')
print('OK tenant-admin-writes.js')

# ── tenant-business-config.js ───────────────────────────────────────────────
tbc = (ROOT / 'scripts/lib/tenant-business-config.js').read_text(encoding='utf-8')

TBC_HELPERS = """
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
"""

if 'function parseAdminLessonType' not in tbc:
    tbc = tbc.replace('function mapLessonTimeRows(rows) {', TBC_HELPERS + '\nfunction mapLessonTimeRows(rows) {')

MAP_OLD = """function mapLessonTimeRows(rows) {
  return rows.map((row) => ({
    slot_id: row.id ? String(row.id) : null,
    date: formatPgDate(row.service_date),
    slot_time: formatLessonSlotTime(row.time_local, row.time_local_end),
    offering_label: row.label || null,
    session_type: row.lesson_type || null,
    capacity: null,
    weekdays_active: Array.isArray(row.weekdays_active) ? row.weekdays_active : [],
    source: 'db',
  }));
}"""
MAP_NEW = """function mapLessonTimeRows(rows) {
  return rows.map((row) => {
    const parsed = parseAdminLessonType(row.lesson_type);
    return {
      slot_id: row.id ? String(row.id) : null,
      date: formatPgDate(row.service_date),
      slot_time: formatLessonSlotTime(row.time_local, row.time_local_end),
      offering_label: row.label || null,
      session_type: row.lesson_type || null,
      kind: parsed.kind,
      age_band: parsed.age_band,
      capacity: row.capacity != null ? Number(row.capacity) : null,
      weekdays_active: Array.isArray(row.weekdays_active) ? row.weekdays_active : [],
      frequency: detectLessonFrequency(row.weekdays_active),
      source: 'db',
    };
  });
}"""
tbc = tbc.replace(MAP_OLD, MAP_NEW)

tbc = tbc.replace(
    "  const lesson_times = mapLessonTimeRows(timeRes.rows);",
    "  const lesson_times = attachLessonPrices(mapLessonTimeRows(timeRes.rows), prices);",
)

tbc = tbc.replace(
    "  const lesson_times = dbResult.lesson_times.length ? dbResult.lesson_times : configBaseline.lesson_times;",
    "  const lesson_timesRaw = dbResult.lesson_times.length ? dbResult.lesson_times : configBaseline.lesson_times;\n  const lesson_times = attachLessonPrices(lesson_timesRaw, prices);",
)

if 'attachLessonPrices,' not in tbc and 'module.exports' in tbc:
    tbc = tbc.replace('module.exports = {', 'module.exports = {\n  attachLessonPrices,\n  parseAdminLessonType,\n')

(ROOT / 'scripts/lib/tenant-business-config.js').write_text(tbc, encoding='utf-8')
print('OK tenant-business-config.js')

# ── staff-portal-i18n.js ────────────────────────────────────────────────────
i18n = (ROOT / 'scripts/lib/staff-portal-i18n.js').read_text(encoding='utf-8')
I18N_ADD = """
    'admin.period.2_hours': '2h',
    'admin.period.3_days': '3 day',
    'admin.period.4_days': '4 day',
    'admin.period.6_days': '6 day',
    'admin.lesson.kind.lesson': 'Lesson',
    'admin.lesson.kind.pack': 'Pack',
    'admin.lesson.age.all_ages': 'All ages',
    'admin.lesson.age.6_and_up': '6 and up',
    'admin.lesson.age.6_to_11': '6 to 11',
    'admin.lesson.age.12_and_up': '12 and up',
    'admin.lesson.frequency.daily': 'Daily',
    'admin.lesson.frequency.sat_sun': 'Sat + Sun',
    'admin.lesson.frequency.mon_fri': 'Mon–Fri',
    'admin.edit.cost': 'Cost (EUR)',
    'admin.edit.kind': 'Type',
    'admin.edit.age': 'Age',
    'admin.edit.frequency': 'Frequency',
    'admin.action.add': 'Add',
"""
if "'admin.period.2_hours'" not in i18n:
    i18n = i18n.replace("'admin.period.1_hour': '1 hour',", "'admin.period.1_hour': '1h',\n" + I18N_ADD)
    i18n = i18n.replace("'admin.period.half_day': 'Half day',", "'admin.period.half_day': '3h / half day',")
    i18n = i18n.replace("'admin.period.1_day': '1 day',", "'admin.period.1_day': '1 day',")
    i18n = i18n.replace("'admin.period.2_days': '2 days',", "'admin.period.2_days': '2 day',")
    i18n = i18n.replace("'admin.period.5_days': '5 days',", "'admin.period.5_days': '5 day',")
    i18n = i18n.replace("'admin.period.7_days': '7 days',", "'admin.period.7_days': '7 day',")
(ROOT / 'scripts/lib/staff-portal-i18n.js').write_text(i18n, encoding='utf-8')
print('OK staff-portal-i18n.js')

# ── staff-query-api.js ──────────────────────────────────────────────────────
api = (ROOT / 'scripts/staff-query-api.js').read_text(encoding='utf-8')

CSS_OLD = ".portal-admin-card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;margin-top:8px}"
CSS_NEW = ".portal-admin-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:6px;margin-top:6px}"
api = api.replace(CSS_OLD, CSS_NEW)

CSS_CARD = ".portal-admin-price-card,.portal-admin-lesson-card{border:1px solid var(--border-soft);border-radius:10px;background:var(--surface-soft);padding:9px 10px;display:flex;flex-direction:column;gap:7px;min-height:0}"
CSS_CARD_NEW = ".portal-admin-price-card,.portal-admin-lesson-card{border:1px solid var(--border-soft);border-radius:8px;background:var(--surface-soft);padding:6px 8px;display:flex;flex-direction:column;gap:4px;min-height:0}"
api = api.replace(CSS_CARD, CSS_CARD_NEW)

CSS_AMT = ".portal-admin-price-amount,.portal-admin-lesson-time{font-size:16px;font-weight:850;color:var(--text);white-space:nowrap;text-align:right}"
CSS_AMT_NEW = ".portal-admin-price-amount,.portal-admin-lesson-time{font-size:14px;font-weight:850;color:var(--text);white-space:nowrap}.portal-admin-price-card-readout{display:flex;align-items:baseline;justify-content:space-between;gap:6px;width:100%}.portal-admin-price-period{font-size:14px;font-weight:850;color:var(--text);line-height:1.2}.portal-admin-subsection-title-row .portal-admin-icon-btn{font-size:10px;padding:1px 6px;min-width:0;line-height:1.4}.portal-admin-subsection-title-row .portal-admin-card-actions{gap:2px}"
api = api.replace(CSS_AMT, CSS_AMT_NEW)

# Replace adminRentalPeriodOptions
PERIOD_FN = """function adminRentalPeriodOptions(selected){
  var opts = ['1_hour', '2_hours', 'half_day', '1_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days'];
  return opts.map(function(p){
    var sel = (selected === p) ? ' selected' : '';
    return '<option value="' + escHtml(p) + '"' + sel + '>' + escHtml(adminPeriodLabel(p)) + '</option>';
  }).join('');
}"""
api = re.sub(
    r'function adminRentalPeriodOptions\(selected\)\{[\s\S]*?\n\}',
    PERIOD_FN.rstrip('}') + '}',
    api,
    count=1,
)

# Remove lesson price strip usage - replace adminRenderLessonPriceStrip with empty
api = re.sub(
    r'function adminRenderLessonPriceStrip\(prices\)\{[\s\S]*?\n\}\n\nfunction adminRentalGroupOrder',
    'function adminRentalGroupOrder',
    api,
    count=1,
)

# Lesson helpers before adminRentalGroupOrder
LESSON_UI_HELPERS = """
function adminLessonKindOptions(selected){
  return ['lesson', 'pack'].map(function(k){
    var sel = (selected === k) ? ' selected' : '';
    return '<option value="' + escHtml(k) + '"' + sel + '>' + escHtml(portalT('admin.lesson.kind.' + k)) + '</option>';
  }).join('');
}

function adminLessonAgeOptions(selected){
  return ['all_ages', '6_and_up', '6_to_11', '12_and_up'].map(function(a){
    var sel = (selected === a) ? ' selected' : '';
    return '<option value="' + escHtml(a) + '"' + sel + '>' + escHtml(portalT('admin.lesson.age.' + a)) + '</option>';
  }).join('');
}

function adminLessonFrequencyOptions(selected){
  return ['daily', 'sat_sun', 'mon_fri'].map(function(f){
    var sel = (selected === f) ? ' selected' : '';
    return '<option value="' + escHtml(f) + '"' + sel + '>' + escHtml(portalT('admin.lesson.frequency.' + f)) + '</option>';
  }).join('');
}

function adminLessonFrequencyLabel(freq){
  var key = String(freq || 'daily');
  var tKey = 'admin.lesson.frequency.' + key;
  var label = portalT(tKey);
  return label === tKey ? key : label;
}

function adminLessonAgeLabel(age){
  var key = String(age || 'all_ages');
  var tKey = 'admin.lesson.age.' + key;
  var label = portalT(tKey);
  return label === tKey ? key : label;
}

function adminLessonKindLabel(kind){
  var key = String(kind || 'lesson');
  var tKey = 'admin.lesson.kind.' + key;
  var label = portalT(tKey);
  return label === tKey ? key : label;
}

function adminResolveLessonSlotFields(s){
  return {
    kind: s.kind || 'lesson',
    age_band: s.age_band || 'all_ages',
    frequency: s.frequency || 'daily',
    price_amount: s.price_amount != null ? s.price_amount : null,
  };
}

"""
if 'function adminLessonKindOptions' not in api:
    api = api.replace('function adminRentalGroupOrder(){', LESSON_UI_HELPERS + 'function adminRentalGroupOrder(){')

# Fix rental category header buttons and card layout
RENTAL_HEADER_OLD = """        if (!groupEditing){
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-price-group" data-price-group="' +
            escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.edit')) + '">???</button>';
        } else {
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.done')) + '</button>';
        }
        if (!adding){
          html += '<button type="button" class="btn btn-primary portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-price" data-price-group="' +
            escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.addRental')) + '">+</button>';
        }"""
RENTAL_HEADER_NEW = """        html += '<div class="portal-admin-card-actions">';
        if (!groupEditing){
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-price-group" data-price-group="' +
            escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.edit')) + '">✎</button>';
        } else {
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.done')) + '</button>';
        }
        if (!adding && !groupEditing){
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-price" data-price-group="' +
            escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button>';
        }
        html += '</div>';"""
if '✎</button>' not in api.split('renderAdminSectionPricesFromConfig')[1].split('renderAdminSectionCapacityFromConfig')[0]:
    api = api.replace(RENTAL_HEADER_OLD, RENTAL_HEADER_NEW)

# Fix rental card body
RENTAL_CARD_OLD = """        var cardTitle = adminPriceGroupTitle(key);
        html += '<article class="portal-admin-price-card" data-admin-price-card="' + escHtml(pid) + '">';
        html += '<div class="portal-admin-card-title-row"><div><div class="portal-admin-price-title">' + escHtml(cardTitle) + '</div>' +
          '<div class="portal-admin-price-meta">' + escHtml(adminPeriodLabel(parsed.periodWindow)) + '</div></div>';
        if (groupEditing && pid){
          html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-admin-action="delete-price" data-price-id="' +
            escHtml(pid) + '" aria-label="' + escHtml(portalT('admin.action.remove')) + '">??</button></div>';
        }
        html += '</div>';
        if (groupEditing && pid){
          html += renderAdminPriceCardEditForm(pid, p, key);
        } else {
          html += '<div class="portal-admin-price-amount">' + escHtml(adminEurosFromAmount(p.amount) + ' ' + (p.currency || 'EUR')) + '</div>';
        }
        html += '</article>';"""
RENTAL_CARD_NEW = """        html += '<article class="portal-admin-price-card" data-admin-price-card="' + escHtml(pid) + '">';
        if (groupEditing && pid){
          html += '<div class="portal-admin-card-title-row"><div></div><div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-admin-action="delete-price" data-price-id="' +
            escHtml(pid) + '" aria-label="' + escHtml(portalT('admin.action.remove')) + '">×</button></div></div>';
          html += renderAdminPriceCardEditForm(pid, p, key);
        } else {
          html += '<div class="portal-admin-price-card-readout"><span class="portal-admin-price-period">' + escHtml(adminPeriodLabel(parsed.periodWindow)) + '</span>' +
            '<span class="portal-admin-price-amount">' + escHtml(adminEurosFromAmount(p.amount) + ' ' + (p.currency || 'EUR')) + '</span></div>';
        }
        html += '</article>';"""
if 'portal-admin-price-card-readout' not in api.split('renderAdminSectionPricesFromConfig')[1].split('renderAdminSectionCapacityFromConfig')[0]:
    api = api.replace(RENTAL_CARD_OLD, RENTAL_CARD_NEW)

# Fix subsection title row structure - move actions inside title row properly
api = api.replace(
    "html += '<div class=\"portal-admin-subsection-title-row\"><h3 class=\"portal-admin-subsection-title\">' + escHtml(adminPriceGroupTitle(key)) + '</h3>';",
    "html += '<div class=\"portal-admin-subsection-title-row\"><h3 class=\"portal-admin-subsection-title\">' + escHtml(adminPriceGroupTitle(key)) + '</h3>';",
)

# Replace lesson time edit/add forms and section render
TIME_EDIT_OLD = """function renderAdminTimeEditForm(sid, s){
  var defaultCap = (adminConfigCache && adminConfigCache.lesson_capacity && adminConfigCache.lesson_capacity.default_daily_cap != null)
    ? adminConfigCache.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  return '<div class="portal-admin-edit-form">' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
    '<input type="text" id="admin-time-label" value="' + escHtml(adminHumanizeText(s.offering_label || s.session_type || '')) + '" maxlength="120"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.startTime')) + '</label>' +
    '<input type="text" id="admin-time-start" value="' + escHtml(adminSlotTimeStart(s.slot_time)) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.endTime')) + '</label>' +
    '<input type="text" id="admin-time-end" value="' + escHtml(adminSlotTimeEnd(s.slot_time)) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.capacity')) + '</label>' +
    '<input type="number" id="admin-time-capacity" min="1" max="999" step="1" value="' + escHtml(s.capacity != null ? String(s.capacity) : String(defaultCap)) + '"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-time" data-time-id="' + escHtml(sid) + '">' +
    escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}"""

TIME_EDIT_NEW = """function renderAdminTimeEditForm(sid, s){
  var defaultCap = (adminConfigCache && adminConfigCache.lesson_capacity && adminConfigCache.lesson_capacity.default_daily_cap != null)
    ? adminConfigCache.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  var fields = adminResolveLessonSlotFields(s);
  return '<div class="portal-admin-edit-form">' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
    '<input type="text" id="admin-time-label" value="' + escHtml(adminHumanizeText(s.offering_label || '')) + '" maxlength="120"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.kind')) + '</label>' +
    '<select id="admin-time-kind">' + adminLessonKindOptions(fields.kind) + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.capacity')) + '</label>' +
    '<input type="number" id="admin-time-capacity" min="1" max="999" step="1" value="' + escHtml(s.capacity != null ? String(s.capacity) : String(defaultCap)) + '"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.startTime')) + '</label>' +
    '<input type="text" id="admin-time-start" value="' + escHtml(adminSlotTimeStart(s.slot_time)) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.endTime')) + '</label>' +
    '<input type="text" id="admin-time-end" value="' + escHtml(adminSlotTimeEnd(s.slot_time)) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.age')) + '</label>' +
    '<select id="admin-time-age">' + adminLessonAgeOptions(fields.age_band) + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.frequency')) + '</label>' +
    '<select id="admin-time-frequency">' + adminLessonFrequencyOptions(fields.frequency) + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.cost')) + '</label>' +
    '<input type="text" id="admin-time-cost" value="' + escHtml(fields.price_amount != null ? adminEurosFromAmount(fields.price_amount) : '') + '" inputmode="decimal"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-time" data-time-id="' + escHtml(sid) + '">' +
    escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}"""
api = api.replace(TIME_EDIT_OLD, TIME_EDIT_NEW)

ADD_TIME_OLD = """function renderAdminAddTimeForm(){
  return '<div class="portal-admin-edit-form" id="admin-add-time-form">' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
    '<input type="text" id="admin-new-time-label" value="Group surf lesson" maxlength="120"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.startTime')) + '</label>' +
    '<input type="text" id="admin-new-time-start" value="" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.endTime')) + '</label>' +
    '<input type="text" id="admin-new-time-end" value="" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.capacity')) + '</label>' +
    '<input type="number" id="admin-new-time-capacity" min="1" max="999" step="1" value="24"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-new-time">' + escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}"""

ADD_TIME_NEW = """function renderAdminAddTimeForm(){
  var defaultCap = (adminConfigCache && adminConfigCache.lesson_capacity && adminConfigCache.lesson_capacity.default_daily_cap != null)
    ? adminConfigCache.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  return '<div class="portal-admin-edit-form" id="admin-add-time-form">' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
    '<input type="text" id="admin-new-time-label" value="" maxlength="120" placeholder="Group surf lesson"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.kind')) + '</label>' +
    '<select id="admin-new-time-kind">' + adminLessonKindOptions('lesson') + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.capacity')) + '</label>' +
    '<input type="number" id="admin-new-time-capacity" min="1" max="999" step="1" value="' + escHtml(String(defaultCap)) + '"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.startTime')) + '</label>' +
    '<input type="text" id="admin-new-time-start" value="" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.endTime')) + '</label>' +
    '<input type="text" id="admin-new-time-end" value="" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.age')) + '</label>' +
    '<select id="admin-new-time-age">' + adminLessonAgeOptions('all_ages') + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.frequency')) + '</label>' +
    '<select id="admin-new-time-frequency">' + adminLessonFrequencyOptions('daily') + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.cost')) + '</label>' +
    '<input type="text" id="admin-new-time-cost" value="" inputmode="decimal" placeholder="0.00"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-new-time">' + escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}"""
api = api.replace(ADD_TIME_OLD, ADD_TIME_NEW)

# Replace renderAdminSectionLessonTimesFromConfig
LESSON_SECTION_OLD = re.search(
    r'function renderAdminSectionLessonTimesFromConfig\(cfg\)\{[\s\S]*?\n\}\n\nfunction renderAdminSectionBusinessInfoFromConfig',
    api,
)
if LESSON_SECTION_OLD:
    LESSON_SECTION_NEW = """function renderAdminSectionLessonTimesFromConfig(cfg){
  var box = el('admin-times-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var slots = (cfg && cfg.lesson_times) ? cfg.lesson_times : [];
  var defaultCap = (cfg && cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap != null)
    ? cfg.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  var html = '<div class="portal-admin-subsection"><div class="portal-admin-subsection-title-row"><h3 class="portal-admin-subsection-title">' + escHtml(portalT('admin.lessonTimes.scheduleTitle')) + '</h3>';
  if (writes && !adminEditTarget){
    html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-time" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button></div>';
  }
  html += '</div><p class="portal-admin-muted">' + escHtml(portalT('admin.lessonTimes.help')) + '</p>';
  if (writes && adminEditTarget === 'time:new') html += renderAdminAddTimeForm();
  if (!slots.length && adminEditTarget !== 'time:new'){
    html += '<p class="portal-admin-muted">' + escHtml(portalT('admin.lessonTimes.placeholder')) + '</p></div>';
    box.innerHTML = html;
    return;
  }
  html += '<div class="portal-admin-compact-grid" id="admin-lesson-card-grid">';
  slots.forEach(function(s){
    var sid = s.slot_id ? String(s.slot_id) : '';
    var editing = writes && adminEditTarget === ('time:' + sid);
    var label = adminHumanizeText(s.offering_label || 'Lesson');
    var fields = adminResolveLessonSlotFields(s);
    var capText = s.capacity != null ? String(s.capacity) : String(defaultCap);
    var duration = adminSlotDurationLabel(s.slot_time);
    var costText = fields.price_amount != null ? (adminEurosFromAmount(fields.price_amount) + ' ' + (s.price_currency || 'EUR')) : '—';
    html += '<article class="portal-admin-lesson-card" data-admin-lesson-card="' + escHtml(sid) + '">';
    html += '<div class="portal-admin-card-title-row"><div><div class="portal-admin-lesson-title">' + escHtml(label) + '</div>' +
      '<div class="portal-admin-lesson-meta">' + escHtml(adminLessonKindLabel(fields.kind)) + ' · ' + escHtml(adminLessonFrequencyLabel(fields.frequency)) + '</div></div>';
    if (writes && !editing && (!adminEditTarget || adminEditTarget.indexOf('time:') !== 0)){
      html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-time" data-time-id="' +
        escHtml(sid) + '" aria-label="' + escHtml(portalT('admin.action.edit')) + '">✎</button>' +
        '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-admin-action="delete-time" data-time-id="' +
        escHtml(sid) + '" aria-label="' + escHtml(portalT('admin.action.remove')) + '">×</button></div>';
    }
    html += '</div>';
    if (editing){
      html += renderAdminTimeEditForm(sid, s);
    } else {
      html += '<div class="portal-admin-lesson-facts">' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.capacity')) + '<strong>' + escHtml(capText + ' ' + portalT('admin.lessonTimes.seats')) + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.duration')) + '<strong>' + escHtml(duration) + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.startTime')) + '<strong>' + escHtml(adminSlotTimeStart(s.slot_time) || '—') + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.age')) + '<strong>' + escHtml(adminLessonAgeLabel(fields.age_band)) + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.cost')) + '<strong>' + escHtml(costText) + '</strong></div>' +
        '</div>';
    }
    html += '</article>';
  });
  html += '</div></div>';
  box.innerHTML = html;
}

function renderAdminSectionBusinessInfoFromConfig"""
    api = api[:LESSON_SECTION_OLD.start()] + LESSON_SECTION_NEW + api[LESSON_SECTION_OLD.end():]

# Fix save-price handler
SAVE_PRICE_OLD = """    if (action === 'save-price'){
      var priceId = String(btn.getAttribute('data-price-id') || '');
      var nameInput = el('admin-price-display-name');
      var amountInput = el('admin-price-amount-eur');
      var name = nameInput ? String(nameInput.value || '').trim() : '';
      if (!name){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var centsParsed = adminParseEurosToCents(amountInput && amountInput.value);
      if (!centsParsed.ok){ adminShowMessage('error', centsParsed.error); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(priceId) + adminClientQuery(), {
        display_name: name,
        amount_cents: centsParsed.value,
      }).then(function(res){"""
SAVE_PRICE_NEW = """    if (action === 'save-price'){
      var priceId = String(btn.getAttribute('data-price-id') || '');
      var periodInput = el('admin-price-period-' + priceId);
      var amountInput = el('admin-price-amount-' + priceId);
      var period = periodInput ? String(periodInput.value || '').trim() : '';
      if (!period){ adminShowMessage('error', portalT('admin.edit.periodRequired')); return; }
      var centsParsed = adminParseEurosToCents(amountInput && amountInput.value);
      if (!centsParsed.ok){ adminShowMessage('error', centsParsed.error); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(priceId) + adminClientQuery(), {
        period_window: period,
        amount_cents: centsParsed.value,
      }).then(function(res){"""
api = api.replace(SAVE_PRICE_OLD, SAVE_PRICE_NEW)

# Fix save-time and save-new-time payloads
SAVE_TIME_OLD = """      adminApiRequest('PATCH', '/staff/admin/config/lesson-times/' + encodeURIComponent(timeId) + adminClientQuery(), {
        label: label,
        time_local: timeParsed.value,
        time_local_end: endParsed.value,
        capacity: capacityParsed.value,
      }).then(function(res){"""
SAVE_TIME_NEW = """      var kindInput = el('admin-time-kind');
      var ageInput = el('admin-time-age');
      var freqInput = el('admin-time-frequency');
      var costInput = el('admin-time-cost');
      var costParsed = adminParseEurosToCents(costInput && costInput.value);
      if (!costParsed.ok){ adminShowMessage('error', costParsed.error); return; }
      adminApiRequest('PATCH', '/staff/admin/config/lesson-times/' + encodeURIComponent(timeId) + adminClientQuery(), {
        label: label,
        kind: kindInput ? String(kindInput.value || 'lesson') : 'lesson',
        age_band: ageInput ? String(ageInput.value || 'all_ages') : 'all_ages',
        frequency: freqInput ? String(freqInput.value || 'daily') : 'daily',
        time_local: timeParsed.value,
        time_local_end: endParsed.value,
        capacity: capacityParsed.value,
        amount_cents: costParsed.value,
      }).then(function(res){"""
api = api.replace(SAVE_TIME_OLD, SAVE_TIME_NEW)

SAVE_NEW_TIME_OLD = """      var payload = {
        label: newLabel,
        lesson_type: 'group_surf_lesson',
        time_local: newStart.value,
        weekdays_active: [0, 1, 2, 3, 4, 5, 6],
        active: true,
      };
      var newEndRaw = newEndInput ? String(newEndInput.value || '').trim() : '';
      if (newEndRaw){
        var newEnd = adminParseTimeHm(newEndRaw);
        if (!newEnd.ok){ adminShowMessage('error', newEnd.error); return; }
        if (newEnd.value <= newStart.value){ adminShowMessage('error', portalT('admin.edit.endAfterStart')); return; }
        payload.time_local_end = newEnd.value;
      }"""
SAVE_NEW_TIME_NEW = """      var newCapInput = el('admin-new-time-capacity');
      var newKindInput = el('admin-new-time-kind');
      var newAgeInput = el('admin-new-time-age');
      var newFreqInput = el('admin-new-time-frequency');
      var newCostInput = el('admin-new-time-cost');
      var newCapParsed = adminParseCapacity(newCapInput && newCapInput.value);
      if (!newCapParsed.ok){ adminShowMessage('error', newCapParsed.error); return; }
      var newCostParsed = adminParseEurosToCents(newCostInput && newCostInput.value);
      if (!newCostParsed.ok){ adminShowMessage('error', newCostParsed.error); return; }
      var payload = {
        label: newLabel,
        kind: newKindInput ? String(newKindInput.value || 'lesson') : 'lesson',
        age_band: newAgeInput ? String(newAgeInput.value || 'all_ages') : 'all_ages',
        frequency: newFreqInput ? String(newFreqInput.value || 'daily') : 'daily',
        time_local: newStart.value,
        capacity: newCapParsed.value,
        amount_cents: newCostParsed.value,
        active: true,
      };
      var newEndRaw = newEndInput ? String(newEndInput.value || '').trim() : '';
      if (newEndRaw){
        var newEnd = adminParseTimeHm(newEndRaw);
        if (!newEnd.ok){ adminShowMessage('error', newEnd.error); return; }
        if (newEnd.value <= newStart.value){ adminShowMessage('error', portalT('admin.edit.endAfterStart')); return; }
        payload.time_local_end = newEnd.value;
      }"""
api = api.replace(SAVE_NEW_TIME_OLD, SAVE_NEW_TIME_NEW)

(ROOT / 'scripts/staff-query-api.js').write_text(api, encoding='utf-8')
print('OK staff-query-api.js')
print('DONE')
