'use strict';
const fs = require('fs');
const path = 'G:/Luna/Sunset/scripts/staff-query-api.js';
let s = fs.readFileSync(path, 'utf8');

function must(cond, msg) { if (!cond) throw new Error(msg); }

// fix6 base patches
const parseOld = "function adminParseTimeHm(text){\n  var t = String(text || '').trim();\n  if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(t)) return { ok: false, error: portalT('admin.edit.timeInvalid') };\n  return { ok: true, value: t };\n}";
const parseNew = "var ADMIN_TIME_HM_RE = new RegExp('^([01][0-9]|2[0-3]):[0-5][0-9]$');\nfunction adminParseTimeHm(text){\n  var t = String(text || '').trim();\n  if (!ADMIN_TIME_HM_RE.test(t)) return { ok: false, error: portalT('admin.edit.timeInvalid') };\n  return { ok: true, value: t };\n}\n\nfunction adminMinutesFromHm(hm){\n  var parts = String(hm || '').split(':');\n  if (parts.length !== 2) return NaN;\n  var h = parseInt(parts[0], 10);\n  var m = parseInt(parts[1], 10);\n  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;\n  return h * 60 + m;\n}";
must(s.includes(parseOld), 'parseOld missing');
s = s.replace(parseOld, () => parseNew);

s = s.replace(
  /function adminRenderPackScheduleFields\(p, prefix\)\{[\s\S]*?function adminReadPackSchedules\(prefix\)\{[\s\S]*?return \{ ok: true, value: key \? \[key\] : \[\] \};\n\}/,
  () => `function adminRenderPackScheduleBlock(prefix, sched, idx){
  var times = adminTimesFromScheduleKey(sched || '0930_1130');
  return '<div class="portal-admin-pack-schedule-block" data-pack-schedule-idx="' + idx + '">' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.startTime')) + '</label>' +
    '<input type="text" data-schedule-field="start" id="' + prefix + '-schedule-start-' + idx + '" value="' + escHtml(times.start) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.endTime')) + '</label>' +
    '<input type="text" data-schedule-field="end" id="' + prefix + '-schedule-end-' + idx + '" value="' + escHtml(times.end) + '" placeholder="HH:MM" maxlength="5"></div></div>';
}
function adminRenderPackScheduleFields(p, prefix){
  var schedules = (p && p.schedules && p.schedules.length) ? p.schedules.slice(0, 2) : ['0930_1130'];
  var html = '<div class="portal-admin-pack-schedules" data-admin-pack-schedules="' + escHtml(prefix) + '">';
  schedules.forEach(function(sched, idx){ html += adminRenderPackScheduleBlock(prefix, sched, idx); });
  html += '</div>';
  if (schedules.length < 2){
    html += '<div class="portal-admin-pack-schedule-add"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-pack-schedule" data-pack-prefix="' + escHtml(prefix) + '">+</button>' +
      '<span class="portal-admin-muted">' + escHtml(portalT('admin.packs.addScheduleWindow')) + '</span></div>';
  }
  return html;
}
function adminReadPackSchedules(prefix, root){
  var scope = root || document;
  var container = scope.querySelector('[data-admin-pack-schedules="' + prefix + '"]');
  var blocks = container ? Array.prototype.slice.call(container.querySelectorAll('[data-pack-schedule-idx]')) : [];
  var keys = [];
  var validationError = '';
  blocks.forEach(function(block){
    var startInput = block.querySelector('[data-schedule-field="start"]');
    var endInput = block.querySelector('[data-schedule-field="end"]');
    var startRaw = startInput ? String(startInput.value || '').trim() : '';
    var endRaw = endInput ? String(endInput.value || '').trim() : '';
    if (!startRaw && !endRaw) return;
    if (!startRaw || !endRaw){ validationError = portalT('admin.edit.timeInvalid'); return; }
    var startParsed = adminParseTimeHm(startRaw);
    if (!startParsed.ok){ validationError = startParsed.error; return; }
    var endParsed = adminParseTimeHm(endRaw);
    if (!endParsed.ok){ validationError = endParsed.error; return; }
    var startMin = adminMinutesFromHm(startParsed.value);
    var endMin = adminMinutesFromHm(endParsed.value);
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin){
      validationError = portalT('admin.edit.endAfterStart'); return;
    }
    var key = adminScheduleKeyFromTimes(startParsed.value, endParsed.value);
    if (key && keys.indexOf(key) < 0) keys.push(key);
  });
  if (validationError) return { ok: false, error: validationError };
  if (!keys.length) return { ok: false, error: portalT('admin.edit.timeInvalid') };
  return { ok: true, value: keys };
}`
);

// remove duplicate old schedule readout if any left
s = s.replace(
  /function adminRenderPackScheduleReadout\(schedules\)\{\n  var key = \(schedules && schedules\[0\]\)[\s\S]*?'<\/div>';\n\}/,
  () => `function adminRenderPackScheduleReadout(schedules){
  var labels = (schedules || []).map(function(key){
    var times = adminTimesFromScheduleKey(key);
    return (times.start && times.end) ? (times.start + ' – ' + times.end) : '';
  }).filter(function(x){ return !!x; });
  var label = labels.length ? labels.join('; ') : '—';
  return '<div class="portal-admin-pack-schedule-readout"><span class="portal-admin-muted">' + escHtml(portalT('admin.packs.schedules')) + '</span> <strong>' + escHtml(label) + '</strong></div>';
}`
);

must(s.includes('adminReadPackSchedules(prefix, root)'), 'schedules call missing');
s = s.replace('var schedulesParsed = adminReadPackSchedules(prefix);', 'var schedulesParsed = adminReadPackSchedules(prefix, root);');
s = s.replace(/renderAdminPackEditForm/g, 'adminRenderPackEditForm');

// optional euros for lessons
must(s.includes('function adminParseEurosToCents(text)'), 'euros parser missing');
s = s.replace(
  /function adminParseEurosToCents\(text\)\{[\s\S]*?return \{ ok: true, value: Math\.round\(n \* 100\) \};\n\}/,
  () => `function adminParseEurosToCents(text){
  var normalized = String(text || '').trim().replace(',', '.');
  if (!normalized) return { ok: false, error: portalT('admin.edit.amountRequired') };
  var n = Number(normalized);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: portalT('admin.edit.amountInvalid') };
  return { ok: true, value: Math.round(n * 100) };
}

function adminParseEurosToCentsOptional(text){
  var normalized = String(text || '').trim().replace(',', '.');
  if (!normalized) return { ok: true, value: 0 };
  return adminParseEurosToCents(normalized);
}`
);

// pill readout + CSS
s = s.replace(
  '.portal-admin-pill{border:1px solid var(--border-soft);background:var(--surface);color:var(--text-2);border-radius:999px;padding:3px 9px;font-size:11px;font-weight:650;line-height:1.3;cursor:pointer}',
  '.portal-admin-pill{border:1px solid var(--border-soft);background:var(--surface);color:var(--text-2);border-radius:999px;padding:3px 9px;font-size:11px;font-weight:650;line-height:1.3;cursor:pointer}\n.portal-admin-pill.portal-admin-pill-static{cursor:default;pointer-events:none}\n.portal-admin-pack-schedule-block{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px}\n.portal-admin-pack-schedule-add{display:flex;align-items:center;gap:6px;margin:4px 0 10px}'
);

s = s.replace(
  '  return html + \'</div></div>\';\n}\nfunction adminPackFormRoot(pid){',
  () => `  return html + '</div></div>';
}
function adminRenderPillReadout(group, options, selected, multi){
  var sel = multi ? (selected || []) : [selected];
  var html = '<div class="portal-admin-pill-group"><span class="portal-admin-pill-label">';
  if (group === 'beaches') html += escHtml(portalT('admin.packs.beaches'));
  else if (group === 'group_size') html += escHtml(portalT('admin.packs.groupSize'));
  else if (group === 'weekly') html += escHtml(portalT('admin.edit.frequency'));
  else if (group === 'age_band') html += escHtml(portalT('admin.edit.age'));
  else html += escHtml(group);
  html += '</span><div class="portal-admin-pill-row portal-admin-pill-row-readout">';
  options.forEach(function(o){
    if (sel.indexOf(o.value) < 0) return;
    html += '<span class="portal-admin-pill is-selected portal-admin-pill-static">' + escHtml(o.label) + '</span>';
  });
  return html + '</div></div>';
}
function adminPackFormRoot(pid){`
);

// pack view mode readout pills
s = s.replace(
  "      html += adminRenderPillRow('beaches', adminPackBeachOptions(), p.beaches || [], true);\n      html += adminRenderPillRow('weekly', adminPackWeeklyPillOptions(), p.weekly || 'mon_fri', false);",
  "      html += adminRenderPillReadout('beaches', adminPackBeachOptions(), p.beaches || [], true);\n      html += adminRenderPillReadout('weekly', adminPackWeeklyPillOptions(), p.weekly || 'mon_fri', false);"
);

// period sort
s = s.replace(
  'function adminPeriodLabel(period){',
  () => `function adminPeriodSortKey(period){
  var order = ['1_hour', '2_hours', 'half_day', '1_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days'];
  var idx = order.indexOf(String(period || '').trim());
  return idx >= 0 ? idx : 999;
}

function adminPeriodLabel(period){`
);

s = s.replace(
  '    var items = groups[key] || [];\n    var groupEditing = writes && adminEditTarget === (\'price-group:\' + key);',
  () => `    var items = (groups[key] || []).slice().sort(function(a, b){
      return adminPeriodSortKey(adminParsePriceRow(a).periodWindow) - adminPeriodSortKey(adminParsePriceRow(b).periodWindow);
    });
    var groupEditing = writes && adminEditTarget === ('price-group:' + key);`
);

// lesson save fixes
s = s.replace(
  '      var timeParsed = adminParseTimeHm(startInput && startInput.value);',
  '      var timeParsed = adminParseTimeHm(startInput ? startInput.value : \'\');'
);
s = s.replace(
  '      var capacityParsed = adminParseCapacity(capInput && capInput.value);',
  '      var capacityParsed = adminParseCapacity(capInput ? capInput.value : \'\');'
);
s = s.replace(
  '      var costParsed = adminParseEurosToCents(costInput && costInput.value);',
  '      var costParsed = adminParseEurosToCentsOptional(costInput ? costInput.value : \'\');'
);
s = s.replace(
  '      var newStart = adminParseTimeHm(newStartInput && newStartInput.value);',
  '      var newStart = adminParseTimeHm(newStartInput ? newStartInput.value : \'\');'
);
s = s.replace(
  '      var newCapParsed = adminParseCapacity(newCapInput && newCapInput.value);',
  '      var newCapParsed = adminParseCapacity(newCapInput ? newCapInput.value : \'\');'
);
s = s.replace(
  '      var newCostParsed = adminParseEurosToCents(newCostInput && newCostInput.value);',
  '      var newCostParsed = adminParseEurosToCentsOptional(newCostInput ? newCostInput.value : \'\');'
);

// add-pack-schedule handler
s = s.replace(
  "    if (action === 'toggle-pill'){",
  () => `    if (action === 'add-pack-schedule'){
      var packPrefix = String(btn.getAttribute('data-pack-prefix') || '');
      var schedBox = document.querySelector('[data-admin-pack-schedules="' + packPrefix + '"]');
      if (schedBox && schedBox.querySelectorAll('[data-pack-schedule-idx]').length < 2){
        var nextIdx = schedBox.querySelectorAll('[data-pack-schedule-idx]').length;
        schedBox.insertAdjacentHTML('beforeend', adminRenderPackScheduleBlock(packPrefix, '1215_1415', nextIdx));
        var addRow = schedBox.parentElement ? schedBox.parentElement.querySelector('.portal-admin-pack-schedule-add') : null;
        if (addRow) addRow.style.display = 'none';
      }
      return;
    }
    if (action === 'toggle-pill'){`
);

// i18n key fallback - inject minimal if missing in portal strings (use existing packs.help pattern - skip, portalT returns key)

must(s.includes('adminParseEurosToCentsOptional'), 'optional euros missing');
must(s.includes('adminRenderPillReadout'), 'pill readout missing');
must(s.includes('adminPeriodSortKey'), 'period sort missing');
must(s.includes('add-pack-schedule'), 'add schedule handler missing');
must(!s.includes('renderAdminPackEditForm'), 'pack form rename failed');
must(s.split('\n').length < 41000, 'file bloated: ' + s.split('\n').length);

fs.writeFileSync(path, s, 'utf8');
console.log('v2 patched ok lines', s.split('\n').length);
