#!/usr/bin/env python3
"""Sunset admin: rental row save, title-inline actions, lesson save fix, price delete fix."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
API = ROOT / 'scripts/staff-query-api.js'
WRITES = ROOT / 'scripts/lib/tenant-admin-writes.js'

api = API.read_text(encoding='utf-8')
writes = WRITES.read_text(encoding='utf-8')

# --- CSS: title + actions inline; smaller lesson edit btn ---
css_old = '.portal-admin-subsection-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}'
css_new = css_old + '\n.portal-admin-subsection-title-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap}\n.portal-admin-subsection-title-group .portal-admin-subsection-title{margin-bottom:0}\n.portal-admin-lesson-card .portal-admin-card-actions .portal-admin-icon-btn:not(.portal-admin-danger){font-size:10px;padding:0 4px;line-height:1.15;min-height:16px;border-radius:4px}'
if css_new not in api:
    if css_old not in api:
        raise SystemExit('CSS anchor missing')
    api = api.replace(css_old, css_new, 1)

# --- Remove per-card save/cancel from rental edit form ---
edit_form_old = """function renderAdminPriceCardEditForm(pid, p, groupKey){
  var parsed = adminParsePriceRow(p);
  var period = parsed.periodWindow || '1_day';
  return '<div class="portal-admin-price-card-edit">' +
    '<div><label>' + escHtml(portalT('admin.edit.period')) + '</label>' +
    '<select id="admin-price-period-' + escHtml(pid) + '">' + adminRentalPeriodOptions(period) + '</select></div>' +
    '<div><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" id="admin-price-amount-' + escHtml(pid) + '" value="' + escHtml(adminEurosFromAmount(p.amount)) + '" inputmode="decimal"></div>' +
    '<div class="portal-admin-price-card-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-price" data-price-id="' + escHtml(pid) + '">' +
    escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}"""

edit_form_new = """function renderAdminPriceCardEditForm(pid, p, groupKey){
  var parsed = adminParsePriceRow(p);
  var period = parsed.periodWindow || '1_day';
  return '<div class="portal-admin-price-card-edit">' +
    '<div><label>' + escHtml(portalT('admin.edit.period')) + '</label>' +
    '<select id="admin-price-period-' + escHtml(pid) + '">' + adminRentalPeriodOptions(period) + '</select></div>' +
    '<div><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" id="admin-price-amount-' + escHtml(pid) + '" value="' + escHtml(adminEurosFromAmount(p.amount)) + '" inputmode="decimal"></div>' +
    '</div>';
}"""

if edit_form_old not in api:
    raise SystemExit('renderAdminPriceCardEditForm block missing')
api = api.replace(edit_form_old, edit_form_new, 1)

# --- Rental subsection title row: inline actions, Save+Cancel when editing ---
title_row_old = """    html += '<div class="portal-admin-subsection-title-row"><h3 class="portal-admin-subsection-title">' + escHtml(adminPriceGroupTitle(key)) + '</h3>';
    if (writes){
      var busyOther = adminEditTarget && !groupEditing && !adding;
      if (!busyOther){
        html += '<div class="portal-admin-card-actions">';
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
        html += '</div>';
      }
    }
    html += '</div>';"""

title_row_new = """    html += '<div class="portal-admin-subsection-title-row"><div class="portal-admin-subsection-title-group">';
    html += '<h3 class="portal-admin-subsection-title">' + escHtml(adminPriceGroupTitle(key)) + '</h3>';
    if (writes){
      var busyOther = adminEditTarget && !groupEditing && !adding;
      if (!busyOther){
        html += '<div class="portal-admin-card-actions">';
        if (!groupEditing){
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-price-group" data-price-group="' +
            escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.edit')) + '">✎</button>';
          if (!adding){
            html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-price" data-price-group="' +
              escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button>';
          }
        } else {
          html += '<button type="button" class="btn btn-primary portal-admin-row-edit" data-admin-action="save-price-group" data-price-group="' +
            escHtml(key) + '">' + escHtml(portalT('admin.action.save')) + '</button>';
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit" data-admin-action="cancel-edit">' +
            escHtml(portalT('admin.action.cancel')) + '</button>';
        }
        html += '</div>';
      }
    }
    html += '</div></div>';"""

if title_row_old not in api:
    raise SystemExit('rental title row block missing')
api = api.replace(title_row_old, title_row_new, 1)

# --- Lessons title row inline + ---
lesson_title_old = """  html += '<div class="portal-admin-subsection"><div class="portal-admin-subsection-title-row"><h3 class="portal-admin-subsection-title">' + escHtml(portalT('admin.lessonTimes.lessonsTitle')) + '</h3>';
  if (writes && !adminEditTarget){
    html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-time" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button></div>';
  }
  html += '</div><p class="portal-admin-muted">'"""

lesson_title_new = """  html += '<div class="portal-admin-subsection"><div class="portal-admin-subsection-title-row"><div class="portal-admin-subsection-title-group">';
  html += '<h3 class="portal-admin-subsection-title">' + escHtml(portalT('admin.lessonTimes.lessonsTitle')) + '</h3>';
  if (writes && !adminEditTarget){
    html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-time" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button></div>';
  }
  html += '</div></div><p class="portal-admin-muted">'"""

if lesson_title_old not in api:
    raise SystemExit('lesson title row missing')
api = api.replace(lesson_title_old, lesson_title_new, 1)

# --- Packs title row inline + ---
pack_title_old = """  var html = '<div class="portal-admin-subsection"><div class="portal-admin-subsection-title-row"><h3 class="portal-admin-subsection-title">' + escHtml(portalT('admin.packs.title')) + '</h3>';
  if (writes && !adminEditTarget){
    html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-pack" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button></div>';
  }
  html += '</div><p class="portal-admin-muted">'"""

pack_title_new = """  var html = '<div class="portal-admin-subsection"><div class="portal-admin-subsection-title-row"><div class="portal-admin-subsection-title-group">';
  html += '<h3 class="portal-admin-subsection-title">' + escHtml(portalT('admin.packs.title')) + '</h3>';
  if (writes && !adminEditTarget){
    html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-pack" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button></div>';
  }
  html += '</div></div><p class="portal-admin-muted">'"""

if pack_title_old not in api:
    raise SystemExit('pack title row missing')
api = api.replace(pack_title_old, pack_title_new, 1)

# --- adminReloadConfigKeepingEdit helper ---
reload_fn = """function adminReloadConfig(){
  adminEditTarget = null;
  adminSaveBusy = false;
  loadAdminTab();
}"""

reload_fn_new = """function adminReloadConfigKeepingEdit(keepTarget){
  var saved = keepTarget || null;
  adminSaveBusy = false;
  var url = '/staff/admin/config' + adminClientQuery();
  fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function(data){
      if (!data || data.success !== true) return Promise.reject(new Error('load failed'));
      adminConfigCache = data;
      adminEditTarget = saved;
      renderAdminFromConfig(data);
    })
    .catch(function(e){
      adminEditTarget = saved;
      adminShowMessage('error', portalT('admin.error') + ' ' + e.message);
      if (adminConfigCache) renderAdminFromConfig(adminConfigCache);
    });
}

function adminReloadConfig(){
  adminEditTarget = null;
  adminSaveBusy = false;
  loadAdminTab();
}"""

if reload_fn not in api:
    raise SystemExit('adminReloadConfig anchor missing')
api = api.replace(reload_fn, reload_fn_new, 1)

# --- wireAdminTab: save-price-group, keep edit on delete ---
guard_old = "action === 'edit-capacity' || action === 'edit-price-group' || action === 'add-price' || action === 'delete-price'"
guard_new = "action === 'edit-capacity' || action === 'edit-price-group' || action === 'add-price' || action === 'delete-price' || action === 'save-price-group'"
if guard_old not in api:
    raise SystemExit('wireAdminTab guard missing')
api = api.replace(guard_old, guard_new, 1)

delete_price_old = """    if (action === 'delete-price'){
      var deletePriceId = String(btn.getAttribute('data-price-id') || '');
      if (!deletePriceId || !window.confirm(portalT('admin.edit.confirmRemovePrice'))) return;
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('DELETE', '/staff/admin/config/prices/' + encodeURIComponent(deletePriceId) + adminClientQuery(), {})
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedPrice'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }"""

delete_price_new = """    if (action === 'delete-price'){
      var deletePriceId = String(btn.getAttribute('data-price-id') || '');
      if (!deletePriceId || !window.confirm(portalT('admin.edit.confirmRemovePrice'))) return;
      var keepGroupEdit = adminEditTarget && String(adminEditTarget).indexOf('price-group:') === 0 ? adminEditTarget : null;
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('DELETE', '/staff/admin/config/prices/' + encodeURIComponent(deletePriceId) + adminClientQuery(), {})
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedPrice'));
          adminReloadConfigKeepingEdit(keepGroupEdit);
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }"""

if delete_price_old not in api:
    raise SystemExit('delete-price block missing')
api = api.replace(delete_price_old, delete_price_new, 1)

save_group_block = """    if (action === 'save-price-group'){
      var saveGroup = String(btn.getAttribute('data-price-group') || '');
      var grid = el('admin-prices-card-grid-' + saveGroup);
      if (!grid){ adminShowMessage('error', portalT('admin.edit.saveFailed')); return; }
      var cards = grid.querySelectorAll('[data-admin-price-card]');
      var jobs = [];
      var validationError = '';
      cards.forEach(function(card){
        var pid = card.getAttribute('data-admin-price-card');
        if (!pid) return;
        var periodInput = el('admin-price-period-' + pid);
        var amountInput = el('admin-price-amount-' + pid);
        var period = periodInput ? String(periodInput.value || '').trim() : '';
        if (!period){ validationError = portalT('admin.edit.periodRequired'); return; }
        var centsParsed = adminParseEurosToCents(amountInput && amountInput.value);
        if (!centsParsed.ok){ validationError = centsParsed.error; return; }
        jobs.push(adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(pid) + adminClientQuery(), {
          period_window: period,
          amount_cents: centsParsed.value,
        }));
      });
      if (validationError){ adminShowMessage('error', validationError); return; }
      if (!jobs.length){ adminShowMessage('error', portalT('admin.prices.emptyCategory')); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      Promise.all(jobs).then(function(results){
        adminSaveBusy = false;
        var failed = results.find(function(res){ return res.status !== 200 || !res.data || res.data.success !== true; });
        if (failed){
          adminShowMessage('error', (failed.data && (failed.data.message || failed.data.error)) || ('HTTP ' + failed.status));
          return;
        }
        adminShowMessage('success', portalT('admin.edit.savedPrice'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
      return;
    }

    if (action === 'save-price'){"""

if 'save-price-group' not in api:
    if "    if (action === 'save-price'){" not in api:
        raise SystemExit('save-price anchor missing')
    api = api.replace("    if (action === 'save-price'){", save_group_block, 1)

# --- tenant-admin-writes: cfg price delete + config lesson upsert ---
import_block_old = """const {
  SUNSET_ADMIN_CLIENT,
  adminConfigTableHasLocationColumn,
  adminConfigTablesExist,
} = require('./tenant-business-config');"""

import_block_new = """const {
  SUNSET_ADMIN_CLIENT,
  adminConfigTableHasLocationColumn,
  adminConfigTablesExist,
  resolveFromConfigFile,
  loadLessonTimesFromConfig,
} = require('./tenant-business-config');"""

if import_block_new not in writes:
    if import_block_old not in writes:
        raise SystemExit('writes import block missing')
    writes = writes.replace(import_block_old, import_block_new, 1)

deact_old = """async function deactivatePriceRule(client, { ruleId, clientSlug, locationId, actor }) {
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
    );"""

deact_new = """function parseConfigSlotTimes(slotTime) {
  const text = String(slotTime || '').trim();
  if (!text) return { timeLocal: null, timeLocalEnd: null };
  if (text.includes('-')) {
    const parts = text.split('-').map((s) => s.trim());
    return { timeLocal: parts[0] || null, timeLocalEnd: parts[1] || null };
  }
  return { timeLocal: text, timeLocalEnd: null };
}

async function upsertConfigLessonTimeRule(client, { slotId, clientSlug, locationId, patch, actor }) {
  const loc = normalizeSunsetLocationId(locationId);
  const baseline = resolveFromConfigFile(clientSlug);
  const configSlots = loadLessonTimesFromConfig(baseline.ok ? baseline : {});
  const baseSlot = configSlots.find((s) => String(s.slot_id) === String(slotId));
  if (!baseSlot) {
    return { ok: false, status: 404, body: { success: false, error: 'config_slot_not_found' } };
  }
  const parsedTimes = parseConfigSlotTimes(baseSlot.slot_time);
  const freqKey = patch.frequency != null ? patch.frequency : 'daily';
  const weekdays = patch.weekdays_active != null
    ? patch.weekdays_active
    : (LESSON_FREQUENCY_PRESETS[freqKey] || LESSON_FREQUENCY_PRESETS.daily);
  const dbPatch = {
    label: patch.label != null ? patch.label : (baseSlot.offering_label || 'Surf lesson'),
    time_local: patch.time_local != null ? patch.time_local : parsedTimes.timeLocal,
    time_local_end: patch.time_local_end !== undefined ? patch.time_local_end : parsedTimes.timeLocalEnd,
    lesson_type: String(slotId),
    weekdays_active: weekdays,
    active: true,
  };
  if (patch.capacity != null) dbPatch.capacity = patch.capacity;
  if (!dbPatch.time_local) {
    return { ok: false, status: 400, body: { success: false, error: 'time_local required' } };
  }
  const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_lesson_time_rules');
  const hasCapacity = await adminConfigTableHasColumn(client, 'tenant_lesson_time_rules', 'capacity');
  const existing = await client.query(
    hasLoc
      ? `SELECT * FROM tenant_lesson_time_rules WHERE client_slug = $1 AND location_id = $2 AND lesson_type = $3 AND active = true FOR UPDATE`
      : `SELECT * FROM tenant_lesson_time_rules WHERE client_slug = $1 AND lesson_type = $2 AND active = true FOR UPDATE`,
    hasLoc ? [clientSlug, loc, String(slotId)] : [clientSlug, String(slotId)],
  );
  if (existing.rows[0]) {
    const mergedPatch = {
      label: dbPatch.label,
      time_local: dbPatch.time_local,
      time_local_end: dbPatch.time_local_end,
      capacity: dbPatch.capacity,
      weekdays_active: dbPatch.weekdays_active,
      amount_cents: patch.amount_cents,
      frequency: patch.frequency,
    };
    return patchLessonTimeRule(client, {
      ruleId: existing.rows[0].id,
      clientSlug,
      locationId: loc,
      patch: mergedPatch,
      actor,
    });
  }
  return createLessonTimeRule(client, {
    clientSlug,
    locationId: loc,
    patch: {
      ...dbPatch,
      amount_cents: patch.amount_cents,
      currency: patch.currency || 'EUR',
    },
    actor,
  });
}

async function deactivatePriceRule(client, { ruleId, clientSlug, locationId, actor }) {
  const tablesExist = await adminConfigTablesExist(client);
  const loc = normalizeSunsetLocationId(locationId);
  const parsedCfg = locationStore.parseConfigPriceId(ruleId);
  if (parsedCfg) {
    if (parsedCfg.locationId !== loc) {
      return { ok: false, status: 403, body: { success: false, error: 'location_mismatch' } };
    }
    if (!tablesExist) {
      const result = locationStore.deactivateConfigPrice(
        loc,
        parsedCfg.category,
        parsedCfg.offering_key,
        parsedCfg.unit,
      );
      if (!result.ok) return result;
      locationStore.appendLocationAudit(loc, {
        action: 'deactivate',
        entity_type: 'price_rule',
        entity_id: ruleId,
        actor_email: actor.email || 'unknown',
        after_json: result.body,
      });
      return { ...result, body: { ...result.body, success: true, storage: 'location_store' } };
    }
    const itemType = mapCategoryToItemType(parsedCfg.category);
    const itemCode = buildDbItemCode(parsedCfg.offering_key, parsedCfg.unit);
    const hasLoc = await adminConfigTableHasLocationColumn(client, 'tenant_price_rules');
    const row = await findPriceRuleRow(client, {
      clientSlug, locationId: loc, itemType, itemCode, hasLoc,
    });
    if (!row.rows[0]) {
      return { ok: true, status: 200, body: { success: true, storage: 'noop' } };
    }
    return deactivatePriceRule(client, {
      ruleId: row.rows[0].id,
      clientSlug,
      locationId: loc,
      actor,
    });
  }
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
    );"""

if 'upsertConfigLessonTimeRule' not in writes:
    if deact_old not in writes:
        raise SystemExit('deactivatePriceRule block missing')
    writes = writes.replace(deact_old, deact_new, 1)

patch_lesson_old = """  if (locationStore.isConfigTimeId(ruleId)) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: 'config_slot_use_db_uuid',
        message: 'Lesson time edits require DB-backed slot ids after admin tables exist',
      },
    };
  }"""

patch_lesson_new = """  if (locationStore.isConfigTimeId(ruleId)) {
    return upsertConfigLessonTimeRule(client, {
      slotId: ruleId,
      clientSlug,
      locationId: loc,
      patch,
      actor,
    });
  }"""

if patch_lesson_new not in writes:
    if patch_lesson_old not in writes:
        raise SystemExit('patchLessonTimeRule config block missing')
    writes = writes.replace(patch_lesson_old, patch_lesson_new, 1)

# Export loadLessonTimesFromConfig if needed (usually already exported)
tbc = ROOT / 'scripts/lib/tenant-business-config.js'
tbc_text = tbc.read_text(encoding='utf-8')
if 'loadLessonTimesFromConfig,' not in tbc_text.split('module.exports')[1]:
    tbc_text = tbc_text.replace(
        '  resolveFromConfigFile,',
        '  resolveFromConfigFile,\n  loadLessonTimesFromConfig,',
        1,
    )
    tbc.write_text(tbc_text, encoding='utf-8')
    print('OK exported loadLessonTimesFromConfig')
else:
    print('SKIP loadLessonTimesFromConfig already exported')

# deactivateConfigPrice in location store if missing
store = ROOT / 'scripts/lib/sunset-admin-location-store.js'
store_text = store.read_text(encoding='utf-8')
if 'deactivateConfigPrice' not in store_text:
    insert_fn = """
function deactivateConfigPrice(locationId, category, offeringKey, unit) {
  const loc = normalizeSunsetLocationId(locationId);
  const store = readStoreSync();
  const bucket = ensureLocationBucket(store, loc);
  const key = stablePriceKey(category, offeringKey, unit);
  if (bucket.prices && bucket.prices[key]) {
    bucket.prices[key].active = false;
    writeStoreSync(store);
  }
  return { ok: true, body: { price_rule: { id: priceIdFromParts(loc, category, offeringKey, unit), active: false } } };
}
"""
    store_text = store_text.replace(
        'module.exports = {',
        insert_fn + '\nmodule.exports = {',
        1,
    )
    store_text = store_text.replace(
        '  parseConfigPriceId,',
        '  parseConfigPriceId,\n  deactivateConfigPrice,',
        1,
    )
    store.write_text(store_text, encoding='utf-8')
    print('OK added deactivateConfigPrice')

API.write_text(api, encoding='utf-8')
WRITES.write_text(writes, encoding='utf-8')
print('OK patched staff-query-api.js and tenant-admin-writes.js')
