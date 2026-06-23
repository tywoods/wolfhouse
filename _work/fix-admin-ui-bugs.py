#!/usr/bin/env python3
"""Fix admin UI: rental save, pack +, pill toggle, schedule time pickers, cross-section locks."""
from pathlib import Path

API = Path('/opt/wolfhouse/WH/scripts/staff-query-api.js')
api = API.read_text(encoding='utf-8')

# --- section-scoped busy checks (replace cross-section adminEditBusyExcept) ---
OLD_BUSY = """function adminEditScope(target){
  var t = String(target || '');
  if (!t) return '';
  if (t.indexOf('price-group:') === 0 || t.indexOf('price-add:') === 0) return 'price';
  if (t.indexOf('time:') === 0 || t === 'time:new') return 'time';
  if (t.indexOf('pack:') === 0 || t === 'pack:new') return 'pack';
  if (t === 'capacity') return 'capacity';
  return 'other';
}
function adminEditBusyExcept(scope){
  if (!adminEditTarget) return false;
  return adminEditScope(adminEditTarget) !== scope;
}"""

NEW_BUSY = """function adminPriceGroupBusy(groupKey){
  if (!adminEditTarget) return false;
  var t = String(adminEditTarget);
  if (t.indexOf('price-group:') === 0) return t !== ('price-group:' + groupKey);
  if (t.indexOf('price-add:') === 0) return t !== ('price-add:' + groupKey);
  return false;
}
function adminLessonSectionEditing(){
  if (!adminEditTarget) return false;
  var t = String(adminEditTarget);
  return t === 'time:new' || t.indexOf('time:') === 0;
}
function adminPackSectionEditing(){
  if (!adminEditTarget) return false;
  var t = String(adminEditTarget);
  return t === 'pack:new' || t.indexOf('pack:') === 0;
}"""

if OLD_BUSY not in api:
    raise SystemExit('adminEditBusyExcept block missing')
api = api.replace(OLD_BUSY, NEW_BUSY, 1)

api = api.replace(
    "var busyOther = adminEditBusyExcept('price') && !groupEditing && !adding;",
    "var busyOther = adminPriceGroupBusy(key);",
)
api = api.replace(
    "if (writes && !adminEditBusyExcept('time')){",
    "if (writes && !adminLessonSectionEditing()){",
)
api = api.replace(
    "if (writes && !editing && !adminEditBusyExcept('time')){",
    "if (writes && !editing && !adminLessonSectionEditing()){",
)
api = api.replace(
    "if (writes && !adminEditBusyExcept('pack')){",
    "if (writes && !adminPackSectionEditing()){",
)
api = api.replace(
    "if (writes && !editing && !adminEditBusyExcept('pack')){",
    "if (writes && !editing && !adminPackSectionEditing()){",
)

# --- pill toggle: use pill-row for multi flag; allow single-select deselect ---
OLD_TOGGLE = """    if (action === 'toggle-pill'){
      var pillGroup = btn.getAttribute('data-admin-pill-group');
      var pillVal = btn.getAttribute('data-admin-pill-value');
      var row = btn.closest('[data-admin-pill-group]');
      var multi = row && row.getAttribute('data-admin-pill-multi') === '1';
      if (!multi){
        row.querySelectorAll('.portal-admin-pill').forEach(function(p){ p.classList.remove('is-selected'); });
        btn.classList.add('is-selected');
      } else {
        btn.classList.toggle('is-selected');
      }
      return;
    }"""

NEW_TOGGLE = """    if (action === 'toggle-pill'){
      var row = btn.closest('.portal-admin-pill-row');
      var multi = row && row.getAttribute('data-admin-pill-multi') === '1';
      if (!row) return;
      if (!multi){
        if (btn.classList.contains('is-selected')){
          btn.classList.remove('is-selected');
        } else {
          row.querySelectorAll('.portal-admin-pill').forEach(function(p){ p.classList.remove('is-selected'); });
          btn.classList.add('is-selected');
        }
      } else {
        btn.classList.toggle('is-selected');
      }
      return;
    }"""

if OLD_TOGGLE not in api:
    raise SystemExit('toggle-pill handler missing')
api = api.replace(OLD_TOGGLE, NEW_TOGGLE, 1)

# --- pill collect scoped to pack form ---
OLD_COLLECT = """function adminCollectPillValues(group){
  var row = document.querySelector('[data-admin-pill-group="' + group + '"]');
  if (!row) return [];
  return Array.prototype.slice.call(row.querySelectorAll('.portal-admin-pill.is-selected')).map(function(b){ return b.getAttribute('data-admin-pill-value'); });
}
function adminCollectSinglePill(group, fallback){
  var vals = adminCollectPillValues(group);
  return vals.length ? vals[0] : fallback;
}"""

NEW_COLLECT = """function adminPackFormRoot(pid){
  if (pid) return document.querySelector('[data-admin-pack-form="' + pid + '"]');
  return document.querySelector('[data-admin-pack-form="new"]');
}
function adminCollectPillValues(group, root){
  var scope = root || document;
  var row = scope.querySelector('.portal-admin-pill-row[data-admin-pill-group="' + group + '"]');
  if (!row) return [];
  return Array.prototype.slice.call(row.querySelectorAll('.portal-admin-pill.is-selected')).map(function(b){ return b.getAttribute('data-admin-pill-value'); });
}
function adminCollectSinglePill(group, fallback, root){
  var vals = adminCollectPillValues(group, root);
  return vals.length ? vals[0] : fallback;
}"""

if OLD_COLLECT not in api:
    raise SystemExit('adminCollectPillValues block missing')
api = api.replace(OLD_COLLECT, NEW_COLLECT, 1)

# --- schedule time helpers (replace schedule pills) ---
SCHED_HELPERS = """
function adminTimesFromScheduleKey(key){
  var parts = String(key || '').split('_');
  if (parts.length !== 2) return { start: '', end: '' };
  var fmt = function(hhmm){
    var s = String(hhmm || '').trim();
    if (s.length === 4) return s.slice(0, 2) + ':' + s.slice(2);
    return s;
  };
  return { start: fmt(parts[0]), end: fmt(parts[1]) };
}
function adminScheduleKeyFromTimes(start, end){
  var s = String(start || '').trim().replace(':', '');
  var e = String(end || '').trim().replace(':', '');
  if (!s || !e) return '';
  return s + '_' + e;
}
function adminRenderPackScheduleFields(p, prefix){
  var sched = (p && p.schedules && p.schedules[0]) ? p.schedules[0] : '0930_1130';
  var times = adminTimesFromScheduleKey(sched);
  return '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.startTime')) + '</label>' +
    '<input type="text" id="' + prefix + '-schedule-start" value="' + escHtml(times.start) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.endTime')) + '</label>' +
    '<input type="text" id="' + prefix + '-schedule-end" value="' + escHtml(times.end) + '" placeholder="HH:MM" maxlength="5"></div>';
}
function adminRenderPackScheduleReadout(schedules){
  var key = (schedules && schedules[0]) ? schedules[0] : '';
  var times = adminTimesFromScheduleKey(key);
  var label = (times.start && times.end) ? (times.start + ' – ' + times.end) : '—';
  return '<div class="portal-admin-pack-schedule-readout"><span class="portal-admin-muted">' + escHtml(portalT('admin.packs.schedules')) + '</span> <strong>' + escHtml(label) + '</strong></div>';
}
function adminReadPackSchedules(prefix){
  var startInput = el(prefix + '-schedule-start');
  var endInput = el(prefix + '-schedule-end');
  var startParsed = adminParseTimeHm(startInput && startInput.value);
  if (!startParsed.ok) return { ok: false, error: startParsed.error };
  var endParsed = adminParseTimeHm(endInput && endInput.value);
  if (!endParsed.ok) return { ok: false, error: endParsed.error };
  if (endParsed.value <= startParsed.value) return { ok: false, error: portalT('admin.edit.endAfterStart') };
  var key = adminScheduleKeyFromTimes(startParsed.value, endParsed.value);
  return { ok: true, value: key ? [key] : [] };
}
"""

anchor = "function adminRenderPackTierFields(tiers, prefix){"
if "function adminTimesFromScheduleKey" not in api:
    api = api.replace(anchor, SCHED_HELPERS + anchor, 1)

# --- pack edit form: wrap form root, schedule fields ---
OLD_PACK_FORM = """function adminRenderPackEditForm(pid, pack){
  var p = pack || adminDefaultPackSeed();
  var prefix = pid ? ('admin-pack-' + pid) : 'admin-new-pack';
  var inner = '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
    '<input type="text" id="' + prefix + '-label" value="' + escHtml(p.label || '') + '" maxlength="120"></div>' +
    adminRenderPillRow('age_band', adminPackAgeOptions(), p.age_band || '12_and_up', false) +
    adminRenderPillRow('group_size', adminPackGroupSizeOptions(), String(p.group_size || 16), false) +
    adminRenderPillRow('beaches', adminPackBeachOptions(), p.beaches || [], true) +
    adminRenderPillRow('weekly', adminPackWeeklyPillOptions(), p.weekly || 'mon_fri', false) +
    adminRenderPillRow('schedules', adminPackScheduleOptions(), p.schedules || [], true) +
    adminRenderPackTierFields(p.price_tiers || ADMIN_DEFAULT_PRICE_TIERS, prefix) +
    '<div class="portal-admin-price-card-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="' + (pid ? 'save-pack' : 'save-new-pack') + '" data-pack-id="' + escHtml(pid || '') + '">' + escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div>';
  if (pid) return inner;
  return '<div class="portal-admin-pack-card">' + inner + '</div>';
}"""

NEW_PACK_FORM = """function adminRenderPackEditForm(pid, pack){
  var p = pack || adminDefaultPackSeed();
  var prefix = pid ? ('admin-pack-' + pid) : 'admin-new-pack';
  var formAttr = pid ? (' data-admin-pack-form="' + escHtml(pid) + '"') : ' id="admin-new-pack-form" data-admin-pack-form="new"';
  var inner = '<div class="portal-admin-pack-form"' + formAttr + '>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
    '<input type="text" id="' + prefix + '-label" value="' + escHtml(p.label || '') + '" maxlength="120"></div>' +
    adminRenderPillRow('age_band', adminPackAgeOptions(), p.age_band || '12_and_up', false) +
    adminRenderPillRow('group_size', adminPackGroupSizeOptions(), String(p.group_size || 16), false) +
    adminRenderPillRow('beaches', adminPackBeachOptions(), p.beaches || [], true) +
    adminRenderPillRow('weekly', adminPackWeeklyPillOptions(), p.weekly || 'mon_fri', false) +
    adminRenderPackScheduleFields(p, prefix) +
    adminRenderPackTierFields(p.price_tiers || ADMIN_DEFAULT_PRICE_TIERS, prefix) +
    '<div class="portal-admin-price-card-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="' + (pid ? 'save-pack' : 'save-new-pack') + '" data-pack-id="' + escHtml(pid || '') + '">' + escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
  if (pid) return inner;
  return '<div class="portal-admin-pack-card">' + inner + '</div>';
}"""

if OLD_PACK_FORM not in api:
    raise SystemExit('adminRenderPackEditForm block missing')
api = api.replace(OLD_PACK_FORM, NEW_PACK_FORM, 1)

OLD_READ_PAYLOAD = """function adminReadPackFormPayload(pid){
  var prefix = pid ? ('admin-pack-' + pid) : 'admin-new-pack';
  var labelEl = el(prefix + '-label');
  var tiers = (ADMIN_DEFAULT_PRICE_TIERS || []).map(function(t, idx){
    var input = el(prefix + '-tier-amount-' + idx);
    var cents = adminParseEurosToCents(input && input.value);
    return { key: t.key, label: t.label, hours: t.hours, amount_cents: cents.ok ? cents.value : 0 };
  });
  return {
    label: labelEl ? String(labelEl.value || '').trim() : '',
    age_band: adminCollectSinglePill('age_band', '12_and_up'),
    group_size: Number(adminCollectSinglePill('group_size', '16')),
    beaches: adminCollectPillValues('beaches'),
    weekly: adminCollectSinglePill('weekly', 'mon_fri'),
    schedules: adminCollectPillValues('schedules'),
    price_tiers: tiers,
  };
}"""

NEW_READ_PAYLOAD = """function adminReadPackFormPayload(pid){
  var root = adminPackFormRoot(pid || null);
  var prefix = pid ? ('admin-pack-' + pid) : 'admin-new-pack';
  var labelEl = el(prefix + '-label');
  var tiers = (ADMIN_DEFAULT_PRICE_TIERS || []).map(function(t, idx){
    var input = el(prefix + '-tier-amount-' + idx);
    var cents = adminParseEurosToCents(input && input.value);
    return { key: t.key, label: t.label, hours: t.hours, amount_cents: cents.ok ? cents.value : 0 };
  });
  var schedulesParsed = adminReadPackSchedules(prefix);
  return {
    label: labelEl ? String(labelEl.value || '').trim() : '',
    age_band: adminCollectSinglePill('age_band', '12_and_up', root),
    group_size: Number(adminCollectSinglePill('group_size', '16', root)),
    beaches: adminCollectPillValues('beaches', root),
    weekly: adminCollectSinglePill('weekly', 'mon_fri', root),
    schedules: schedulesParsed.ok ? schedulesParsed.value : [],
    price_tiers: tiers,
    _scheduleError: schedulesParsed.ok ? '' : schedulesParsed.error,
  };
}"""

if OLD_READ_PAYLOAD not in api:
    raise SystemExit('adminReadPackFormPayload block missing')
api = api.replace(OLD_READ_PAYLOAD, NEW_READ_PAYLOAD, 1)

# --- pack readout: schedule readout not pills ---
api = api.replace(
    "      html += adminRenderPillRow('schedules', adminPackScheduleOptions(), p.schedules || [], true);\n",
    "      html += adminRenderPackScheduleReadout(p.schedules || []);\n",
)

# --- rental price card: data-admin-price-field + safe input key ---
OLD_PRICE_EDIT = """function renderAdminPriceCardEditForm(pid, p, groupKey){
  var parsed = adminParsePriceRow(p);
  var period = parsed.periodWindow || '1_day';
  return '<div class="portal-admin-price-card-edit">' +
    '<div><label>' + escHtml(portalT('admin.edit.period')) + '</label>' +
    '<select id="admin-price-period-' + escHtml(pid) + '">' + adminRentalPeriodOptions(period) + '</select></div>' +
    '<div><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" id="admin-price-amount-' + escHtml(pid) + '" value="' + escHtml(adminEurosFromAmount(p.amount)) + '" inputmode="decimal"></div>' +
    '</div>';
}"""

NEW_PRICE_EDIT = """function adminPriceInputKey(pid){
  return String(pid || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}
function renderAdminPriceCardEditForm(pid, p, groupKey){
  var parsed = adminParsePriceRow(p);
  var period = parsed.periodWindow || '1_day';
  var ik = adminPriceInputKey(pid);
  return '<div class="portal-admin-price-card-edit">' +
    '<div><label>' + escHtml(portalT('admin.edit.period')) + '</label>' +
    '<select data-admin-price-field="period" id="admin-price-period-' + escHtml(ik) + '">' + adminRentalPeriodOptions(period) + '</select></div>' +
    '<div><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" data-admin-price-field="amount" id="admin-price-amount-' + escHtml(ik) + '" value="' + escHtml(adminEurosFromAmount(p.amount)) + '" inputmode="decimal"></div>' +
    '</div>';
}"""

if OLD_PRICE_EDIT not in api:
    raise SystemExit('renderAdminPriceCardEditForm block missing')
api = api.replace(OLD_PRICE_EDIT, NEW_PRICE_EDIT, 1)

# --- save-price-group: query fields from card ---
OLD_SAVE_GROUP = """        var periodInput = el('admin-price-period-' + pid);
        var amountInput = el('admin-price-amount-' + pid);"""

NEW_SAVE_GROUP = """        var periodInput = card.querySelector('[data-admin-price-field="period"]');
        var amountInput = card.querySelector('[data-admin-price-field="amount"]');"""

if OLD_SAVE_GROUP not in api:
    raise SystemExit('save-price-group field lookup missing')
api = api.replace(OLD_SAVE_GROUP, NEW_SAVE_GROUP, 1)

# --- save-pack: validate schedule ---
OLD_SAVE_PACK = """      var payload = adminReadPackFormPayload(packId || null);
      if (!payload.label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }"""

NEW_SAVE_PACK = """      var payload = adminReadPackFormPayload(packId || null);
      if (payload._scheduleError){ adminShowMessage('error', payload._scheduleError); return; }
      delete payload._scheduleError;
      if (!payload.label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }"""

if OLD_SAVE_PACK not in api:
    raise SystemExit('save-pack block missing')
api = api.replace(OLD_SAVE_PACK, NEW_SAVE_PACK, 1)

API.write_text(api, encoding='utf-8')
print('OK patched', API)
