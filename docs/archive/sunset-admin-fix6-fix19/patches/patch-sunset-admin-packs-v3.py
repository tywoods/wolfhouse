#!/usr/bin/env python3
"""Rental edit UI fix + split packs section with pill editor."""
from pathlib import Path
import re

ROOT = Path('/opt/wolfhouse/WH')

# Copy new files (assumes scp'd already or embedded)
# sunset-admin-pack-rules.js and migration should be copied separately

# ── Export upsertConfigPriceRule ─────────────────────────────────────────────
writes = (ROOT / 'scripts/lib/tenant-admin-writes.js').read_text(encoding='utf-8')
if 'upsertConfigPriceRule,' not in writes:
    writes = writes.replace('  patchPriceRule,\n', '  patchPriceRule,\n  upsertConfigPriceRule,\n')
    (ROOT / 'scripts/lib/tenant-admin-writes.js').write_text(writes, encoding='utf-8')
    print('OK export upsertConfigPriceRule')

# ── tenant-business-config.js ───────────────────────────────────────────────
tbc = (ROOT / 'scripts/lib/tenant-business-config.js').read_text(encoding='utf-8')
if 'loadSurfPacksFromDb' not in tbc:
    tbc = tbc.replace(
        "const locationStore = require('./sunset-admin-location-store');",
        "const locationStore = require('./sunset-admin-location-store');\nconst { loadSurfPacksFromDb, defaultPackConfig } = require('./sunset-admin-pack-rules');",
    )
    tbc = tbc.replace(
        "  const lesson_times = attachLessonPrices(mapLessonTimeRows(timeRes.rows), prices);",
        "  const lesson_times = attachLessonPrices(mapLessonTimeRows(timeRes.rows), prices);\n  const surf_packs = await loadSurfPacksFromDb(client, slug, loc);",
    )
    tbc = tbc.replace(
        "    lesson_times,\n    change_history,\n  };",
        "    lesson_times,\n    surf_packs,\n    change_history,\n  };",
        1,
    )
    tbc = tbc.replace(
        "  const lesson_times = attachLessonPrices(lesson_timesRaw, prices);\n\n  const hasAnyDb",
        "  const lesson_times = attachLessonPrices(lesson_timesRaw, prices);\n  const surf_packs = dbResult.surf_packs && dbResult.surf_packs.length\n    ? dbResult.surf_packs\n    : [];\n\n  const hasAnyDb",
    )
    tbc = tbc.replace(
        "    lesson_times,\n    change_history,\n    read_only:",
        "    lesson_times,\n    surf_packs,\n    change_history,\n    read_only:",
        1,
    )
    tbc = tbc.replace(
        "      lesson_times: [],\n      business_info:",
        "      lesson_times: [],\n      surf_packs: [],\n      business_info:",
    )
    tbc = tbc.replace(
        "    lesson_times: loadLessonTimesFromConfig(baseline),\n    business_info:",
        "    lesson_times: loadLessonTimesFromConfig(baseline),\n    surf_packs: [],\n    business_info:",
    )
    (ROOT / 'scripts/lib/tenant-business-config.js').write_text(tbc, encoding='utf-8')
    print('OK tenant-business-config.js')

api = (ROOT / 'scripts/staff-query-api.js').read_text(encoding='utf-8')

# Require pack rules module near other requires
if "require('./lib/sunset-admin-pack-rules')" not in api:
    api = api.replace(
        "} = require('./lib/tenant-admin-writes');",
        "} = require('./lib/tenant-admin-writes');\nconst {\n  defaultPackConfig,\n  DEFAULT_PRICE_TIERS,\n  validatePackBody,\n  createSurfPackRule,\n  patchSurfPackRule,\n  deactivateSurfPackRule,\n} = require('./lib/sunset-admin-pack-rules');",
    )

# ── CSS updates ─────────────────────────────────────────────────────────────
api = api.replace(
    ".portal-admin-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:6px;margin-top:6px}",
    ".portal-admin-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:8px;margin-top:8px}",
)
api = api.replace(
    ".portal-admin-price-card,.portal-admin-lesson-card{border:1px solid var(--border-soft);border-radius:8px;background:var(--surface-soft);padding:6px 8px;display:flex;flex-direction:column;gap:4px;min-height:0}",
    ".portal-admin-price-card,.portal-admin-lesson-card{border:1px solid var(--border-soft);border-radius:8px;background:var(--surface-soft);padding:8px 10px;display:flex;flex-direction:column;gap:5px;min-height:0}",
)
api = api.replace(
    ".portal-admin-icon-btn{min-width:0;padding:2px 7px;border-radius:999px;font-size:11px;line-height:1.5}",
    ".portal-admin-icon-btn{min-width:0;padding:2px 7px;border-radius:999px;font-size:11px;line-height:1.5}.portal-admin-icon-btn.portal-admin-danger{padding:0 4px;font-size:10px;line-height:1.15;min-height:16px;border-radius:4px}",
)

CSS_ADD = """
.portal-admin-price-card.is-editing{min-width:148px}
.portal-admin-price-card-edit{display:flex;flex-direction:column;gap:5px;width:100%}
.portal-admin-price-card-edit label{font-size:10px;font-weight:700;color:var(--text-2);display:block;margin-bottom:2px}
.portal-admin-price-card-edit select,.portal-admin-price-card-edit input{width:100%;padding:3px 6px;font-size:12px;height:26px;border:1px solid var(--border-soft);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box}
.portal-admin-price-card-edit-actions{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}
.portal-admin-price-card-edit-actions .btn{font-size:10px;padding:3px 8px}
.portal-admin-pack-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px;margin-top:8px}
.portal-admin-pack-card{border:1px solid var(--border-soft);border-radius:10px;background:var(--surface-soft);padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.portal-admin-pack-title{font-size:14px;font-weight:800;color:var(--text)}
.portal-admin-pack-sub{font-size:11px;color:var(--text-3)}
.portal-admin-pill-group{display:flex;flex-direction:column;gap:4px}
.portal-admin-pill-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-2)}
.portal-admin-pill-row{display:flex;flex-wrap:wrap;gap:4px}
.portal-admin-pill{border:1px solid var(--border-soft);background:var(--surface);color:var(--text-2);border-radius:999px;padding:3px 9px;font-size:11px;font-weight:650;line-height:1.3;cursor:pointer}
.portal-admin-pill.is-selected{background:var(--text);color:var(--surface);border-color:var(--text)}
.portal-admin-pack-tier{border:1px solid var(--border-soft);border-radius:8px;padding:6px 8px;background:var(--surface);font-size:11px;display:flex;flex-direction:column;gap:4px}
.portal-admin-pack-tier label{font-size:10px;font-weight:700;color:var(--text-2)}
.portal-admin-pack-tier input{width:100%;padding:3px 6px;font-size:12px;height:26px;border:1px solid var(--border-soft);border-radius:6px;background:var(--surface-soft);color:var(--text);box-sizing:border-box}
.portal-admin-pack-tier-row{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--text)}
.portal-admin-pack-tier-row strong{color:var(--text);font-weight:800}
"""

if '.portal-admin-price-card-edit' not in api:
    api = api.replace('#tab-admin.active{display:block}', CSS_ADD + '\n#tab-admin.active{display:block}')

# ── i18n half day ───────────────────────────────────────────────────────────
i18n = (ROOT / 'scripts/lib/staff-portal-i18n.js').read_text(encoding='utf-8')
i18n = i18n.replace("'admin.period.half_day': '3h / half day',", "'admin.period.half_day': 'Half day',")
PACK_I18N = """
    'admin.section.packs': 'Packs',
    'admin.packs.title': 'Surf packs',
    'admin.packs.help': 'Weekly and multi-week surf lesson packs with beaches, schedules, and tier pricing.',
    'admin.packs.placeholder': 'No packs configured yet. Click + to add a pack.',
    'admin.packs.beaches': 'Beaches',
    'admin.packs.beach.el_sardinero': 'El Sardinero',
    'admin.packs.beach.liencres': 'Liencres',
    'admin.packs.beach.somo': 'Somo',
    'admin.packs.groupSize': 'Group size',
    'admin.packs.groupExclusive': 'Exclusive group of {n} places',
    'admin.packs.schedules': 'Schedule',
    'admin.packs.schedule.0930_1130': '9:30 to 11:30',
    'admin.packs.schedule.1215_1415': '12:15 to 14:15',
    'admin.packs.priceTiers': 'Price for',
    'admin.packs.perStudent': '/ Student',
    'admin.packs.defaultName': 'Weekly surf pack',
    'admin.edit.addedPack': 'Pack added.',
    'admin.edit.savedPack': 'Pack saved.',
    'admin.edit.removedPack': 'Pack removed.',
    'admin.edit.confirmRemovePack': 'Remove this pack?',
    'admin.lessonTimes.lessonsTitle': 'Lessons',
"""
if "'admin.packs.title'" not in i18n:
    i18n = i18n.replace("'admin.lessonTimes.scheduleTitle': 'Lesson schedule',", "'admin.lessonTimes.scheduleTitle': 'Lesson schedule',\n" + PACK_I18N)
    i18n = i18n.replace("'admin.lessonTimes.help':", "'admin.lessonTimes.lessonsHelp': 'Single lesson times offered to guests and staff.',\n    'admin.lessonTimes.help':")
(ROOT / 'scripts/lib/staff-portal-i18n.js').write_text(i18n, encoding='utf-8')

# ── Replace renderAdminPriceCardEditForm ─────────────────────────────────────
OLD_EDIT = """function renderAdminPriceCardEditForm(pid, p, groupKey){
  var parsed = adminParsePriceRow(p);
  var period = parsed.periodWindow || '1_day';
  return '<div class="portal-admin-edit-form">' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.period')) + '</label>' +
    '<select id="admin-price-period-' + escHtml(pid) + '">' + adminRentalPeriodOptions(period) + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" id="admin-price-amount-' + escHtml(pid) + '" value="' + escHtml(adminEurosFromAmount(p.amount)) + '" inputmode="decimal"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-price" data-price-id="' + escHtml(pid) + '">' +
    escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}"""
NEW_EDIT = """function renderAdminPriceCardEditForm(pid, p, groupKey){
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
api = api.replace(OLD_EDIT, NEW_EDIT)

# Fix rental card editing class
api = api.replace(
    "html += '<article class=\"portal-admin-price-card\" data-admin-price-card=\"' + escHtml(pid) + '\">';",
    "html += '<article class=\"portal-admin-price-card' + (groupEditing && pid ? ' is-editing' : '') + '\" data-admin-price-card=\"' + escHtml(pid) + '\">';",
)

# Remove kind from lesson forms - lessons only
api = api.replace(
    "    '<div class=\"portal-admin-edit-field\"><label>' + escHtml(portalT('admin.edit.kind')) + '</label>' +\n    '<select id=\"admin-time-kind\">' + adminLessonKindOptions(fields.kind) + '</select></div>' +\n",
    "",
)
api = api.replace(
    "    '<div class=\"portal-admin-edit-field\"><label>' + escHtml(portalT('admin.edit.kind')) + '</label>' +\n    '<select id=\"admin-new-time-kind\">' + adminLessonKindOptions('lesson') + '</select></div>' +\n",
    "",
)

# Add pack UI helpers before adminRentalGroupOrder
PACK_HELPERS = r'''
function adminPackBeachOptions(){ return [
  { value: 'el_sardinero', label: portalT('admin.packs.beach.el_sardinero') },
  { value: 'liencres', label: portalT('admin.packs.beach.liencres') },
  { value: 'somo', label: portalT('admin.packs.beach.somo') },
];}
function adminPackGroupSizeOptions(){ return [8, 12, 16, 20, 24].map(function(n){
  return { value: String(n), label: portalT('admin.packs.groupExclusive').replace('{n}', String(n)) };
});}
function adminPackScheduleOptions(){ return [
  { value: '0930_1130', label: portalT('admin.packs.schedule.0930_1130') },
  { value: '1215_1415', label: portalT('admin.packs.schedule.1215_1415') },
];}
function adminPackWeeklyOptions(){ return adminLessonFrequencyOptions('mon_fri').replace(/mon_fri/,'mon_fri'); }
function adminRenderPillRow(group, options, selected, multi){
  var sel = multi ? (selected || []) : [selected];
  var html = '<div class="portal-admin-pill-group"><span class="portal-admin-pill-label">';
  if (group === 'beaches') html += escHtml(portalT('admin.packs.beaches'));
  else if (group === 'group_size') html += escHtml(portalT('admin.packs.groupSize'));
  else if (group === 'weekly') html += escHtml(portalT('admin.edit.frequency'));
  else if (group === 'schedules') html += escHtml(portalT('admin.packs.schedules'));
  else if (group === 'age_band') html += escHtml(portalT('admin.edit.age'));
  else html += escHtml(group);
  html += '</span><div class="portal-admin-pill-row" data-admin-pill-group="' + escHtml(group) + '" data-admin-pill-multi="' + (multi ? '1' : '0') + '">';
  options.forEach(function(o){
    var on = sel.indexOf(o.value) >= 0;
    html += '<button type="button" class="portal-admin-pill' + (on ? ' is-selected' : '') + '" data-admin-action="toggle-pill" data-admin-pill-group="' + escHtml(group) + '" data-admin-pill-value="' + escHtml(o.value) + '">' + escHtml(o.label) + '</button>';
  });
  return html + '</div></div>';
}
function adminCollectPillValues(group){
  var row = document.querySelector('[data-admin-pill-group="' + group + '"]');
  if (!row) return [];
  return Array.prototype.slice.call(row.querySelectorAll('.portal-admin-pill.is-selected')).map(function(b){ return b.getAttribute('data-admin-pill-value'); });
}
function adminCollectSinglePill(group, fallback){
  var vals = adminCollectPillValues(group);
  return vals.length ? vals[0] : fallback;
}
function adminPackAgeOptions(){
  return ['all_ages', '6_and_up', '6_to_11', '12_and_up'].map(function(a){
    return { value: a, label: portalT('admin.lesson.age.' + a) };
  });
}
function adminPackWeeklyPillOptions(){
  return ['daily', 'sat_sun', 'mon_fri'].map(function(f){
    return { value: f, label: portalT('admin.lesson.frequency.' + f) };
  });
}
function adminDefaultPackSeed(){
  var d = defaultPackConfig();
  return { label: portalT('admin.packs.defaultName'), age_band: d.age_band, group_size: d.group_size, beaches: d.beaches.slice(), weekly: d.weekly, schedules: d.schedules.slice(), price_tiers: d.price_tiers.map(function(t){ return Object.assign({}, t); }) };
}
function adminRenderPackTierFields(tiers, prefix){
  var html = '<div class="portal-admin-pill-group"><span class="portal-admin-pill-label">' + escHtml(portalT('admin.packs.priceTiers')) + '</span>';
  (tiers || []).forEach(function(t, idx){
    html += '<div class="portal-admin-pack-tier" data-pack-tier-idx="' + idx + '">' +
      '<label>' + escHtml(t.label || t.key) + '</label>' +
      '<input type="text" id="' + escHtml(prefix) + '-tier-amount-' + idx + '" value="' + escHtml(adminEurosFromAmount((t.amount_cents || 0) / 100 !== t.amount_cents / 100 ? t.amount_cents : t.amount_cents / 100)) + '" inputmode="decimal" placeholder="0.00">' +
      '<span class="portal-admin-muted">' + escHtml(portalT('admin.packs.perStudent')) + '</span></div>';
  });
  return html + '</div>';
}
function adminRenderPackTierReadout(tiers){
  var html = '<div class="portal-admin-pill-group"><span class="portal-admin-pill-label">' + escHtml(portalT('admin.packs.priceTiers')) + '</span>';
  (tiers || []).forEach(function(t){
    html += '<div class="portal-admin-pack-tier-row"><span>' + escHtml(t.label || t.key) + '</span><strong>' + escHtml(adminEurosFromAmount((t.amount_cents || 0) / 100) + ' EUR ' + portalT('admin.packs.perStudent')) + '</strong></div>';
  });
  return html + '</div>';
}
function adminRenderPackEditForm(pid, pack){
  var p = pack || adminDefaultPackSeed();
  var prefix = pid ? ('admin-pack-' + pid) : 'admin-new-pack';
  return '<div class="portal-admin-pack-card">' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
    '<input type="text" id="' + prefix + '-label" value="' + escHtml(p.label || '') + '" maxlength="120"></div>' +
    adminRenderPillRow('age_band', adminPackAgeOptions(), p.age_band || '12_and_up', false) +
    adminRenderPillRow('group_size', adminPackGroupSizeOptions(), String(p.group_size || 16), false) +
    adminRenderPillRow('beaches', adminPackBeachOptions(), p.beaches || [], true) +
    adminRenderPillRow('weekly', adminPackWeeklyPillOptions(), p.weekly || 'mon_fri', false) +
    adminRenderPillRow('schedules', adminPackScheduleOptions(), p.schedules || [], true) +
    adminRenderPackTierFields(p.price_tiers || DEFAULT_PRICE_TIERS, prefix) +
    '<div class="portal-admin-price-card-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="' + (pid ? 'save-pack' : 'save-new-pack') + '" data-pack-id="' + escHtml(pid || '') + '">' + escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}
function adminReadPackFormPayload(pid){
  var prefix = pid ? ('admin-pack-' + pid) : 'admin-new-pack';
  var labelEl = el(prefix + '-label');
  var tiers = (DEFAULT_PRICE_TIERS || []).map(function(t, idx){
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
}
'''
if 'function adminPackBeachOptions' not in api:
    api = api.replace('function adminRentalGroupOrder(){', PACK_HELPERS + '\nfunction adminRentalGroupOrder(){')

# Fix adminRenderPackTierFields amount - bug in amount conversion
api = api.replace(
    "escHtml(adminEurosFromAmount((t.amount_cents || 0) / 100 !== t.amount_cents / 100 ? t.amount_cents : t.amount_cents / 100))",
    "escHtml(adminEurosFromAmount((t.amount_cents != null ? t.amount_cents : 0) / 100))",
)
api = api.replace(
    "escHtml(adminEurosFromAmount((t.amount_cents || 0) / 100) + ' EUR ' + portalT('admin.packs.perStudent'))",
    "escHtml(adminEurosFromAmount((t.amount_cents != null ? t.amount_cents : 0) / 100) + ' EUR ' + portalT('admin.packs.perStudent'))",
)

# Replace renderAdminSectionLessonTimesFromConfig to split lessons/packs
LESSON_FN = re.search(r'function renderAdminSectionLessonTimesFromConfig\(cfg\)\{[\s\S]*?\n\}\n\nfunction renderAdminSectionBusinessInfoFromConfig', api)
if LESSON_FN:
    NEW_LESSON = r'''function adminIsLessonSlot(s){
  var fields = adminResolveLessonSlotFields(s);
  return fields.kind !== 'pack';
}
function renderAdminLessonCards(slots, cfg, writes, defaultCap){
  var html = '';
  var lessons = (slots || []).filter(adminIsLessonSlot);
  html += '<div class="portal-admin-subsection"><div class="portal-admin-subsection-title-row"><h3 class="portal-admin-subsection-title">' + escHtml(portalT('admin.lessonTimes.lessonsTitle')) + '</h3>';
  if (writes && !adminEditTarget){
    html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-time" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button></div>';
  }
  html += '</div><p class="portal-admin-muted">' + escHtml(portalT('admin.lessonTimes.lessonsHelp')) + '</p>';
  if (writes && adminEditTarget === 'time:new') html += renderAdminAddTimeForm();
  if (!lessons.length && adminEditTarget !== 'time:new'){
    html += '<p class="portal-admin-muted">' + escHtml(portalT('admin.lessonTimes.placeholder')) + '</p></div>';
    return html;
  }
  html += '<div class="portal-admin-compact-grid" id="admin-lesson-card-grid">';
  lessons.forEach(function(s){
    var sid = s.slot_id ? String(s.slot_id) : '';
    var editing = writes && adminEditTarget === ('time:' + sid);
    var label = adminHumanizeText(s.offering_label || 'Lesson');
    var fields = adminResolveLessonSlotFields(s);
    var capText = s.capacity != null ? String(s.capacity) : String(defaultCap);
    var duration = adminSlotDurationLabel(s.slot_time);
    var costText = fields.price_amount != null ? (adminEurosFromAmount(fields.price_amount) + ' ' + (s.price_currency || 'EUR')) : '—';
    html += '<article class="portal-admin-lesson-card" data-admin-lesson-card="' + escHtml(sid) + '">';
    html += '<div class="portal-admin-card-title-row"><div><div class="portal-admin-lesson-title">' + escHtml(label) + '</div>' +
      '<div class="portal-admin-lesson-meta">' + escHtml(adminLessonFrequencyLabel(fields.frequency)) + '</div></div>';
    if (writes && !editing && (!adminEditTarget || (adminEditTarget.indexOf('time:') !== 0 && adminEditTarget.indexOf('pack:') !== 0 && adminEditTarget !== 'pack:new'))){
      html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-time" data-time-id="' +
        escHtml(sid) + '" aria-label="' + escHtml(portalT('admin.action.edit')) + '">✎</button>' +
        '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-admin-action="delete-time" data-time-id="' +
        escHtml(sid) + '" aria-label="' + escHtml(portalT('admin.action.remove')) + '">×</button></div>';
    }
    html += '</div>';
    if (editing) html += renderAdminTimeEditForm(sid, s);
    else {
      html += '<div class="portal-admin-lesson-facts">' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.capacity')) + '<strong>' + escHtml(capText + ' ' + portalT('admin.lessonTimes.seats')) + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.duration')) + '<strong>' + escHtml(duration) + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.startTime')) + '<strong>' + escHtml(adminSlotTimeStart(s.slot_time) || '—') + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.age')) + '<strong>' + escHtml(adminLessonAgeLabel(fields.age_band)) + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.cost')) + '<strong>' + escHtml(costText) + '</strong></div></div>';
    }
    html += '</article>';
  });
  return html + '</div></div>';
}
function renderAdminPackCards(packs, writes){
  var html = '<div class="portal-admin-subsection"><div class="portal-admin-subsection-title-row"><h3 class="portal-admin-subsection-title">' + escHtml(portalT('admin.packs.title')) + '</h3>';
  if (writes && !adminEditTarget){
    html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-pack" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button></div>';
  }
  html += '</div><p class="portal-admin-muted">' + escHtml(portalT('admin.packs.help')) + '</p>';
  if (writes && adminEditTarget === 'pack:new') html += renderAdminPackEditForm('', adminDefaultPackSeed());
  var list = packs && packs.length ? packs : [];
  if (!list.length && adminEditTarget !== 'pack:new'){
    html += '<p class="portal-admin-muted">' + escHtml(portalT('admin.packs.placeholder')) + '</p></div>';
    return html;
  }
  html += '<div class="portal-admin-pack-grid" id="admin-pack-card-grid">';
  list.forEach(function(p){
    var pid = p.pack_id ? String(p.pack_id) : '';
    var editing = writes && adminEditTarget === ('pack:' + pid);
    html += '<article class="portal-admin-pack-card" data-admin-pack-card="' + escHtml(pid) + '">';
    html += '<div class="portal-admin-card-title-row"><div><div class="portal-admin-pack-title">' + escHtml(p.label || 'Pack') + '</div>' +
      '<div class="portal-admin-pack-sub">' + escHtml(adminLessonAgeLabel(p.age_band)) + ' · ' + escHtml(portalT('admin.packs.groupExclusive').replace('{n}', String(p.group_size || 16))) + '</div></div>';
    if (writes && !editing && (!adminEditTarget || adminEditTarget.indexOf('pack:') !== 0)){
      html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-pack" data-pack-id="' +
        escHtml(pid) + '">✎</button><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-admin-action="delete-pack" data-pack-id="' +
        escHtml(pid) + '">×</button></div>';
    }
    html += '</div>';
    if (editing) html += renderAdminPackEditForm(pid, p);
    else {
      html += adminRenderPillRow('beaches', adminPackBeachOptions(), p.beaches || [], true);
      html += adminRenderPillRow('weekly', adminPackWeeklyPillOptions(), p.weekly || 'mon_fri', false);
      html += adminRenderPillRow('schedules', adminPackScheduleOptions(), p.schedules || [], true);
      html += adminRenderPackTierReadout(p.price_tiers || []);
    }
    html += '</article>';
  });
  return html + '</div></div>';
}
function renderAdminSectionLessonTimesFromConfig(cfg){
  var box = el('admin-times-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var slots = (cfg && cfg.lesson_times) ? cfg.lesson_times : [];
  var packs = (cfg && cfg.surf_packs) ? cfg.surf_packs : [];
  var defaultCap = (cfg && cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap != null)
    ? cfg.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  box.innerHTML = renderAdminLessonCards(slots, cfg, writes, defaultCap) + renderAdminPackCards(packs, writes);
}

function renderAdminSectionBusinessInfoFromConfig'''
    api = api[:LESSON_FN.start()] + NEW_LESSON + api[LESSON_FN.end()-len('function renderAdminSectionBusinessInfoFromConfig'):]

# Update save-time to always use kind lesson
api = api.replace(
    "        kind: kindInput ? String(kindInput.value || 'lesson') : 'lesson',\n",
    "        kind: 'lesson',\n",
)

api = api.replace(
    "        kind: newKindInput ? String(newKindInput.value || 'lesson') : 'lesson',\n",
    "        kind: 'lesson',\n",
)

# wireAdminTab - add pack actions and toggle-pill
if "action === 'toggle-pill'" not in api:
    api = api.replace(
        "    if (action === 'edit-capacity' || action === 'edit-price-group'",
        "    if (action === 'toggle-pill'){\n      var pillGroup = btn.getAttribute('data-admin-pill-group');\n      var pillVal = btn.getAttribute('data-admin-pill-value');\n      var row = btn.closest('[data-admin-pill-group]');\n      var multi = row && row.getAttribute('data-admin-pill-multi') === '1';\n      if (!multi){\n        row.querySelectorAll('.portal-admin-pill').forEach(function(p){ p.classList.remove('is-selected'); });\n        btn.classList.add('is-selected');\n      } else {\n        btn.classList.toggle('is-selected');\n      }\n      return;\n    }\n    if (action === 'edit-capacity' || action === 'edit-price-group'",
    )

GATE_OLD = "action === 'save-time' || action === 'save-new-time'){"
GATE_NEW = "action === 'save-time' || action === 'save-new-time' || action === 'add-pack' || action === 'edit-pack' || action === 'delete-pack' || action === 'save-pack' || action === 'save-new-pack'){"
api = api.replace(GATE_OLD, GATE_NEW)

# Add pack handlers before closing of wireAdminTab click handler - before save-time or at end before `  });`
PACK_HANDLERS = '''
    if (action === 'add-pack'){
      adminEditTarget = 'pack:new';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'edit-pack'){
      adminEditTarget = 'pack:' + String(btn.getAttribute('data-pack-id') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'delete-pack'){
      var deletePackId = String(btn.getAttribute('data-pack-id') || '');
      if (!deletePackId || !window.confirm(portalT('admin.edit.confirmRemovePack'))) return;
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('DELETE', '/staff/admin/config/surf-packs/' + encodeURIComponent(deletePackId) + adminClientQuery(), {})
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedPack'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }
    if (action === 'save-pack' || action === 'save-new-pack'){
      var packId = action === 'save-pack' ? String(btn.getAttribute('data-pack-id') || '') : '';
      var payload = adminReadPackFormPayload(packId || null);
      if (!payload.label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      var req = packId
        ? adminApiRequest('PATCH', '/staff/admin/config/surf-packs/' + encodeURIComponent(packId) + adminClientQuery(), payload)
        : adminApiRequest('POST', '/staff/admin/config/surf-packs' + adminClientQuery(), payload);
      req.then(function(res){
        adminSaveBusy = false;
        if ((res.status !== 200 && res.status !== 201) || !res.data || res.data.success !== true){
          adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
          return;
        }
        adminShowMessage('success', packId ? portalT('admin.edit.savedPack') : portalT('admin.edit.addedPack'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
      return;
    }
'''
if "action === 'save-new-pack'" not in api.split('function wireAdminTab')[1].split('var customersCache')[0]:
    api = api.replace(
        "    if (action === 'save-new-time'){",
        PACK_HANDLERS + "\n    if (action === 'save-new-time'){",
    )

# Add API routes and handlers
if 'handleAdminConfigSurfPackPost' not in api:
    HANDLERS = '''
async function handleAdminConfigSurfPackPost(query, req, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  const gate = evaluateAdminWriteGate({ user, clientSlug, staffAuthRequired: STAFF_AUTH_REQUIRED, resolveStaffRole });
  if (!gate.ok) return sendAdminWriteGateFailure(res, gate);
  if (!assertStaffClientAccess(user, clientSlug, res)) return;
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid JSON body'); }
  try {
    const locationId = normalizeSunsetLocationId(query.location);
    const result = await withPgClient(async (pg) => createSurfPackRule(pg, {
      clientSlug, locationId, body, actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));
    return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'write failed' });
  }
}

async function handleAdminConfigSurfPackPatch(ruleIdRaw, query, req, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  const gate = evaluateAdminWriteGate({ user, clientSlug, staffAuthRequired: STAFF_AUTH_REQUIRED, resolveStaffRole });
  if (!gate.ok) return sendAdminWriteGateFailure(res, gate);
  if (!assertStaffClientAccess(user, clientSlug, res)) return;
  const idCheck = validateUuid(ruleIdRaw, 'surf pack rule id');
  if (!idCheck.ok) return send400(res, idCheck.error);
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send400(res, 'invalid JSON body'); }
  try {
    const locationId = normalizeSunsetLocationId(query.location);
    const result = await withPgClient(async (pg) => patchSurfPackRule(pg, {
      ruleId: idCheck.value, clientSlug, locationId, body, actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));
    return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'write failed' });
  }
}

async function handleAdminConfigSurfPackDelete(ruleIdRaw, query, req, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  const gate = evaluateAdminWriteGate({ user, clientSlug, staffAuthRequired: STAFF_AUTH_REQUIRED, resolveStaffRole });
  if (!gate.ok) return sendAdminWriteGateFailure(res, gate);
  if (!assertStaffClientAccess(user, clientSlug, res)) return;
  const idCheck = validateUuid(ruleIdRaw, 'surf pack rule id');
  if (!idCheck.ok) return send400(res, idCheck.error);
  try {
    const locationId = normalizeSunsetLocationId(query.location);
    const result = await withPgClient(async (pg) => deactivateSurfPackRule(pg, {
      ruleId: idCheck.value, clientSlug, locationId, actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));
    return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'write failed' });
  }
}
'''
    api = api.replace('async function handleAdminConfigLessonTimeDelete', HANDLERS + '\nasync function handleAdminConfigLessonTimeDelete')

    ROUTES = '''
  const adminSurfPackPostMatch = pathname.match(/^\\/staff\\/admin\\/config\\/surf-packs\\/?$/i);
  if (req.method === 'POST' && adminSurfPackPostMatch) {
    return handleAdminConfigSurfPackPost(parsed.query, req, res, auth.user);
  }
  const adminSurfPackPatchMatch = pathname.match(/^\\/staff\\/admin\\/config\\/surf-packs\\/([^/]+)\\/?$/i);
  if (req.method === 'PATCH' && adminSurfPackPatchMatch) {
    return handleAdminConfigSurfPackPatch(adminSurfPackPatchMatch[1], parsed.query, req, res, auth.user);
  }
  if (req.method === 'DELETE' && adminSurfPackPatchMatch) {
    return handleAdminConfigSurfPackDelete(adminSurfPackPatchMatch[1], parsed.query, req, res, auth.user);
  }
'''
    api = api.replace(
        '  const adminLessonTimePostMatch = pathname.match(/^\\/staff\\/admin\\/config\\/lesson-times\\/?$/i);',
        ROUTES + '\n  const adminLessonTimePostMatch = pathname.match(/^\\/staff\\/admin\\/config\\/lesson-times\\/?$/i);',
    )

# Update rental help text
api = api.replace(
    "portalT('admin.prices.help')",
    "portalT('admin.prices.help')",
)

(ROOT / 'scripts/staff-query-api.js').write_text(api, encoding='utf-8')
print('OK staff-query-api.js')
print('DONE')
